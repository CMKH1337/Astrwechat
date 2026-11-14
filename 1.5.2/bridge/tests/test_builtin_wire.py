"""Exercise all three SDK wire formats against a local HTTP stub."""
import json
import types
import sys
import threading
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from builtin_context import Transcripts
from model_errors import classify_model_error
from builtin_model import BuiltinReplies, build_agent, request_reply, load_sdk
load_sdk()


class Stub(BaseHTTPRequestHandler):
    paths = []
    requests = []
    failure_status = None

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        self.requests.append(body)
        self.paths.append(self.path)
        path = urlsplit(self.path).path
        if self.failure_status is not None:
            payload = json.dumps({"error": {"type": "api_error", "message": "secret-key private-chat-body"}}).encode()
            self.send_response(self.failure_status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if path == "/v1/chat/completions":
            result = {"id": "chat-1", "object": "chat.completion", "created": 1,
                      "model": "test", "choices": [{"index": 0, "finish_reason": "stop",
                      "message": {"role": "assistant", "content": "pong"}}],
                      "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}
        elif path == "/v1/responses":
            result = {"id": "resp-1", "object": "response", "created_at": 1,
                      "model": "test", "status": "completed", "error": None,
                      "output": [{"id": "msg-1", "type": "message", "role": "assistant", "status": "completed",
                                  "content": [{"type": "output_text", "text": "pong", "annotations": []}]}],
                      "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}
        elif path == "/v1/messages":
            result = {"id": "msg-1", "type": "message", "role": "assistant",
                      "model": "test", "content": [{"type": "text", "text": "pong"}],
                      "stop_reason": "end_turn", "stop_sequence": None,
                      "usage": {"input_tokens": 1, "output_tokens": 1}}
        else:
            self.send_error(404)
            return
        payload = json.dumps(result).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_):
        pass


class WireTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import pydantic_ai  # noqa: F401
        except ImportError:
            raise unittest.SkipTest("Pydantic AI is not installed")
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def test_all_protocols_send_history_as_messages(self):
        for protocol, path in (("chat_completions", "/v1/chat/completions"),
                               ("responses", "/v1/responses"),
                               ("anthropic_messages", "/v1/messages")):
            with self.subTest(protocol=protocol):
                Stub.paths.clear()
                Stub.requests.clear()
                base = f"http://127.0.0.1:{self.server.server_port}"
                agent = build_agent({"builtin_protocol": protocol, "builtin_base_url": base if protocol == "anthropic_messages" else base + "/v1",
                                     "builtin_api_key": "test-key", "builtin_model": "test",
                                     "builtin_system_prompt": "Be brief", "builtin_timeout_seconds": 10})
                self.assertEqual(request_reply(agent, "乙：你好", [("user", "甲：早"),
                                 ("assistant", "早")], 10, "Be brief"), "pong")
                self.assertEqual([urlsplit(p).path for p in Stub.paths], [path])
                self.assertIn("甲：早", json.dumps(Stub.requests[0], ensure_ascii=False))
                self.assertIn("乙：你好", json.dumps(Stub.requests[0], ensure_ascii=False))


    def test_output_limits_reach_all_three_wire_formats(self):
        for protocol, field in (("chat_completions", "max_completion_tokens"),
                                ("responses", "max_output_tokens"), ("anthropic_messages", "max_tokens")):
            with self.subTest(protocol=protocol):
                Stub.requests.clear()
                base = f"http://127.0.0.1:{self.server.server_port}"
                agent = build_agent({"builtin_protocol": protocol,
                    "builtin_base_url": base if protocol == "anthropic_messages" else base + "/v1",
                    "builtin_api_key": "test-key", "builtin_model": "test"})
                self.assertEqual(request_reply(agent, "hi", [], 10, max_tokens=73), "pong")
                body = Stub.requests[0]
                self.assertEqual(body.get(field, body.get("max_tokens")), 73)

    def test_bot_mentions_are_removed_from_actual_requests_and_history_for_all_protocols(self):
        replies = BuiltinReplies.__new__(BuiltinReplies)
        replies.bridge = types.SimpleNamespace(_normalize_session_id=lambda data: data["sessionId"])
        replies.transcripts = Transcripts()
        session = "group@chatroom"
        with patch.dict(sys.modules, {"config": types.SimpleNamespace(BOT_NICKNAMES=["小冰", "冰姐"])}):
            first = replies.observe({"sessionId": session, "senderName": "甲", "content": "@小冰 earlier"}, True)
            replies.transcripts.replied(session, "hello", first)
            second = replies.observe({"sessionId": session, "senderName": "乙", "content": "＠冰姐\u2005hi @小红"}, True)
        turns = replies.transcripts.snapshot(session, [second], 10, True)
        for protocol in ("chat_completions", "responses", "anthropic_messages"):
            with self.subTest(protocol=protocol):
                Stub.requests.clear()
                base = f"http://127.0.0.1:{self.server.server_port}"
                agent = build_agent({"builtin_protocol": protocol,
                                     "builtin_base_url": base if protocol == "anthropic_messages" else base + "/v1",
                                     "builtin_api_key": "test-key", "builtin_model": "test"})
                self.assertEqual(request_reply(agent, turns[-1][1], turns[:-1], 10), "pong")
                self.assertEqual(len(Stub.requests), 1)
                body = Stub.requests[0]
                payload = json.dumps(body, ensure_ascii=False)
                self.assertNotIn("@小冰", payload)
                self.assertNotIn("＠冰姐", payload)
                self.assertIn("@小红", payload)
                messages = body["input"] if protocol == "responses" else body["messages"]
                user_contents = [message["content"] for message in messages if message.get("role") == "user"]
                texts = []
                for content in user_contents:
                    if isinstance(content, str):
                        texts.append(content)
                    else:
                        texts.extend(part["text"] for part in content if part.get("type") in ("text", "input_text"))
                self.assertEqual([text.split("\n", 1)[-1] for text in texts], ["earlier", "hi @小红"])


    def test_http_failures_keep_status_without_raw_response_or_automatic_retries(self):
        for protocol in ("chat_completions", "responses", "anthropic_messages"):
            for status, code in ((401, "E_MODEL_AUTH"), (429, "E_MODEL_RATE_LIMIT"), (503, "E_MODEL_SERVER")):
                with self.subTest(protocol=protocol, status=status), patch.object(Stub, "failure_status", status):
                    Stub.requests.clear()
                    base = f"http://127.0.0.1:{self.server.server_port}"
                    agent = build_agent({"builtin_protocol": protocol,
                                         "builtin_base_url": base if protocol == "anthropic_messages" else base + "/v1",
                                         "builtin_api_key": "test-key", "builtin_model": "test"})
                    with self.assertRaises(Exception) as caught:
                        request_reply(agent, "private-user-input", [], 10)
                    failure = classify_model_error(caught.exception)
                    self.assertEqual(failure.code, code)
                    self.assertEqual(failure.http_status, status)
                    self.assertEqual(len(Stub.requests), 1)
                    for secret in ("secret-key", "private-chat-body", "private-user-input", "test-key"):
                        self.assertNotIn(secret, failure.notice)


if __name__ == "__main__":
    unittest.main()
