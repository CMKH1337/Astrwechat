"""Native AstrBot group routing; all network, media and UI sends are substituted."""
import importlib.util
import threading
import types
import unittest
from unittest.mock import Mock, patch

from test_bridge_core import BRIDGE, load_bridge_core, group_message
from astrbot_messages import native_group_segments


class NativeGroupTests(unittest.TestCase):
    def setUp(self):
        self.core, self.config, self.state = load_bridge_core('astrbot')
        # Use the real protocol envelope, not the legacy routing fixture's simplified stub.
        with patch.dict('sys.modules', {'config': self.config, 'state': self.state}):
            spec = importlib.util.spec_from_file_location('native_test_protocol', BRIDGE/'ob_protocol.py')
            self.protocol = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.protocol)
        self.core.make_message_event = self.protocol.make_message_event
        self.bridge = self.core.WeFlowBridge(None)
        self.bridge._native_worker_started = True  # Drain synchronously, except the worker test.
        self.events = []
        self.core.push_event = lambda event: self.events.append(event) or True
        self.addCleanup(self.bridge.close)

    def receive(self, text, sender='wxid_a', group='a@chatroom', **fields):
        data = group_message(group, sender, sender, text)
        data.update(timestamp=1794610000, **fields)
        self.bridge.add_to_buffer(data)
        return data

    def drain(self):
        while not self.bridge._native_messages.empty():
            data = self.bridge._native_messages.get_nowait()
            self.bridge._push_native_group_message(data)
            self.bridge._native_messages.task_done()

    def test_old_group_modes_probabilities_and_buffer_do_not_control_astrbot(self):
        self.config.BUFFER_SECONDS = 30
        self.config.ACTIVE_REPLY_ENABLED = True
        self.config.ACTIVE_REPLY_PROBABILITY = 0
        for mode in ('mention', 'all', 'batch'):
            self.state.group_reply_mode = mode
            self.receive('普通消息', sender='wxid_a')
            self.receive('普通消息', sender='wxid_b')
        self.drain()
        self.assertEqual(len(self.events), 6)
        self.assertEqual(len({x['message_id'] for x in self.events}), 6)
        self.assertNotEqual(self.events[0]['user_id'], self.events[1]['user_id'])
        self.assertEqual(self.events[0]['group_id'], self.events[1]['group_id'])
        for event in self.events:
            self.assertEqual(event['message'], [{'type': 'text', 'data': {'text': '普通消息'}}])
            self.assertEqual(event['time'], 1794610000)
            self.assertEqual(event['sub_type'], 'normal')
            self.assertEqual(event['self_id'], 10000)
            self.assertEqual(event['sender']['user_id'], event['user_id'])
        self.assertFalse(self.bridge.pending_buffers)

    def test_real_mentions_and_sid_remain_distinct_from_ordinary_messages(self):
        self.receive('@Bot\u2005在吗')
        self.receive('大家好')
        self.receive('/sid')
        self.drain()
        self.assertEqual(self.events[0]['message'][0], {'type':'at', 'data':{'qq':'10000'}})
        self.assertEqual([s['type'] for s in self.events[1]['message']], ['text'])
        self.assertEqual(self.events[2]['message'], [{'type':'text', 'data':{'text':'/sid'}}])
        group = self.events[2]['group_id']
        self.assertEqual(self.state._ob_group_id_to_session_id[group], 'a@chatroom')
        self.assertEqual(self.state._ob_id_to_contact[group], '测试群-a@chatroom')

    def test_route_is_available_before_push_and_retains_sender_across_groups(self):
        seen = []
        def push(event):
            seen.append(self.state._ob_group_id_to_session_id[event['group_id']])
            self.events.append(event)
            return True
        self.core.push_event = push
        self.receive('一', group='a@chatroom')
        self.receive('二', group='b@chatroom')
        self.drain()
        self.assertEqual(seen, ['a@chatroom', 'b@chatroom'])
        self.assertEqual(self.events[0]['user_id'], self.events[1]['user_id'])
        self.assertNotEqual(self.events[0]['group_id'], self.events[1]['group_id'])

    def test_obsolete_filters_never_block_native_messages(self):
        for direct in (False, True):
            self.config.UIA_DIRECT_WINDOW = direct
            for mode, sessions in [('whitelist', []), ('blacklist', ['a@chatroom'])]:
                self.config.GROUP_REPLY_FILTER_MODE = mode
                self.config.GROUP_REPLY_FILTER_SESSIONS = sessions
                self.receive('消息')
                self.assertEqual(self.bridge._native_messages.qsize(), 1)
                self.drain()
        self.assertEqual(len(self.events), 4)


    def test_pause_during_media_preparation_blocks_event(self):
        def fetch(data):
            self.bridge.local.paused.add('a@chatroom')
            return 'fake.png'
        with patch.object(self.bridge, '_fetch_wechat_image', side_effect=fetch), \
                patch.object(self.bridge, '_make_image_segment', return_value={'type':'image','data':{'file':'base64://AA=='}}):
            self.receive('[图片]')
            self.drain()
        self.assertFalse(self.events)

    def test_stop_start_invalidates_queued_message_without_replay(self):
        self.receive('旧消息')
        with self.bridge.local.lock:
            self.bridge.local.paused.add('a@chatroom')
            self.bridge.local.epochs['a@chatroom'] = 1
        self.receive('暂停消息')
        self.bridge.local.paused.clear()
        self.receive('新消息')
        self.drain()
        self.assertEqual([e['raw_message'] for e in self.events], ['新消息'])

    def test_self_messages_and_local_commands_do_not_reach_astrbot(self):
        self.receive('自己的消息', isSend=True)
        # Local public commands must be consumed even though group forwarding is unconditional.
        with patch.object(self.bridge.local, 'reply'):
            self.receive('#UID')
        self.drain()
        self.assertFalse(self.events)

    def test_image_and_file_preserve_existing_content_without_fake_at(self):
        image={'type':'image','data':{'file':'base64://AA=='}}
        with patch.object(self.bridge, '_fetch_wechat_image', return_value='fake.png'), \
                patch.object(self.bridge, '_make_image_segment', return_value=image), \
                patch.object(self.bridge, '_resolve_file_message_text', return_value='测试.txt\n[本机文件路径] C:/test.txt'):
            self.receive('[图片]')
            self.receive('测试.txt', appMsgKind='file', fileName='测试.txt')
            self.drain()
        self.assertEqual(self.events[0]['message'][-1], image)
        self.assertIn('[本机文件路径]', self.events[1]['raw_message'])
        self.assertTrue(all(s['type']!='at' for e in self.events for s in e['message']))
        self.assertFalse(self.bridge._pending_mention_images)
        self.assertFalse(self.bridge._pending_mention_files)

    def test_voice_placeholder_reaches_native_context(self):
        self.receive('[语音]', localType=34)
        self.drain()
        self.assertEqual(self.events[0]['raw_message'], '[语音]')

    def test_media_failure_retains_placeholder(self):
        with patch.object(self.bridge, '_fetch_wechat_image', return_value=None):
            self.receive('[图片]')
            self.drain()
        self.assertEqual(self.events[0]['message'], [{'type':'text','data':{'text':'[图片]'}}])

    def test_worker_preserves_image_then_text_order(self):
        entered, release, complete = threading.Event(), threading.Event(), threading.Event()
        def fetch(data):
            entered.set()
            self.assertTrue(release.wait(2))
            return None
        def push(event):
            self.events.append(event)
            if len(self.events)==2: complete.set()
            return True
        self.core.push_event = push
        self.bridge._native_worker_started = False
        with patch.object(self.bridge, '_fetch_wechat_image', side_effect=fetch):
            try:
                self.receive('[图片]')
                self.assertTrue(entered.wait(2))
                self.receive('这张图')
                self.assertFalse(self.events)
            finally:
                release.set()
            self.assertTrue(complete.wait(2))
        self.assertEqual([e['raw_message'] for e in self.events], ['[图片]', '这张图'])

    def test_private_chat_still_uses_existing_routing(self):
        with patch.object(self.bridge, '_push_slash_command', return_value=True) as command:
            self.bridge.add_to_buffer({'sessionId':'wxid_a','content':'/sid','sourceName':'用户'})
        self.assertFalse(command.call_args.args[2])
        self.assertTrue(self.bridge._native_messages.empty())


