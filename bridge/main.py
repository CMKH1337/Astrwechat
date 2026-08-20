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
        state.running = True
    state.paused.clear()
    state.sender_instance = create_sender()

    if not state.ob_client_started:
        t = threading.Thread(target=_run_ob_client, daemon=True, name="ob11-client")
        t.start()
        state.ob_client_started = True

    state.bridge_thread = threading.Thread(target=_bridge_loop, daemon=True, name="bridge")
    state.bridge_thread.start()
    emit_status()


def _stop_bridge():
    with state.run_lock:
        state.running = False

    with state.bridge_lock:
        if state.bridge_instance and state.bridge_instance._sse_session:
            try:
                state.bridge_instance._sse_session.close()
            except Exception:
                pass

    _ws = state._ob_ws
    _loop = state._ob_ws_loop
    if _ws and _loop and _loop.is_running():
        import asyncio
        asyncio.run_coroutine_threadsafe(_ws.close(), _loop)

    state.set_ob_connected(False)
    state.ob_client_started = False
    state._ob_ws_loop = None
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
    cfg.ACTIVE_REPLY_METHOD = str(new_cfg.get("active_reply_method", cfg.ACTIVE_REPLY_METHOD) or cfg.ACTIVE_REPLY_METHOD)
    try:
        cfg.ACTIVE_REPLY_PROBABILITY = min(1.0, max(0.0, float(new_cfg.get("active_reply_probability", cfg.ACTIVE_REPLY_PROBABILITY))))
    except (TypeError, ValueError):
        pass
    try:
        cfg.ACTIVE_REPLY_CONTEXT_COUNT = min(50, max(0, int(new_cfg.get("active_reply_context_count", cfg.ACTIVE_REPLY_CONTEXT_COUNT))))
    except (TypeError, ValueError):
        pass
    cfg.ACTIVE_REPLY_WHITELIST = [
        str(item).strip().casefold()
        for item in (new_cfg.get("active_reply_whitelist", cfg.ACTIVE_REPLY_WHITELIST) or [])
        if str(item).strip()
    ]
    cfg.ASTRBOT_OB_URL = new_cfg.get("astrbot_ob_url", cfg.ASTRBOT_OB_URL)
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
