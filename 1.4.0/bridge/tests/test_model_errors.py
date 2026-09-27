"""Stable error classification and opt-in notices without real UI/network sends."""
import asyncio
import logging
from collections import OrderedDict
from pathlib import Path
import queue
import sys
import threading
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from builtin_model import BuiltinReplies, load_sdk
from model_errors import ModelFailure, classify_model_error


class HttpError(Exception):
    def __init__(self, status):
        self.status_code = status
        self.body = {'api_key': 'secret-provider-key', 'message': 'private-user-message'}
        super().__init__('secret-provider-key private-user-message')


class ModelErrorTests(unittest.TestCase):
    def test_http_codes_have_distinct_actionable_descriptions(self):
        cases = {400: 'REQUEST', 401: 'AUTH', 402: 'QUOTA', 403: 'PERMISSION', 404: 'NOT_FOUND',
                 408: 'TIMEOUT', 413: 'TOO_LARGE', 422: 'REQUEST', 429: 'RATE_LIMIT',
                 500: 'SERVER', 503: 'SERVER', 504: 'TIMEOUT', 529: 'SERVER', 307: 'HTTP'}
        for status, suffix in cases.items():
            with self.subTest(status=status):
                failure = classify_model_error(HttpError(status))
                self.assertEqual(failure.code, 'E_MODEL_' + suffix)
                self.assertIn(f'HTTP {status}', failure.description)
                self.assertNotIn('secret-provider-key', failure.notice)
                self.assertNotIn('private-user-message', failure.notice)

    def test_timeout_connection_dependency_and_unknown_are_not_conflated(self):
        cases = [(TimeoutError('private'), 'TIMEOUT'), (ConnectionError('secret'), 'NETWORK'),
                 (ModuleNotFoundError('private'), 'DEPENDENCY'), (RuntimeError('secret'), 'UNKNOWN')]
        for name, code in [('APITimeoutError', 'TIMEOUT'), ('ConnectError', 'NETWORK'),
                           ('SSLCertVerificationError', 'NETWORK'), ('APIConnectionError', 'NETWORK'),
                           ('UnexpectedModelBehavior', 'RESPONSE'), ('ContentFilterError', 'FILTERED')]:
            cases.append((type(name, (Exception,), {})('secret'), code))
        for error, suffix in cases:
            with self.subTest(error=type(error).__name__):
                self.assertEqual(classify_model_error(error).code, 'E_MODEL_' + suffix)
        self.assertEqual(classify_model_error(ValueError('secret'), phase='startup').code, 'E_MODEL_CONFIG')

    def test_exception_chain_cycles_and_group_members_are_bounded(self):
        outer = RuntimeError('private')
        inner = HttpError(401)
        outer.__cause__ = inner
        inner.__cause__ = outer
        self.assertEqual(classify_model_error(outer).code, 'E_MODEL_AUTH')
        group = RuntimeError('private')
        group.exceptions = (outer,)
        self.assertEqual(classify_model_error(group).code, 'E_MODEL_AUTH')

    def test_classifier_never_stringifies_provider_error_or_accepts_arbitrary_status(self):
        class SensitiveError(Exception):
            status_code = '401 secret-provider-key'
            def __str__(self):
                raise AssertionError('Do not render provider errors')
        failure = classify_model_error(SensitiveError())
        self.assertEqual(failure.code, 'E_MODEL_UNKNOWN')
        self.assertIsNone(failure.http_status)
        self.assertNotIn('secret', failure.notice)

    def test_actual_sdk_wrapper_and_network_errors(self):
        load_sdk()
        import httpx2
        from pydantic_ai.exceptions import ModelHTTPError, UnexpectedModelBehavior
        from openai import APITimeoutError, APIConnectionError
        error = ModelHTTPError(401, 'private-model', body={'error': {'message': 'secret-provider-key'}})
        self.assertEqual(classify_model_error(error).code, 'E_MODEL_AUTH')
        self.assertNotIn('private-model', classify_model_error(error).notice)
        request = httpx2.Request('POST', 'https://example.invalid/v1', headers={'Authorization': 'Bearer secret'})
        self.assertEqual(classify_model_error(APITimeoutError(request=request)).code, 'E_MODEL_TIMEOUT')
        self.assertEqual(classify_model_error(APIConnectionError(request=request)).code, 'E_MODEL_NETWORK')
        self.assertEqual(classify_model_error(UnexpectedModelBehavior('secret', body='private')).code, 'E_MODEL_RESPONSE')


