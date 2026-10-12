"""No network or WeChat UI used in built-in model tests."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from builtin_context import Transcripts
from builtin_model import build_agent, load_sdk, request_reply, safe_text, validate_model_config


class BuiltinModelTests(unittest.TestCase):
    def config(self, protocol="chat_completions"):
        return dict(builtin_protocol=protocol, builtin_base_url="http://127.0.0.1:9999",
                    builtin_api_key="secret", builtin_model="test", builtin_timeout_seconds=10,
                    builtin_system_prompt="Keep replies short")

    def test_each_wire_protocol_constructs_an_sdk_model(self):
        try:
            load_sdk()
            from pydantic_ai.models.openai import OpenAIChatModel, OpenAIResponsesModel
            from pydantic_ai.models.anthropic import AnthropicModel
        except ImportError:
            self.skipTest("Pydantic AI optional dependencies are not installed")
        for protocol, cls in (("chat_completions", OpenAIChatModel),
                              ("responses", OpenAIResponsesModel),
                              ("anthropic_messages", AnthropicModel)):
            with self.subTest(protocol=protocol):
                self.assertIsInstance(build_agent(self.config(protocol)).model, cls)

    def test_validation_blocks_invalid_selected_endpoint(self):
        for change in (dict(builtin_protocol="invalid"), dict(builtin_api_key="a\nb"),
                       dict(builtin_model=""), dict(builtin_base_url="http://example.com/v1"),
                       dict(builtin_base_url="https://example.com/v1/chat/completions"),
                       dict(builtin_base_url="https://user:pass@example.com"),
                       dict(builtin_timeout_seconds=0)):
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_model_config(dict(self.config(), **change))

    def test_group_context_is_separate_turns_and_paths_are_removed(self):
        transcripts = Transcripts()
        session = "group@chatroom"
        first = transcripts.observe(session, {"senderName": "甲", "content": "第一条"}, True)
        transcripts.replied(session, "收到", first)
        second = transcripts.observe(session, {"senderName": "乙", "content": "第二条"}, True)
        third = transcripts.observe(session, {"senderName": "丙", "content": "第三条"}, True)
        later_id = transcripts.observe(session, {"senderName": "丁", "content": "后来"}, True)
        transcripts.observe("another@chatroom", {"senderName": "戊", "content": "另一群"}, True)
        turns = transcripts.snapshot(session, [third], 2, True)
        self.assertEqual([role for role, _ in turns], ["user", "user"])
        self.assertEqual([text.rsplit("\n", 1)[-1] for _, text in turns],
                         ["第二条", "第三条"])
        self.assertIn('"sender": "乙"', turns[0][1])
        self.assertEqual(transcripts.snapshot(session, [second, third], 2, True), turns)
        # A group message consumes one round even when no AI reply was generated.
        later = transcripts.snapshot(session, [later_id], 3, True)
        self.assertEqual([text.rsplit("\n", 1)[-1] for _, text in later],
                         ["第二条", "第三条", "后来"])
        self.assertEqual(safe_text("[文件] x.txt\n[本机文件路径] C:\\secret\\x.txt"), "[文件] x.txt")

    def test_sdk_receives_structured_history_and_system_prompt(self):
        try:
            load_sdk()
            from pydantic_ai import Agent
            from pydantic_ai.models.test import TestModel
        except ImportError:
            self.skipTest("Pydantic AI is not installed")
        result = request_reply(Agent(TestModel()), "乙：现在回复", [("user", "甲：你好"),
                                 ("assistant", "你好"), ("user", "丙：在吗")], 10, "礼貌回复")
        self.assertTrue(result)


if __name__ == "__main__":
    unittest.main()
