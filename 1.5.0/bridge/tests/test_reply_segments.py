import asyncio
from collections import OrderedDict
import sys
from pathlib import Path
import threading
import time
import types
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from builtin_model import BuiltinReplies, load_sdk
load_sdk()
from reply_segments import ReplySegments
from model_limits import limits, fit_turns, ContextBudgetError
from model_errors import classify_model_error


class SegmentTests(unittest.TestCase):
    def settings(self, **kwargs):
        return ReplySegments(dict(builtin_segment_enabled=True, builtin_segment_random='0,0', **kwargs))

    def test_disabled_threshold_and_non_llm_are_unchanged(self):
        self.assertEqual(ReplySegments({}).split('第一。第二！'), ['第一。第二！'])
        self.assertEqual(self.settings(builtin_segment_threshold=6).split('第一。第二！'), ['第一。第二！'])
        self.assertEqual(self.settings().split('第一。第二！', llm=False), ['第一。第二！'])
        self.assertEqual(self.settings(builtin_segment_only_llm=False).split('第一。第二！', llm=False), ['第一。', '第二！'])

    def test_regex_preserves_tail_unmatched_spans_and_capture_groups(self):
        self.assertEqual(self.settings().split('hello. hi! tail'), ['hello.', 'hi!', 'tail'])
        self.assertEqual(self.settings().split('第一。第二！尾巴'), ['第一。', '第二！', '尾巴'])
        self.assertEqual(self.settings(builtin_segment_regex='(。)').split('第一。第二！尾巴'), ['第一。', '第二！尾巴'])
        self.assertEqual(self.settings(builtin_segment_regex='not-found').split('abc'), ['abc'])

    def test_newlines_filter_empty_and_segment_count_bound(self):
        self.assertEqual(self.settings(builtin_segment_mode='newline').split('a\n\nb'), ['a', 'b'])
        self.assertEqual(self.settings(builtin_segment_filter='[。！]').split('第一。第二！'), ['第一', '第二'])
        self.assertEqual(self.settings(builtin_segment_filter='.+').split('第一。'), [])
        parts = self.settings(builtin_segment_regex='.').split('x'*100)
        self.assertEqual(len(parts), 20)
        self.assertEqual(''.join(parts), 'x'*100)

    def test_bad_config_and_empty_matching_patterns_rejected(self):
        for patch_values in ({'builtin_segment_regex':'['},{'builtin_segment_regex':'a*'},
                {'builtin_segment_filter':'['},{'builtin_segment_random':'3,1'},
                {'builtin_segment_log_base':1},{'builtin_segment_random':'nan,2'},
                {'builtin_segment_regex':'x'*513}):
            with self.subTest(patch=patch_values), self.assertRaises(ValueError):
                raw = dict(builtin_segment_enabled=True, builtin_segment_random='0,0')
                raw.update(patch_values)
                ReplySegments(raw)

    def test_regex_timeout_and_zero_width_never_hang(self):
        segmenter = self.settings(builtin_segment_regex='(a+)+$', builtin_segment_threshold=10000)
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            segmenter.split('a'*9000+'!')
        self.assertLess(time.monotonic()-started, 1)
        with self.assertRaises(ValueError):
            self.settings(builtin_segment_regex='(?=a)').split('abc')

    def test_delay_and_cancellation(self):
        segmenter = self.settings(builtin_segment_interval='log', builtin_segment_log_base=2)
        self.assertEqual(segmenter.delay('12345678'), 3)
        self.assertEqual(segmenter.delay('x'), 0)
        self.assertEqual(self.settings().delay('anything'), 0)
        stop = threading.Event()
        self.assertFalse(segmenter.wait(60, lambda: False, stop))
        stop.set()
        self.assertFalse(segmenter.wait(60, lambda: True, stop))


class LimitTests(unittest.TestCase):
    def config(self):
        return {'builtin_protocol':'responses','builtin_base_url':'https://example.test/v1', 'builtin_model':'m',
          'builtin_model_metadata':{'id':'m','protocol':'responses','baseUrl':'https://example.test/v1',
          'contextWindow':4096,'maxInputTokens':3000,'maxOutputTokens':1000}}

    def test_provider_limits_and_manual_caps(self):
        raw = self.config()
        self.assertEqual(limits(raw), (2796,1000))
        self.assertEqual(limits(dict(raw,builtin_context_tokens=2048,builtin_max_output_tokens=200)),(1746,200))
        self.assertEqual(limits(dict(raw,builtin_model='different')), (30208,2048))
        raw['builtin_model_metadata']['contextWindow'] = None
        self.assertEqual(limits(raw),(1850,1000))

    def test_budget_drops_oldest_and_reserves_prompt_and_images(self):
        turns=[('user','old'*1000),('assistant','old reply'),('user','当前消息')]
        self.assertEqual(fit_turns(turns,'system',200),[('user','当前消息')])
        with self.assertRaises(ContextBudgetError): fit_turns(turns,'s'*500,200)
        with self.assertRaises(ContextBudgetError): fit_turns(turns,'system',200,1)
        self.assertEqual(classify_model_error(ContextBudgetError()).code,'E_MODEL_CONTEXT')

    def test_buffered_triggers_are_not_silently_dropped_to_fit_budget(self):
        from builtin_context import Transcripts
        transcripts = Transcripts(max_content=256000)
        first = transcripts.observe('s', {'content':'first'*50}, False)
        second = transcripts.observe('s', {'content':'second'}, False)
        turns, count = transcripts.snapshot('s', [first, second], 10, False, required=True)
        self.assertEqual(count, 2)
        with self.assertRaises(ContextBudgetError): fit_turns(turns, '', 200, required_count=count)
        with self.assertRaises(ContextBudgetError): transcripts.snapshot('s', [first, second], 10, False, max_chars=20)
        long = transcripts.observe('s', {'content':'x'*10000}, False)
        self.assertEqual(len(transcripts.snapshot('s', [long], 0, False)[-1][1]), 10000)
        too_long = transcripts.observe('s', {'content':'x'*256001}, False)
        with self.assertRaises(ContextBudgetError): transcripts.snapshot('s', [too_long], 0, False)