class ErrorNoticeWorkerTests(unittest.TestCase):
    def setUp(self):
        self.config = types.SimpleNamespace(ACTIVE_REPLY_CONTEXT_LINES=10, SEARCH_BY_WXID=False,
            UIA_DIRECT_WINDOW=True, is_direct_window_session_allowed=lambda _: True,
            is_group_reply_allowed=lambda _: True)
        self.state = types.SimpleNamespace(running=True, paused=threading.Event(), reply_generation=1)
        self.state.paused.set()
        self.sender = types.SimpleNamespace(send_text=Mock(return_value=True))
        self.local = types.SimpleNamespace(lock=threading.RLock(), echoes=OrderedDict(), clock=lambda: 100,
                                          can_forward=lambda *_: True)
        self.bridge = types.SimpleNamespace(sender=self.sender, local=self.local)
        with patch('builtin_model.threading.Thread'):
            self.replies = BuiltinReplies(self.bridge, {'builtin_send_errors': True},
                                         agent=types.SimpleNamespace(model=types.SimpleNamespace(client=None)))
        self.session = 'group@chatroom'
        self.request_calls = []
        self.error = HttpError(401)

    def execute(self, action=None, count=1, groups=True):
        for index in range(count):
            identity = self.replies.transcripts.observe(self.session, {'content': f'user-{index}'}, groups)
            self.replies.submit(self.session, '会话标题', groups, [identity], 0, 1)
        async def request(turns, media, allowed):
            self.request_calls.append(turns)
            if action is not None:
                return action(allowed)
            raise self.error
        self.replies._request = request
        original_get = self.replies.jobs.get
        def get(*_, **__):
            if self.replies.jobs.empty():
                self.replies.closed.set()
                raise queue.Empty
            return original_get(block=False)
        with patch.dict(sys.modules, {'config': self.config, 'state': self.state}), \
                patch.object(self.replies.jobs, 'get', side_effect=get), \
                patch.object(logging.getLogger('builtin-model'), 'isEnabledFor', return_value=True), \
                patch.object(logging.getLogger('builtin-model'), 'handle') as captured:
            self.replies._run()
        self.assertEqual(self.replies.jobs.unfinished_tasks, 0)
        return '\n'.join(call.args[0].getMessage() for call in captured.call_args_list)

    def test_enabled_notice_is_safe_one_attempt_and_not_model_history(self):
        logs = self.execute()
        self.assertIn('[内置模型] 正在请求模型', logs)
        self.assertNotIn('已收到模型回复', logs)
        self.assertNotIn('内置模型回复已发送', logs)
        self.sender.send_text.assert_called_once()
        args = self.sender.send_text.call_args.args
        self.assertEqual(args[0], '会话标题')
        self.assertIn('[E_MODEL_AUTH]', args[1])
        self.assertIn('HTTP 401', args[1])
        self.assertIn((self.session, args[1]), self.local.echoes)
        self.assertTrue(all(turn.role == 'user' for turn in self.replies.transcripts.sessions[self.session]))
        self.assertNotIn('secret-provider-key', args[1] + logs)
        self.assertNotIn('private-user-message', args[1] + logs)
        self.assertEqual(len(self.request_calls), 1)

    def test_default_is_off_and_disabled_logs_without_sending(self):
        with patch('builtin_model.threading.Thread'):
            default = BuiltinReplies(self.bridge, {}, agent=object())
        self.assertFalse(default.send_errors)
        self.replies.send_errors = False
        logs = self.execute()
        self.assertIn('E_MODEL_AUTH', logs)
        self.sender.send_text.assert_not_called()

    def test_repeated_errors_are_limited_per_session_and_not_retried(self):
        logs = self.execute(count=2)
        self.assertIn('限频', logs)
        self.assertEqual(len(self.request_calls), 2)
        self.sender.send_text.assert_called_once()

    def test_notify_false_or_exception_does_not_trigger_recursive_error_messages(self):
        for exception in (False, RuntimeError('secret-provider-key')):
            with self.subTest(exception=type(exception).__name__):
                self.setUp()
                if isinstance(exception, Exception):
                    self.sender.send_text.side_effect = exception
                else:
                    self.sender.send_text.return_value = False
                logs = self.execute(count=2)
                self.sender.send_text.assert_called_once()
                self.assertIn('E_ERROR_NOTIFY_SEND', logs)
                self.assertNotIn('secret-provider-key', logs)

    def test_empty_model_reply_has_its_own_notice(self):
        logs = self.execute(action=lambda _: '   ')
        self.assertIn('E_MODEL_EMPTY', logs)
        self.assertIn('E_MODEL_EMPTY', self.sender.send_text.call_args.args[1])

    def test_successful_reply_send_failure_is_not_reported_as_model_failure(self):
        self.sender.send_text.return_value = False
        logs = self.execute(action=lambda _: 'model reply')
        self.assertIn('E_WECHAT_SEND', logs)
        self.assertNotIn('E_MODEL_', logs)
        self.sender.send_text.assert_called_once()
        self.assertEqual(self.sender.send_text.call_args.args[1], 'model reply')

    def test_successful_reply_send_exception_is_not_reported_as_model_failure(self):
        self.sender.send_text.side_effect = RuntimeError('secret-provider-key')
        logs = self.execute(action=lambda _: 'model reply')
        self.assertIn('E_WECHAT_SEND', logs)
        self.assertNotIn('secret-provider-key', logs)
        self.sender.send_text.assert_called_once()

    def test_revoked_permissions_pause_stop_and_generation_suppress_notice(self):
        changes = [lambda: self.state.paused.clear(), lambda: setattr(self.state, 'running', False),
                   lambda: setattr(self.state, 'reply_generation', 2),
                   lambda: setattr(self.local, 'can_forward', lambda *_: False),
                   lambda: setattr(self.config, 'is_direct_window_session_allowed', lambda _: False),
                   lambda: setattr(self.config, 'is_group_reply_allowed', lambda _: False)]
        for change in changes:
            with self.subTest(change=changes.index(change)):
                self.setUp()
                def fail(_):
                    change()
                    raise self.error
                self.execute(action=fail)
                self.sender.send_text.assert_not_called()

    def test_ui_sender_receives_late_permission_guard(self):
        sent = []
        def sender(target, text, *, can_send):
            self.state.paused.clear()
            if can_send():
                sent.append(text)
                return True
            return False
        self.sender.send_text = sender
        self.execute()
        self.assertEqual(sent, [])

    def test_cancellation_logs_workflow_without_sending_or_failure_notice(self):
        def cancel(_):
            raise asyncio.CancelledError()
        logs = self.execute(action=cancel)
        self.assertIn('[内置模型] 本次回复已取消', logs)
        self.assertNotIn('已收到模型回复', logs)
        self.assertNotIn('E_MODEL_', logs)
        self.sender.send_text.assert_not_called()
        self.setUp()
        logs = self.execute(action=lambda _: None)
        self.assertIn('[内置模型] 本次回复已取消', logs)
        self.assertNotIn('已收到模型回复', logs)
        self.sender.send_text.assert_not_called()

    def test_success_records_real_reply_and_never_emits_an_error_notice(self):
        logs = self.execute(action=lambda _: '正常回复')
        self.assertIn('[内置模型] 正在请求模型 [群|会话标题]', logs)
        self.assertIn('[内置模型] 已收到模型回复 [群|会话标题]', logs)
        self.assertLess(logs.index('正在请求模型'), logs.index('已收到模型回复'))
        self.assertNotIn('内置模型回复已发送', logs)
        self.assertNotIn('E_MODEL_', logs)
        self.sender.send_text.assert_called_once()
        self.assertEqual(self.sender.send_text.call_args.args[1], '正常回复')
        turns = self.replies.transcripts.sessions[self.session]
        self.assertEqual(turns[-1].role, 'assistant')
        self.assertEqual(turns[-1].content, '正常回复')

    def test_full_model_queue_logs_distinct_code_without_sending_or_enqueueing_notice(self):
        for index in range(32):
            self.assertTrue(self.replies.submit(self.session, '会话标题', True, [index + 1], 0, 1))
        with self.assertLogs('builtin-model', level='WARNING') as captured:
            self.assertFalse(self.replies.submit(self.session, '会话标题', True, [33], 0, 1))
        self.assertIn('E_MODEL_QUEUE_FULL', '\n'.join(captured.output))
        self.sender.send_text.assert_not_called()
        self.assertEqual(self.replies.jobs.qsize(), 32)

    def test_private_wxid_routing_is_preserved(self):
        self.config.SEARCH_BY_WXID = True
        self.config.UIA_DIRECT_WINDOW = False
        self.session = 'wxid_private'
        self.execute(groups=False)
        self.assertEqual(self.sender.send_text.call_args.args[0], 'wxid_private')

    def test_cooldown_expires_and_other_sessions_are_independent(self):
        self.replies.error_notice_attempts[self.session] = 10
        with patch('builtin_model.time.monotonic', return_value=71):
            self.execute()
        self.sender.send_text.assert_called_once()
        self.setUp()
        self.replies.error_notice_attempts['other@chatroom'] = 10
        with patch('builtin_model.time.monotonic', return_value=11):
            self.execute()
        self.sender.send_text.assert_called_once()


if __name__ == '__main__':
    unittest.main()
