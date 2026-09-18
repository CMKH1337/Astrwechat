"""
Bridge 主入口：由 Electron 主进程通过 child_process 启动。

通信协议：
  - Electron → bridge：通过 stdin 发送 JSON 命令行（每行一条）
  - bridge → Electron：通过 stdout 发送 JSON 状态行（每行一条）

命令格式：{"cmd": "start"|"stop"|"pause"|"resume"|"status"|"update_config", "config"?: {...}}
状态格式：{"type": "status"|"log"|"error", "data": {...}|"string"}
"""

import json
import logging
import os
import sys
import threading
import time

import requests

import state
import config as cfg
from senders import create_sender
from ob_client import _run_ob_client
from bridge_core import WeFlowBridge

# Keep the OneBot identity lock in the entrypoint itself. The Bridge is shipped
# as a collection of standalone Python files, so startup must not depend on an
# optional sibling module being copied by an older installer.
_lock_file = None


def acquire_instance_lock(identity: str) -> bool:
    """Return False when another Bridge owns the same OneBot identity."""
    global _lock_file
    if _lock_file is not None:
        return True

    import hashlib
    import tempfile
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:20]
    path = os.path.join(tempfile.gettempdir(), f"astrwechat-ob11-{digest}.lock")
    handle = open(path, "a+b")
    try:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)

        if os.name == "nt":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (OSError, IOError):
        handle.close()
        return False

    _lock_file = handle
    return True


def release_instance_lock() -> None:
    """Release the process lock; safe to call more than once."""
    global _lock_file
    handle = _lock_file
    _lock_file = None
    if handle is None:
        return

    try:
        handle.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    except (OSError, IOError):
        pass
    finally:
        handle.close()

# Electron 通过管道读取 stdout；Windows 默认 GBK 会使中文和 emoji 写出失败。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")

# ============ 输出到 Electron ============

_stdout_lock = threading.Lock()

def emit(type_: str, data):
    with _stdout_lock:
        print(json.dumps({"type": type_, "data": data}, ensure_ascii=False), flush=True)

def emit_log(msg: str, level: str = "info"):
    emit("log", {"level": level, "msg": msg})

def emit_status():
    emit("status", {
        "running": state.running,
        "paused": not state.paused.is_set() and state.running,
        "ob_connected": state._ob_ws_ready.is_set(),
        "weflow_url": cfg.WE_FLOW_BASE_URL,
        "ob_url": cfg.ASTRBOT_OB_URL,
    })

# AstrBot WebSocket 在线/离线变化发生在 ob11-client 后台线程；
# 通过 emit() 内部的 stdout 锁安全地实时推送给 Electron。
state.set_status_callback(emit_status)

# ============ 日志重定向到 stdout ============

class _ElectronLogHandler(logging.Handler):
    def emit(self, record):
        level = record.levelname.lower()
        emit_log(self.format(record), level)

_handler = _ElectronLogHandler()
_handler.setFormatter(logging.Formatter("%(message)s"))
logging.getLogger().addHandler(_handler)
logging.getLogger().setLevel(logging.INFO)
# 禁用默认 StreamHandler（避免重复输出到 stderr）
for h in logging.getLogger().handlers[:]:
    if isinstance(h, logging.StreamHandler) and h.stream in (sys.stdout, sys.stderr):
        if not isinstance(h, _ElectronLogHandler):
            logging.getLogger().removeHandler(h)

log = logging.getLogger("bridge")

# ============ 启动 / 停止 ============