class SendTests(unittest.TestCase):
    def setUp(self):
        self.sent=[]
        self.allowed=True
        self.config = types.SimpleNamespace(SEARCH_BY_WXID=False,UIA_DIRECT_WINDOW=True)
        self.local=types.SimpleNamespace(lock=threading.RLock(),echoes=OrderedDict(),clock=lambda:100)
        def send(target,text,can_send):
            if not can_send(): return False
            self.sent.append(text)
            return True
        bridge=types.SimpleNamespace(local=self.local,sender=types.SimpleNamespace(send_text=send))
        with patch('builtin_model.threading.Thread'):
            self.replies=BuiltinReplies(bridge,{'builtin_segment_enabled':True,'builtin_segment_random':'0,0'},agent=object())
        self.id=self.replies.transcripts.observe('s',{'content':'question'},False)

    def send(self, reply='第一。第二！', llm=True):
        with patch.dict(sys.modules,{'config':self.config}):
            return self.replies._send_reply('s','contact',False,reply,lambda:self.allowed,self.id,llm=llm)

    def test_segments_order_and_one_history_turn(self):
        self.assertTrue(self.send())
        self.assertEqual(self.sent,['第一。','第二！'])
        history=self.replies.transcripts.sessions['s']
        self.assertEqual(len(history),2)
        self.assertEqual(history[-1].content,'第一。\n第二！')

    def test_builtin_uses_actual_uia_confirmation_once_per_delivered_segment(self):
        from test_direct_window import direct_sender
        import uia_sender
        sender, _ = direct_sender('contact')
        self.replies.bridge.sender = sender
        with patch.dict(sys.modules, {'pyperclip': Mock()}), \
                patch.object(uia_sender.time, 'sleep'), \
                self.assertLogs('weflow-bridge', level='INFO') as captured:
            self.assertTrue(self.send())
        confirmations = [record.getMessage() for record in captured.records if '[UIA✓]' in record.getMessage()]
        self.assertEqual(confirmations, ['[UIA✓] contact: 第一。...', '[UIA✓] contact: 第二！...'])
        self.assertEqual(sender._auto.keys, ['{Ctrl}v', '{Enter}', '{Ctrl}v', '{Enter}'])
        with patch.object(sender, '_send_target_key', return_value=False), \
                patch.dict(sys.modules, {'pyperclip': Mock()}), \
                patch.object(uia_sender.time, 'sleep'), \
                self.assertNoLogs('weflow-bridge', level='INFO'):
            self.assertFalse(self.send())

    def test_cancel_or_failed_later_segment_records_only_delivered_prefix(self):
        for fail in (True,False):
            with self.subTest(fail=fail):
                self.setUp()
                def send(target,text,can_send):
                    if self.sent: return False
                    self.sent.append(text)
                    if not fail: self.allowed=False
                    return True
                self.replies.bridge.sender.send_text=send
                self.assertFalse(self.send())
                self.assertEqual(self.sent,['第一。'])
                self.assertEqual(self.replies.transcripts.sessions['s'][-1].content,'第一。')

    def test_cleared_history_is_not_restored_after_pending_send(self):
        def send(target,text,can_send):
            self.replies.transcripts.clear('s')
            self.allowed=False
            return True
        self.replies.bridge.sender.send_text=send
        self.assertFalse(self.send())
        self.assertNotIn('s',self.replies.transcripts.sessions)

    def test_non_llm_segments_register_each_echo_and_never_history(self):
        self.replies.segments.only_llm=False
        self.assertTrue(self.send(llm=False))
        self.assertEqual(set(self.local.echoes),{('s','第一。'),('s','第二！')})
        self.assertEqual(len(self.replies.transcripts.sessions['s']),1)

    def test_filter_empty_and_runtime_error_fallback(self):
        self.replies.segments=ReplySegments({'builtin_segment_enabled':True,'builtin_segment_filter':'.+'})
        self.assertTrue(self.send())
        self.assertEqual(self.sent,[])
        self.assertEqual(len(self.replies.transcripts.sessions['s']),1)
        self.replies.segments.split=Mock(side_effect=TimeoutError())
        self.assertTrue(self.send())
        self.assertEqual(self.sent,['第一。第二！'])

    def test_request_uses_budget_output_cap_and_skips_unsupported_images(self):
        self.replies.input_budget=200
        self.replies.max_tokens=64
        captured=[]
        async def request(agent,text,turns,timeout,system_prompt,images,max_tokens):
            captured.append((text,turns,max_tokens))
            return 'response'
        with patch('builtin_model.async_request_reply',side_effect=request):
            self.assertEqual(asyncio.run(self.replies._request([('user','x'*300),('user','hi')],[],lambda:True)),'response')
        self.assertEqual(captured,[('hi',[],64)])
        with patch('builtin_model.threading.Thread'):
            raw=LimitTests().config();raw['builtin_send_images']=True;raw['builtin_model_metadata']['vision']=False
            replies=BuiltinReplies(self.replies.bridge,raw,agent=object())
        self.assertFalse(replies.send_images)


if __name__ == '__main__': unittest.main()
