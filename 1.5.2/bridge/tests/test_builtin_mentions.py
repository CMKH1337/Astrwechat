"""Bot-mention removal changes model text, not incoming events or reply routing."""
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from builtin_context import Transcripts
from builtin_model import BuiltinReplies, strip_bot_mentions


class MentionTextTests(unittest.TestCase):
    def test_ascii_fullwidth_wechat_spaces_and_repeated_aliases(self):
        for text in ('@小冰 hi', '＠小冰 hi', '@小冰\u2005hi', '@小冰\u2009hi',
                     '@小冰\u200bhi', '@小冰\t hi', '@小冰 @冰姐 hi', '@小冰\nhi'):
            with self.subTest(text=text):
                self.assertEqual(strip_bot_mentions(text, ['小冰', '冰姐']), 'hi')

    def test_other_members_nickname_prefixes_and_email_are_preserved(self):
        for text in ('@小冰冰 hi', '@小冰2 hi', '@小红 hi', 'user@小冰.example',
                     'other@example.com', '普通消息里提到小冰', '@everyone hi'):
            with self.subTest(text=text):
                self.assertEqual(strip_bot_mentions(text, ['小冰']), text)
        self.assertEqual(strip_bot_mentions('@小冰 @小红 hi', ['小冰']), '@小红 hi')

    def test_middle_and_trailing_mentions_preserve_body_and_line_breaks(self):
        self.assertEqual(strip_bot_mentions('hello @小冰 hi', ['小冰']), 'hello hi')
        self.assertEqual(strip_bot_mentions('hi @小冰', ['小冰']), 'hi')
        self.assertEqual(strip_bot_mentions('第一行\n@小冰 第二行\n第三行', ['小冰']),
                         '第一行\n第二行\n第三行')

    def test_aliases_are_literal_longest_first_and_empty_aliases_are_ignored(self):
        self.assertEqual(strip_bot_mentions('@Bot.v2 hi', ['Bot', 'Bot.v2']), 'hi')
        self.assertEqual(strip_bot_mentions('@BotXv2 hi', ['Bot.v2']), '@BotXv2 hi')
        self.assertEqual(strip_bot_mentions('@小冰 hi', ['', '  ', None]), '@小冰 hi')
        self.assertEqual(strip_bot_mentions('@小冰', ['小冰']), '')


class MentionTranscriptTests(unittest.TestCase):
    def setUp(self):
        self.replies = BuiltinReplies.__new__(BuiltinReplies)
        self.replies.bridge = types.SimpleNamespace(_normalize_session_id=lambda data: data['sessionId'])
        self.replies.transcripts = Transcripts()
        self.config = types.SimpleNamespace(BOT_NICKNAMES=['小冰', '冰姐'])
        self.session = 'group@chatroom'

    def observe(self, text, is_group=True):
        event = {'sessionId': self.session, 'senderName': '用户甲', 'senderUsername': 'wxid_test',
                 'timestamp': 'test-time', 'content': text}
        before = dict(event)
        with patch.dict(sys.modules, {'config': self.config}):
            identity = self.replies.observe(event, is_group)
        self.assertEqual(event, before)
        return identity

    def test_body_is_clean_but_sender_metadata_and_history_are_preserved(self):
        first = self.observe('@小冰 hi')
        self.replies.transcripts.replied(self.session, '你好', first)
        second = self.observe('＠冰姐\u2005再来一句')
        turns = self.replies.transcripts.snapshot(self.session, [second], 10, True)
        self.assertEqual([role for role, _ in turns], ['user', 'assistant', 'user'])
        self.assertEqual([text.split('\n', 1)[-1] for _, text in turns], ['hi', '你好', '再来一句'])
        metadata = json.loads(turns[0][1].split('\n', 1)[0])
        self.assertEqual(metadata['sender'], '用户甲')
        self.assertEqual(metadata['sender_id'], 'wxid_test')
        self.assertEqual(metadata['time'], 'test-time')

    def test_private_messages_are_not_changed(self):
        identity = self.observe('@小冰 hi', is_group=False)
        turns = self.replies.transcripts.snapshot(self.session, [identity], 0, False)
        self.assertEqual(turns, [('user', '@小冰 hi')])

    def test_hot_updated_aliases_are_used_without_restarting_worker(self):
        self.config.BOT_NICKNAMES = ['新昵称']
        identity = self.observe('@新昵称 hi')
        turns = self.replies.transcripts.snapshot(self.session, [identity], 0, True)
        self.assertEqual(turns[0][1].split('\n', 1)[-1], 'hi')


if __name__ == '__main__':
    unittest.main()
