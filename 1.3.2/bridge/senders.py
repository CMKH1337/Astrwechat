"""
消息发送器模块：UIA 发送器与工厂函数。

始终使用 UiaSender（纯键盘模拟）。
"""

import logging
import config
from uia_sender import UiaSender

log = logging.getLogger("ob11-bridge")


def create_sender():
    """创建 UIA 消息发送器"""
    log.info("使用 UIA 发送消息（纯键盘模拟）")
    if config.UIA_DIRECT_WINDOW:
        if config.GROUP_REPLY_FILTER_MODE != "whitelist":
            raise ValueError("独立窗口发送模式必须使用消息过滤白名单")
        log.warning("独立窗口发送已开启：请手动将白名单中的每个会话打开为独立聊天窗口，保持窗口存在；找不到或重名时不会发送，也不会回退搜索")
    return UiaSender(detailed_logging=config.UIA_DETAILED_LOGGING,
                     direct_window=config.UIA_DIRECT_WINDOW)
