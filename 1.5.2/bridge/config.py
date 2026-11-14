"""
配置模块：加载 config.json，提供全局配置常量。
"""

import json
import os
import logging
import threading
from logging.handlers import RotatingFileHandler
from connection_config import resolve_connection

# ============ 配置 ============

# Electron supplies the writable per-user config; standalone launches keep the legacy default.
CONFIG_FILE = os.path.abspath(os.environ.get("WEFLOW_BRIDGE_CONFIG") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json"))
RUNTIME_DIR = os.path.dirname(CONFIG_FILE)


def load_config():
    with open(CONFIG_FILE, "r", encoding="utf-8-sig") as f:
        return json.load(f)


config = load_config()

WE_FLOW_BASE_URL = config["weflow_base_url"]
ACCESS_TOKEN = config["access_token"]
ASTRBOT_ATTACHMENTS = config.get("astrbot_attachments", "")
BOT_NICKNAMES = config["bot_nicknames"]
BOT_WXID = config.get("bot_wxid", "")
SEARCH_BY_WXID = bool(config.get("search_by_wxid", False))
UIA_DETAILED_LOGGING = bool(config.get("uia_detailed_logging", False))
VOICE_AUDIO_OUTPUT_DEVICE_ID = str(config.get("voice_audio_output_device_id", "") or "").strip()
VOICE_BUBBLE_ENABLED = bool(config.get("voice_bubble_enabled", False))

_SUPPORTED_VOICE_AUDIO_FORMATS = ("mp3", "wav", "m4a", "aac", "ogg", "opus", "flac", "webm")
_DEFAULT_VOICE_AUDIO_FORMATS = ("mp3", "wav")

def normalize_voice_audio_formats(value):
    if not isinstance(value, (list, tuple, set)):
        value = _DEFAULT_VOICE_AUDIO_FORMATS
    return list(dict.fromkeys(
        str(item).strip().lower().lstrip(".")
        for item in value
        if str(item).strip().lower().lstrip(".") in _SUPPORTED_VOICE_AUDIO_FORMATS
    ))


VOICE_AUDIO_FORMATS = normalize_voice_audio_formats(config.get("voice_audio_formats"))
UIA_DIRECT_WINDOW = config.get("uia_direct_window", False) is True
# 发送方式已固定为 UIA 纯键盘模拟
BUFFER_SECONDS = config.get("buffer_seconds", 5)
WEB_PORT = config.get("web_port", 8766)
GROUP_REPLY_MODE = config.get("group_reply_mode", "mention")  # "mention" / "all"
# Only the selected profile is exposed to the running client. Inactive credentials stay unused.
BOT_BACKEND, OB_LABEL, OB_URL, OB_TOKEN = resolve_connection(config)
BUILTIN_CONFIG = {key: value for key, value in config.items() if key.startswith("builtin_")}

# ============ 日志 ============

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [pid=%(process)d thread=%(threadName)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        RotatingFileHandler(os.path.join(RUNTIME_DIR, "bridge.log"), maxBytes=5 * 1024 * 1024, backupCount=2, encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("ob11-bridge")
