"""
微信 ↔ AstrBot 桥接（OneBot v11 版）
=====================================
消息接收：WeFlow SSE 推送
AI 服务：AstrBot 通过 aiocqhttp (OneBot v11) 接入
消息发送：bridge 接收 AstrBot 的 API 调用 → WeFlow API / UIA

架构：
  WeFlow ──SSE──→ bridge.py ──WS 客户端──→ AstrBot (aiocqhttp 服务端)
                   ↑ 连接 ws://127.0.0.1:19777  ↑ 监听端口，等待客户端连入
                   发送 OneBot 事件             返回 API 响应
"""

# 共享状态：所有模块通过 import state 访问这些变量
import hashlib
import threading
import unicodedata
import time
import uuid
from typing import Optional

# ============ 状态控制 ============

running = False
reply_generation = 0
paused = threading.Event()
paused.clear()
run_lock = threading.Lock()
bridge_thread = None

# ============ OneBot WebSocket 客户端管理 ============

_ob_ws = None          # WebSocket 连接实例
_ob_ws_loop = None     # 事件循环
_ob_ws_ready = threading.Event()
_self_id_int = 0       # 启动时从 config 初始化
_status_callback = None
_status_callback_lock = threading.Lock()


def set_status_callback(callback):
    """注册状态变化回调，由 main.py 安全地向 Electron 输出 JSON。"""
    global _status_callback
    with _status_callback_lock:
        _status_callback = callback


def notify_status():
    """通知 Electron 刷新状态；回调异常不能影响连接线程。"""
    with _status_callback_lock:
        callback = _status_callback
    if callback:
        try:
            callback()
        except Exception:
            pass


ob_state = "disconnected"
ob_error = ""


def set_ob_connection(status: str, error: str = ""):
    global ob_state, ob_error
    changed = ob_state != status or ob_error != error
    ob_state, ob_error = status, error
    if status == "connected":
        _ob_ws_ready.set()
    else:
        _ob_ws_ready.clear()
    if changed:
        notify_status()


def set_ob_connected(connected: bool):
    set_ob_connection("connected" if connected else "disconnected")


def _wxid_to_int(wxid: str) -> int:
    """Map a stable identity to a deterministic OneBot numeric ID.

    Python's built-in hash is randomized per process, so it must not be used for
    IDs that AstrBot stores as administrator UIDs.
    """
    identity = unicodedata.normalize("NFKC", str(wxid or "").strip()).casefold()
    if not identity:
        return 1

    # Keep the result in the signed 31-bit range commonly used by OneBot clients.
    digest = hashlib.blake2s(identity.encode("utf-8"), digest_size=8).digest()
    return (int.from_bytes(digest, "big") % (2**31 - 1)) + 1


def _group_to_int(group_id: str) -> int:
    """Map a group session to a stable ID in a separate namespace."""
    return _wxid_to_int(f"group:{group_id}")


# ============ 桥接实例 / 发送器 ============

bridge_instance = None
bridge_lock = threading.Lock()
sender_instance = None
_ob_id_to_contact: dict[int, str] = {}  # OneBot user_id/group_id → 微信联系名
_ob_group_id_to_session_id: dict[int, str] = {}  # group_id → @chatroom 会话 ID
_ob_private_id_to_session_id: dict[int, str] = {}  # user_id → 私聊微信 ID
ob_client_started = False
ob_client_thread = None
ob_client_generation = 0

# 群聊回复模式（运行时可变，启动时从 config 初始化）
group_reply_mode = "mention"

voice_audio_request_handler = None
voice_audio_start_handler = None
voice_audio_cancel_handler = None
_voice_audio_lock = threading.Lock()
_voice_audio_waiters: dict[str, dict] = {}


def prepare_voice_audio(path: str, output_device_id: str, timeout: float = 20.0) -> tuple[str | None, str, str]:
    handler = voice_audio_request_handler
    if not callable(handler):
        return None, "应用语音播放通道尚未就绪", ""
    request_id = uuid.uuid4().hex
    waiter = {"ready": threading.Event(), "complete": threading.Event(), "success": False, "error": ""}
    with _voice_audio_lock:
        _voice_audio_waiters[request_id] = waiter
    try:
        handler({"request_id": request_id, "path": path, "output_device_id": output_device_id})
        if not waiter["ready"].wait(timeout):
            if callable(voice_audio_cancel_handler):
                voice_audio_cancel_handler(request_id)
            return None, "准备语音播放超时", ""
        if not waiter["success"]:
            return None, waiter["error"] or "语音播放设备或文件不可用", waiter.get("code", "")
        return request_id, "", ""
    finally:
        if not waiter["success"]:
            with _voice_audio_lock:
                _voice_audio_waiters.pop(request_id, None)


def start_voice_audio(request_id: str) -> bool:
    if request_id not in _voice_audio_waiters or not callable(voice_audio_start_handler):
        return False
    voice_audio_start_handler(request_id)
    return True


def wait_voice_audio(request_id: str, timeout: float = 75.0, can_continue=None) -> tuple[bool, str]:
    waiter = _voice_audio_waiters.get(request_id)
    if not waiter:
        return False, "语音播放请求已失效"
    try:
        deadline = time.monotonic() + timeout
        while not waiter["complete"].wait(0.1):
            if can_continue is not None and not can_continue():
                if callable(voice_audio_cancel_handler):
                    voice_audio_cancel_handler(request_id)
                return False, "微信失去前台焦点或会话权限发生变化"
            if time.monotonic() >= deadline:
                if callable(voice_audio_cancel_handler):
                    voice_audio_cancel_handler(request_id)
                return False, "等待语音播放超时"
        return bool(waiter["success"]), str(waiter["error"] or "")
    finally:
        with _voice_audio_lock:
            _voice_audio_waiters.pop(request_id, None)


def cancel_voice_audio(request_id: str):
    if callable(voice_audio_cancel_handler):
        try:
            voice_audio_cancel_handler(request_id)
        except Exception:
            pass
    with _voice_audio_lock:
        _voice_audio_waiters.pop(request_id, None)


def complete_voice_audio(request_id: str, phase: str, success: bool, error: str = "", code: str = "") -> bool:
    with _voice_audio_lock:
        waiter = _voice_audio_waiters.get(request_id)
        if not waiter:
            return False
        waiter["success"] = bool(success)
        waiter["error"] = str(error or "")[:300]
        waiter["code"] = str(code or "")[:64]
        if phase == "ready":
            waiter["ready"].set()
        elif phase == "complete":
            waiter["complete"].set()
        else:
            return False
        return True