class NativeMentionTests(unittest.TestCase):
    def test_mentions_preserve_order_full_width_and_punctuation(self):
        segments=native_group_segments({'content':'前面 ＠小冰\u2005后面 @小冰！'},10000,['小冰'])
        self.assertEqual([s['type'] for s in segments], ['text','at','text','at','text'])
        self.assertEqual(''.join(s['data']['text'] for s in segments if s['type']=='text'), '前面 \u2005后面 ！')

    def test_false_metadata_and_prefix_names_are_not_bot_mentions(self):
        for data in ({'content':'@Botany 你好'}, {'content':'@Bot 你好','mentionedBot':False}, {'content':'普通消息'}):
            self.assertEqual(native_group_segments(data,10000,['Bot']), [{'type':'text','data':{'text':data['content']}}])

    def test_true_metadata_handles_changed_group_nickname(self):
        segments=native_group_segments({'content':'@群名片 在吗','mentionedBot':True},10000,[])
        self.assertEqual(segments[0], {'type':'at','data':{'qq':'10000'}})

    def test_nickname_regex_characters_are_literal(self):
        self.assertEqual(native_group_segments({'content':'@Bot+ 在吗'},10000,['Bot+'])[0]['type'],'at')
        self.assertEqual(native_group_segments({'content':'@Bottt 在吗'},10000,['Bot+'])[0]['type'],'text')
