"""Focused bridge routing tests. No network, database, model or UIA calls."""
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


BRIDGE = Path(__file__).resolve().parents[1]


class DummyTimer:
    def __init__(self, *args, **kwargs):
        self.started = False

    def start(self):
        self.started = True

    def cancel(self):
        self.started = False


def load_bridge_core():
    fake_config = types.SimpleNamespace(
        BOT_NICKNAMES=["Bot"],
        BOT_WXID="",
        GROUP_REPLY_FILTER_MODE="blacklist",
        GROUP_REPLY_FILTER_SESSIONS=[],
        ACTIVE_REPLY_ENABLED=True,
        ACTIVE_REPLY_PROBABILITY=0.0,
        ACTIVE_REPLY_CONTEXT_LINES=2,
        BUFFER_SECONDS=0,
        OB_LABEL="AstrBot",
    )
    fake_state = types.SimpleNamespace(
        group_reply_mode="mention",
        _self_id_int=10000,
        _ob_id_to_contact={},
        _ob_group_id_to_session_id={},
        _ob_private_id_to_session_id={},
        _wxid_to_int=lambda value: abs(hash(value)) % 100000 + 1,
        _group_to_int=lambda value: abs(hash(("group", value))) % 100000 + 1,
    )

    def make_message_event(message_type, user_id, message, group_id=0, group_name="", nickname=""):
        return {
            "message_type": message_type,
            "user_id": user_id,
            "group_id": group_id,
            "group_name": group_name,
            "nickname": nickname,
            "message": message,
        }

    fake_protocol = types.SimpleNamespace(
        push_event=lambda event: True,
        make_message_event=make_message_event,
    )
    module_name = f"test_bridge_core_{id(fake_config)}"
    with patch.dict(sys.modules, {
        "config": fake_config,
        "state": fake_state,
        "ob_protocol": fake_protocol,
    }):
        spec = importlib.util.spec_from_file_location(module_name, BRIDGE / "bridge_core.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module, fake_config, fake_state


def group_message(group_id, sender_id, sender_name, content):
    return {
        "sessionId": group_id,
        "talkerId": group_id,
        "sessionType": "group",
        "groupName": f"测试群-{group_id}",
        "sourceName": sender_name,
        "senderName": sender_name,
        "senderUsername": sender_id,
        "content": content,
    }


class BridgeCoreTests(unittest.TestCase):
    def setUp(self):
        self.core, self.config, self.state = load_bridge_core()
        self.bridge = self.core.WeFlowBridge(sender=None)

    def test_group_image_waits_for_same_sender_mention_even_when_active_reply_enabled(self):
        image = group_message("group-a@chatroom", "wxid_alice", "用户A", "[图片]")
        self.bridge.add_to_buffer(image)

        key = ("group-a@chatroom", "wxid_alice")
        self.assertIn(key, self.bridge._pending_mention_images)
        self.assertEqual(self.bridge.pending_buffers, {})

        other_sender = group_message("group-a@chatroom", "wxid_bob", "用户B", "@Bot 看图")
        self.assertIsNone(self.bridge._claim_pending_group_image(other_sender))
        self.assertIn(key, self.bridge._pending_mention_images)

        same_sender = group_message("group-a@chatroom", "wxid_alice", "用户A", "@Bot 看图")
        claimed = self.bridge._claim_pending_group_image(same_sender)
        self.assertEqual(claimed["data"]["content"], "[图片]")
        self.assertNotIn(key, self.bridge._pending_mention_images)

    def test_only_active_reply_gets_group_scoped_context(self):
        with patch.object(self.core.threading, "Timer", DummyTimer):
            self.bridge.add_to_buffer(group_message("group-a@chatroom", "wxid_a", "用户A", "你们好"))
            self.bridge.add_to_buffer(group_message("group-b@chatroom", "wxid_x", "用户X", "别的群消息"))
            self.bridge.add_to_buffer(group_message("group-a@chatroom", "wxid_b", "用户B", "你好你好"))

            self.config.ACTIVE_REPLY_PROBABILITY = 1.0
            trigger = group_message("group-a@chatroom", "wxid_c", "用户C", "hi~")
            self.bridge.add_to_buffer(trigger)

            active_entry = self.bridge.pending_buffers["group-a@chatroom_wxid_c"]
            self.assertTrue(active_entry["active_reply"])
            self.assertEqual(active_entry["active_reply_context"], ["用户A：你们好", "用户B：你好你好"])

            pushed = []
            self.core.push_event = lambda event: pushed.append(event) or True
            self.bridge.process_sender("group-a@chatroom_wxid_c", active_entry["timer_version"])
            active_text = pushed[-1]["message"][1]["data"]["text"].lstrip()
            self.assertEqual(
                active_text,
                "[群聊上下文]\n用户A：你们好\n用户B：你好你好\n\nhi~",
            )
            self.assertNotIn("用户X", active_text)

            mention = group_message("group-a@chatroom", "wxid_d", "用户D", "@Bot 在吗")
            self.bridge.add_to_buffer(mention)
            mention_entry = self.bridge.pending_buffers["group-a@chatroom_wxid_d"]
            self.assertFalse(mention_entry["active_reply"])
            self.bridge.process_sender("group-a@chatroom_wxid_d", mention_entry["timer_version"])
            mention_text = pushed[-1]["message"][1]["data"]["text"].lstrip()
            self.assertNotIn("[群聊上下文]", mention_text)


if __name__ == "__main__":
    unittest.main()
