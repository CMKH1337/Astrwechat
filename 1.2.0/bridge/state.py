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
from typing import Optional

# ============ 状态控制 ============

running = False
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


def set_ob_connected(connected: bool):
    """更新 AstrBot 连接状态，并仅在状态真正变化时主动上报。"""
    previous = _ob_ws_ready.is_set()
    if connected:
        _ob_ws_ready.set()
    else:
        _ob_ws_ready.clear()
    if previous != connected:
        notify_status()


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
ob_client_started = False
ob_client_thread = None
ob_client_generation = 0

# 群聊回复模式（运行时可变，启动时从 config 初始化）
group_reply_mode = "mention"

