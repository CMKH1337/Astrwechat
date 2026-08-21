"""
消息发送器模块：UIA 发送器与工厂函数。

始终使用 UiaSender（纯键盘模拟）。
"""

import logging
from uia_sender import UiaSender

log = logging.getLogger("ob11-bridge")


def create_sender():
    """创建 UIA 消息发送器"""
    log.info("使用 UIA 发送消息（纯键盘模拟）")
    return UiaSender()
