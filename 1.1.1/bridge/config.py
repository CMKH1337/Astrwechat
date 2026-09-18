"""
配置模块：加载 config.json，提供全局配置常量。
"""

import json
import os
import logging
import threading

# ============ 配置 ============

CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")


def load_config():
    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


config = load_config()

WE_FLOW_BASE_URL = config["weflow_base_url"]
ACCESS_TOKEN = config["access_token"]
ASTRBOT_ATTACHMENTS = config.get("astrbot_attachments", "")
BOT_NICKNAMES = config["bot_nicknames"]
BOT_WXID = config.get("bot_wxid", "")
# 发送方式已固定为 UIA 纯键盘模拟
BUFFER_SECONDS = config.get("buffer_seconds", 5)
WEB_PORT = config.get("web_port", 8766)
GROUP_REPLY_MODE = config.get("group_reply_mode", "mention")  # "mention" / "all"
ACTIVE_REPLY_ENABLED = bool(config.get("active_reply_enabled", False))
try:
    ACTIVE_REPLY_PROBABILITY = min(1.0, max(0.0, float(config.get("active_reply_probability", 0.1))))
except (TypeError, ValueError):
    ACTIVE_REPLY_PROBABILITY = 0.1
ACTIVE_REPLY_WHITELIST = [
    str(item).strip().casefold()
    for item in (config.get("active_reply_whitelist", []) or [])
    if str(item).strip()
]

# AstrBot OneBot 连接配置（bridge 作为 WebSocket 客户端连 AstrBot 的 aiocqhttp 服务端）
ASTRBOT_OB_URL = config.get("astrbot_ob_url", "ws://127.0.0.1:19777")
ASTRBOT_OB_TOKEN = str(config.get("astrbot_ob_token", "") or "").strip()

# ============ 日志 ============

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.FileHandler("bridge.log", encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("ob11-bridge")
