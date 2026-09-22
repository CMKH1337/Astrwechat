"""
配置模块：加载 config.json，提供全局配置常量。
"""

import json
import os
import logging
import threading
from connection_config import resolve_connection

# ============ 配置 ============

# Electron supplies the writable per-user config; standalone launches keep the legacy default.
CONFIG_FILE = os.path.abspath(os.environ.get("WEFLOW_BRIDGE_CONFIG") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json"))
RUNTIME_DIR = os.path.dirname(CONFIG_FILE)


def load_config():
    with open(CONFIG_FILE, "r", encoding="utf-8-sig") as f:
        return json.load(f)


def _normalize_group_filter_mode(value) -> str:
    if value in ("whitelist", "blacklist"):
        return value
    return "blacklist"


def _normalize_group_filter_sessions(value) -> list[str]:
    return [
        str(item).strip().casefold()
        for item in (value or [])
        if str(item).strip()
    ]


def _group_filter_from_config(raw_config) -> tuple[str, list[str]]:
    """Load the new session filter fields, migrating the old active-reply list."""
    if "group_reply_filter_mode" in raw_config:
        mode = _normalize_group_filter_mode(
            raw_config.get("group_reply_filter_mode")
        )
        sessions = _normalize_group_filter_sessions(
            raw_config.get("group_reply_filter_sessions", [])
        )
        return mode, sessions

    # An old config only used this list for active replies. Migrate a non-empty
    # list to the broader whitelist permission model; an empty old list keeps
    # the previous open-by-default behavior.
    legacy_sessions = _normalize_group_filter_sessions(
        raw_config.get("active_reply_whitelist", [])
    )
    if legacy_sessions:
        return "whitelist", legacy_sessions
    return "blacklist", []


config = load_config()

WE_FLOW_BASE_URL = config["weflow_base_url"]
ACCESS_TOKEN = config["access_token"]
ASTRBOT_ATTACHMENTS = config.get("astrbot_attachments", "")
BOT_NICKNAMES = config["bot_nicknames"]
BOT_WXID = config.get("bot_wxid", "")
SEARCH_BY_WXID = bool(config.get("search_by_wxid", False))
UIA_DETAILED_LOGGING = bool(config.get("uia_detailed_logging", False))
UIA_DIRECT_WINDOW = config.get("uia_direct_window", False) is True
if UIA_DIRECT_WINDOW and config.get("group_reply_filter_mode") != "whitelist":
    raise ValueError("独立窗口发送模式必须使用消息过滤白名单")
# 发送方式已固定为 UIA 纯键盘模拟
BUFFER_SECONDS = config.get("buffer_seconds", 5)
WEB_PORT = config.get("web_port", 8766)
GROUP_REPLY_MODE = config.get("group_reply_mode", "mention")  # "mention" / "all"
ACTIVE_REPLY_ENABLED = bool(config.get("active_reply_enabled", False))
try:
    ACTIVE_REPLY_PROBABILITY = min(1.0, max(0.0, float(config.get("active_reply_probability", 0.1))))
except (TypeError, ValueError):
    ACTIVE_REPLY_PROBABILITY = 0.1
try:
    ACTIVE_REPLY_CONTEXT_LINES = min(100, max(0, int(config.get("active_reply_context_lines", 10))))
except (TypeError, ValueError):
    ACTIVE_REPLY_CONTEXT_LINES = 10
ACTIVE_REPLY_WHITELIST = [
    str(item).strip().casefold()
    for item in (config.get("active_reply_whitelist", []) or [])
    if str(item).strip()
]
GROUP_REPLY_FILTER_MODE, GROUP_REPLY_FILTER_SESSIONS = _group_filter_from_config(
    config
)


def is_direct_window_session_allowed(session_id) -> bool:
    """Fail closed for every outbound session, including private messages."""
    if not UIA_DIRECT_WINDOW:
        return True
    normalized = str(session_id or "").strip().casefold()
    return (GROUP_REPLY_FILTER_MODE == "whitelist" and bool(normalized)
            and normalized in GROUP_REPLY_FILTER_SESSIONS)


def is_group_reply_allowed(session_id) -> bool:
    """Final-send check used by the OneBot outbound queue."""
    normalized = str(session_id or "").strip().casefold()
    if GROUP_REPLY_FILTER_MODE == "whitelist":
        return normalized in GROUP_REPLY_FILTER_SESSIONS
    if GROUP_REPLY_FILTER_MODE == "blacklist":
        return normalized not in GROUP_REPLY_FILTER_SESSIONS
    return True


# Only the selected profile is exposed to the running client. Inactive credentials stay unused.
BOT_BACKEND, OB_LABEL, OB_URL, OB_TOKEN = resolve_connection(config)

# ============ 日志 ============

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.FileHandler(os.path.join(RUNTIME_DIR, "bridge.log"), encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("ob11-bridge")
