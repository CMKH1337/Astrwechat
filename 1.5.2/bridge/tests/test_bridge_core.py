"""Focused bridge routing tests. No network, database, model or UIA calls."""
import importlib.util
from pathlib import Path
import sys
import threading
import types
import unittest
from unittest.mock import Mock, patch


BRIDGE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BRIDGE))


class DummyTimer:
    def __init__(self, *args, **kwargs):
        self.started = False

    def start(self):
        self.started = True

    def cancel(self):
        self.started = False


def load_bridge_core(backend="kourichat"):
    fake_config = types.SimpleNamespace(
        BOT_NICKNAMES=["Bot"],
        BOT_BACKEND=backend,
        BOT_WXID="",
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

    def make_message_event(message_type, user_id, message, group_id=0, group_name="", nickname="", source=None):
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
        self.addCleanup(self.bridge.close)

    def test_other_backend_all_mode_forwards_ordinary_text(self):
        self.state.group_reply_mode = "all"
        with patch.object(self.core.threading, "Timer", DummyTimer), \
                patch.object(self.core, "push_event", return_value=True) as push:
            self.bridge.add_to_buffer(group_message("group-a@chatroom", "wxid_alice", "用户A", "普通群消息"))
            key = "group-a@chatroom_wxid_alice"
            entry = self.bridge.pending_buffers[key]
            self.bridge.process_sender(key, entry["timer_version"])
            event = push.call_args.args[0]
            self.assertEqual(event["message_type"], "group")
            self.assertEqual(event["message"], [{"type": "text", "data": {"text": "普通群消息"}}])

    def test_all_mode_dispatches_unmentioned_group_media_without_waiting_for_at(self):
        self.state.group_reply_mode = "all"


        def immediate_thread(target, args, daemon):
            thread = Mock()
            thread.start.side_effect = lambda: target(*args)
            return thread

        cases = [
            ("[图片]", {}, "process_image_message"),
            ("[动画表情]", {}, "process_emoji_message"),
            ("[表情]", {}, "process_emoji_message"),
            ("测试.txt", {"appMsgKind": "file", "fileName": "测试.txt"}, "process_file_message"),
        ]
        for content, fields, processor in cases:
            with self.subTest(content=content), \
                    patch.object(self.core.threading, "Thread", side_effect=immediate_thread), \
                    patch.object(self.bridge, processor) as process:
                message = group_message("group-a@chatroom", "wxid_alice", "用户A", content)
                message.update(fields)
                self.bridge.add_to_buffer(message)
                process.assert_called_once()
                self.assertEqual(process.call_args.args[0]["content"], content)
                self.assertEqual(self.bridge._pending_mention_images, {})
                self.assertEqual(self.bridge._pending_mention_files, {})

    def test_other_backend_all_mode_ignores_obsolete_session_filters(self):
        self.state.group_reply_mode = "all"
        self.config.GROUP_REPLY_FILTER_MODE = "whitelist"
        self.config.GROUP_REPLY_FILTER_SESSIONS = []
        with patch.object(self.core.threading, "Timer", DummyTimer), \
                patch.object(self.core, "push_event", return_value=True) as push:
            self.bridge.add_to_buffer(group_message("group-a@chatroom", "wxid_alice", "用户A", "普通消息"))
            key = "group-a@chatroom_wxid_alice"
            entry = self.bridge.pending_buffers[key]
            self.bridge.process_sender(key, entry["timer_version"])
            push.assert_called_once()


    def test_private_slash_commands_still_bypass_buffer(self):
        self.config.BOT_BACKEND = "astrbot"
        self.config.FORCE_PUSH_TRIGGERS = ("!ai", "小助手")  # Stale settings have no effect.
        for content, expected in (("  /help", "/help"), ("/sid", "/sid")):
            with self.subTest(content=content), \
                    patch.object(self.bridge, "_push_slash_command", return_value=True) as push:
                self.bridge.add_to_buffer({"sessionId": "wxid_alice", "sourceName": "用户A", "content": content})
                push.assert_called_once()
                self.assertEqual(push.call_args.args[1], expected)
                self.assertFalse(push.call_args.args[2])
        self.assertEqual(self.bridge.pending_buffers, {})


    def test_old_custom_prefixes_are_forwarded_as_regular_private_messages(self):
        self.config.BOT_BACKEND = "astrbot"
        self.config.FORCE_PUSH_TRIGGERS = ("!ai", "小助手")
        self.config.BUFFER_SECONDS = 5
        for text in ("!ai 帮我", "小助手 查询", "普通私聊"):
            with self.subTest(text=text), patch.object(self.core.threading, "Timer", DummyTimer), \
                    patch.object(self.bridge, "_push_slash_command") as command, \
                    patch.object(self.core, "push_event", return_value=True) as push:
                self.bridge.add_to_buffer({"sessionId": "wxid_alice", "sourceName": "用户A", "content": text})
                entry = self.bridge.pending_buffers["wxid_alice"]
                self.assertEqual(entry["messages"], [text])
                command.assert_not_called()
                self.bridge.process_sender("wxid_alice", entry["timer_version"])
                self.assertEqual(push.call_args.args[0]["message"], [{"type":"text","data":{"text":text}}])


    def test_non_astrbot_keeps_legacy_slash_routing_only(self):
        self.config.BOT_BACKEND = "kourichat"
        self.config.FORCE_PUSH_TRIGGERS = ("!ai",)
        self.assertEqual(self.bridge._slash_command_text(" /help"), "/help")
        self.assertEqual(self.bridge._slash_command_text("!ai 帮我"), "")

    def test_other_backend_mention_mode_requires_at(self):

        with patch.object(self.core.threading, "Timer", DummyTimer), \
                patch.object(self.core, "push_event", return_value=True) as push:
            self.bridge.add_to_buffer(group_message("group-a@chatroom", "wxid_alice", "用户A", "普通群消息"))
            self.assertEqual(self.bridge.pending_buffers, {})
            push.assert_not_called()
            self.bridge.add_to_buffer(group_message("group-a@chatroom", "wxid_alice", "用户A", "@Bot 在吗"))
            key = "group-a@chatroom_wxid_alice"
            entry = self.bridge.pending_buffers[key]
            self.bridge.process_sender(key, entry["timer_version"])
            push.assert_called_once()

    def test_other_backend_group_image_waits_for_same_sender_mention(self):
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

    def test_builtin_group_mention_is_cleaned_without_losing_trigger(self):
        from builtin_context import Transcripts
        from builtin_model import BuiltinReplies

        self.config.BOT_NICKNAMES = ["小冰"]

        self.state.paused = threading.Event()
        self.state.paused.set()
        self.state.reply_generation = 1
        builtin = BuiltinReplies.__new__(BuiltinReplies)
        builtin.bridge = self.bridge
        builtin.transcripts = Transcripts()
        builtin.submit = Mock(return_value=True)
        builtin.close = Mock()
        self.bridge.builtin = builtin
        self.config.BOT_BACKEND = "builtin"
        message = group_message("group-a@chatroom", "wxid_alice", "用户A", "@小冰 hi")
        with patch.object(self.core.threading, "Timer", DummyTimer), patch.dict(sys.modules, {"config": self.config}):
            self.bridge.add_to_buffer(message)
        entry = self.bridge.pending_buffers["group-a@chatroom_wxid_alice"]
        self.assertEqual(message["content"], "@小冰 hi")
        self.assertEqual(entry["messages"], ["@小冰 hi"])
        turns = builtin.transcripts.snapshot("group-a@chatroom", entry["builtin_ids"], 0, True)
        self.assertEqual(turns[0][1].split("\n", 1)[-1], "hi")
        self.bridge.process_sender("group-a@chatroom_wxid_alice", entry["timer_version"])
        builtin.submit.assert_called_once()


if __name__ == "__main__":
    unittest.main()