def _start_bridge():
    with state.run_lock:
        if state.running:
            emit_log("Bridge 已在运行中", "warn")
            return

        # A fast stop/start used to let the previous OB11 thread observe
        # running=True again and reconnect beside the new thread. aiocqhttp then
        # lost the API route for this self_id and raised ApiNotAvailable.
        previous_bridge = state.bridge_thread
        if previous_bridge and previous_bridge.is_alive():
            previous_bridge.join(timeout=3)
            if previous_bridge.is_alive():
                emit_log("上一条消息监听仍在退出，请稍后重试", "error")
                return

        previous_client = state.ob_client_thread
        if previous_client and previous_client.is_alive():
            previous_client.join(timeout=3)
            if previous_client.is_alive():
                emit_log("上一条 AstrBot 连接仍在退出，请稍后重试", "error")
                return

        lock_identity = f"{cfg.ASTRBOT_OB_URL}|{state._self_id_int}"
        if not acquire_instance_lock(lock_identity):
            emit_log("另一个 AstrWeChat Bridge 正在使用同一 AstrBot 身份", "error")
            return

        state.running = True
        state.ob_client_generation += 1
        generation = state.ob_client_generation

    state.paused.clear()
    state.sender_instance = create_sender()

    t = threading.Thread(
        target=_run_ob_client,
        args=(generation,),
        daemon=True,
        name=f"ob11-client-{generation}",
    )
    state.ob_client_thread = t
    state.ob_client_started = True
    t.start()

    state.bridge_thread = threading.Thread(target=_bridge_loop, daemon=True, name="bridge")
    state.bridge_thread.start()
    emit_status()


def _stop_bridge():
    with state.run_lock:
        state.running = False
        # Invalidate the running client before closing its socket. Even if a
        # restart happens quickly, the old thread can no longer reconnect.
        state.ob_client_generation += 1

    with state.bridge_lock:
        if state.bridge_instance and state.bridge_instance._sse_session:
            try:
                state.bridge_instance._sse_session.close()
            except Exception:
                pass

    ws = state._ob_ws
    loop = state._ob_ws_loop
    if ws and loop and loop.is_running():
        import asyncio
        try:
            close_future = asyncio.run_coroutine_threadsafe(ws.close(), loop)
            close_future.result(timeout=2)
        except Exception as e:
            emit_log(f"关闭 AstrBot 连接时出现异常: {e}", "warn")

    client_thread = state.ob_client_thread
    if (
        client_thread
        and client_thread is not threading.current_thread()
        and client_thread.is_alive()
    ):
        client_thread.join(timeout=3)

    if not client_thread or not client_thread.is_alive():
        state.ob_client_thread = None
        state.ob_client_started = False
    else:
        # Keep the flag truthful so _start_bridge refuses to create a duplicate.
        state.ob_client_started = True
        emit_log("AstrBot 连接线程仍在退出中", "warn")

    bridge_thread = state.bridge_thread
    if (
        bridge_thread
        and bridge_thread is not threading.current_thread()
        and bridge_thread.is_alive()
    ):
        bridge_thread.join(timeout=3)
    if not bridge_thread or not bridge_thread.is_alive():
        state.bridge_thread = None
    else:
        emit_log("消息监听线程仍在退出中", "warn")

    state.set_ob_connected(False)
    release_instance_lock()
    emit_status()


def _bridge_loop():
    import ctypes
    try:
        ctypes.windll.ole32.CoInitialize(None)
    except Exception:
        pass

    if not cfg.ACCESS_TOKEN:
        emit_log("未配置 access_token，bridge 无法启动", "error")
        state.running = False
        emit_status()
        return

    emit_log(f"Bridge 启动 | WeFlow: {cfg.WE_FLOW_BASE_URL} | OB11: {cfg.ASTRBOT_OB_URL}")

    bridge = WeFlowBridge(state.sender_instance)
    with state.bridge_lock:
        state.bridge_instance = bridge

    try:
        r = requests.get(
            f"{cfg.WE_FLOW_BASE_URL}/api/v1/messages?limit=1&access_token={cfg.ACCESS_TOKEN}",
            timeout=5
        )
        if r.status_code == 200:
            emit_log("WeFlow API 连接正常")
        elif r.status_code == 401:
            emit_log("Access Token 无效，请检查配置", "error")
            state.running = False
            emit_status()
            return
    except requests.exceptions.ConnectionError:
        emit_log("无法连接 WeFlow，请确认 WeFlow 已启动并开启 API", "error")
        state.running = False
        emit_status()
        return

    emit_status()

    while state.running:
        try:
            bridge.listen_sse()
        except Exception as e:
            emit_log(f"SSE 异常: {e}", "error")
        if not state.running:
            break
        emit_log("SSE 断开，10 秒后重连", "warn")
        for _ in range(10):
            if not state.running:
                break
            time.sleep(1)

    emit_status()
    if state.bridge_thread is threading.current_thread():
        state.bridge_thread = None


# ============ 配置热更新 ============

def _apply_config(new_cfg: dict):
    """将新配置写入 config.json 并重新加载运行时变量。"""
    config_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
    with open(config_file, "w", encoding="utf-8") as f:
        json.dump(new_cfg, f, ensure_ascii=False, indent=4)

    # 重新加载配置模块的全局变量
    cfg.WE_FLOW_BASE_URL = new_cfg.get("weflow_base_url", cfg.WE_FLOW_BASE_URL)
    cfg.ACCESS_TOKEN = new_cfg.get("access_token", cfg.ACCESS_TOKEN)
    cfg.BOT_NICKNAMES = new_cfg.get("bot_nicknames", cfg.BOT_NICKNAMES)
    cfg.BOT_WXID = new_cfg.get("bot_wxid", cfg.BOT_WXID)
    cfg.BUFFER_SECONDS = new_cfg.get("buffer_seconds", cfg.BUFFER_SECONDS)
    cfg.GROUP_REPLY_MODE = new_cfg.get("group_reply_mode", cfg.GROUP_REPLY_MODE)
    state.group_reply_mode = cfg.GROUP_REPLY_MODE
    cfg.ACTIVE_REPLY_ENABLED = bool(new_cfg.get("active_reply_enabled", cfg.ACTIVE_REPLY_ENABLED))
    try:
        cfg.ACTIVE_REPLY_PROBABILITY = min(1.0, max(0.0, float(new_cfg.get("active_reply_probability", cfg.ACTIVE_REPLY_PROBABILITY))))
    except (TypeError, ValueError):
        pass
    cfg.ACTIVE_REPLY_WHITELIST = [
        str(item).strip().casefold()
        for item in (new_cfg.get("active_reply_whitelist", cfg.ACTIVE_REPLY_WHITELIST) or [])
        if str(item).strip()
    ]
    cfg.ASTRBOT_OB_URL = new_cfg.get("astrbot_ob_url", cfg.ASTRBOT_OB_URL)
    cfg.ASTRBOT_OB_TOKEN = str(new_cfg.get("astrbot_ob_token", cfg.ASTRBOT_OB_TOKEN) or "").strip()
    emit_log("配置已更新")


# ============ stdin 命令循环 ============

def _stdin_loop():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError:
            continue

        action = cmd.get("cmd", "")
        if action == "start":
            _start_bridge()
        elif action == "stop":
            _stop_bridge()
        elif action == "pause":
            state.paused.clear()
            emit_log("已暂停")
            emit_status()
        elif action == "resume":
            state.paused.set()
            emit_log("已恢复")
            emit_status()
        elif action == "status":
            emit_status()
        elif action == "update_config":
            new_cfg = cmd.get("config", {})
            if new_cfg:
                _apply_config(new_cfg)
        elif action == "exit":
            _stop_bridge()
            sys.exit(0)


if __name__ == "__main__":
    # 初始化 self_id
    state._self_id_int = state._wxid_to_int(cfg.BOT_WXID) if cfg.BOT_WXID else 10000

    emit_log("Bridge 进程已就绪，等待命令")
    emit_status()

    # stdin 命令循环（阻塞主线程）
    try:
        _stdin_loop()
    except (EOFError, KeyboardInterrupt):
        _stop_bridge()
