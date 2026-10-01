"""Direct-window routing tests. No real UI, clipboard, networking or messages."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch, AsyncMock

from test_uia_sender import Child, detection_sender
import uia_sender

BRIDGE = Path(__file__).resolve().parents[1]


def direct_sender(*names):
    windows = [Child('Qt51514QWindowIcon', name=name, pid=123, hwnd=100+i)
               for i, name in enumerate(names)]
    for window in windows:
        window.GetChildren = Mock(return_value=[Child('MMUIRenderSubWindowHW')])
    sender = detection_sender(windows)
    sender.direct_window = True
    def activate(hwnd):
        sender._native.window_info(hwnd)['iconic'] = False
        sender._native.foreground.return_value = hwnd
        return True
    sender._native.activate.side_effect = activate
    return sender, windows


class DirectWindowTests(unittest.TestCase):
    def test_selects_exact_window_among_four_chats(self):
        sender, windows = direct_sender('群A', '群B', '群C', '群D')
        self.assertTrue(sender._ensure_window('群C'))
        self.assertIs(sender._window, windows[2])
        self.assertEqual(sender._hwnd, 102)
        self.assertEqual(sender._auto.keys, [])

    def test_missing_duplicate_blank_and_partial_title_are_rejected(self):
        for names, target in [(('群A',), '群'), (('群A',), '群B'), (('群A', '群A'), '群A'), (('群A',), '')]:
            with self.subTest(names=names, target=target):
                sender, _ = direct_sender(*names)
                self.assertFalse(sender._ensure_window(target))
                self.assertEqual(sender._auto.keys, [])

    def test_does_not_reuse_cached_chat_when_title_changes(self):
        sender, windows = direct_sender('群A', '群B')
        self.assertTrue(sender._ensure_window('群A'))
        windows[0].Name = '群C'
        sender._native.window_info(100)['title'] = '群C'
        self.assertFalse(sender._ensure_window('群A'))
        self.assertEqual(sender._hwnd, 0)
        self.assertTrue(sender._ensure_window('群B'))
        self.assertEqual(sender._hwnd, 101)

    def test_rejects_foreign_process_hidden_owned_and_stale_uia(self):
        for change in ('foreign', 'hidden', 'owned', 'pid', 'title'):
            with self.subTest(change=change):
                sender, windows = direct_sender('群A')
                info = sender._native.window_info(100)
                if change == 'foreign': sender._native.process_image.return_value = r'C:\other.exe'
                if change == 'hidden': info['visible'] = False
                if change == 'owned': info['owner'] = 99
                if change == 'pid': windows[0].ProcessId = 999
                if change == 'title': info['title'] = '群B'
                self.assertFalse(sender._ensure_window('群A'))

    @patch.object(uia_sender.time, 'sleep')
    def test_minimized_chat_restores_selected_hwnd_only(self, _sleep):
        sender, _ = direct_sender('群A', '群B')
        sender._native.window_info(101)['iconic'] = True
        self.assertTrue(sender._ensure_window('群B'))
        self.assertTrue(sender._activate())
        self.assertTrue(sender._guard_direct_target('群B'))
        sender._native.activate.assert_called_once_with(101)

    @patch.object(uia_sender.time, 'sleep')
    def test_all_send_types_skip_search_and_send_only_paste_enter(self, _sleep):
        for method in ('send_text', 'send_image', 'send_file'):
            with self.subTest(method=method):
                sender, _ = direct_sender('群A', '群B')
                clip = Mock()
                with patch.dict(sys.modules, {'pyperclip': clip}), \
                     patch.object(uia_sender.os.path, 'isfile', return_value=True), \
                     patch.object(uia_sender.os.path, 'getsize', return_value=123), \
                     patch.object(sender, '_copy_image_to_clipboard'), \
                     patch.object(sender, '_copy_file_to_clipboard'), \
                     patch.object(sender, '_switch_contact', side_effect=AssertionError('must not search')):
                    self.assertTrue(getattr(sender, method)('群B', 'payload'))
                self.assertEqual(sender._auto.keys, ['{Ctrl}v', '{Enter}'])
                self.assertEqual(sender._hwnd, 101)

    @patch.object(uia_sender.time, 'sleep')
    def test_missing_or_duplicate_target_never_touches_clipboard(self, _sleep):
        for names in [('群A',), ('群B', '群B')]:
            for method in ('send_text', 'send_image', 'send_file'):
                sender, _ = direct_sender(*names)
                clip = Mock()
                with patch.dict(sys.modules, {'pyperclip': clip}), \
                     patch.object(uia_sender.os.path, 'isfile', return_value=True), \
                     patch.object(sender, '_copy_image_to_clipboard') as image, \
                     patch.object(sender, '_copy_file_to_clipboard') as file:
                    self.assertFalse(getattr(sender, method)('群B', 'payload'))
                clip.copy.assert_not_called()
                image.assert_not_called()
                file.assert_not_called()
                self.assertEqual(sender._auto.keys, [])

    @patch.object(uia_sender.time, 'sleep')
    def test_focus_loss_after_paste_prevents_enter(self, _sleep):
        sender, _ = direct_sender('群A')
        def key(key):
            sender._auto.keys.append(key)
            sender._native.foreground.return_value = 999
        sender._auto.SendKeys = key
        with patch.dict(sys.modules, {'pyperclip': Mock()}):
            self.assertFalse(sender.send_text('群A', 'payload'))
        self.assertEqual(sender._auto.keys, ['{Ctrl}v'])

    @patch.object(uia_sender.time, 'sleep')
    def test_title_change_before_paste_prevents_keys(self, _sleep):
        sender, _ = direct_sender('群A')
        clip = Mock()
        clip.copy.side_effect = lambda _: sender._native.window_info(100).update(title='群B')
        with patch.dict(sys.modules, {'pyperclip': clip}):
            self.assertFalse(sender.send_text('群A', 'payload'))
        self.assertEqual(sender._auto.keys, [])

    @patch.object(uia_sender.time, 'sleep')
    def test_search_and_web_surfaces_block_sending(self, _sleep):
        for class_name in (uia_sender.UiaSender.SEARCH_POPUP_CLASS, 'Chrome_WidgetWin_0'):
            sender, windows = direct_sender('群A')
            windows[0].GetChildren.return_value = [Child(class_name)]
            with patch.dict(sys.modules, {'pyperclip': Mock()}):
                self.assertFalse(sender.send_text('群A', 'payload'))
            self.assertEqual(sender._auto.keys, [])


class DirectWindowConfigTests(unittest.TestCase):
    def run_config(self, changes, code):
        with tempfile.TemporaryDirectory(prefix='direct-window-config-') as tmp:
            raw = json.loads((BRIDGE.parent/'shared/bridge-default-config.json').read_text(encoding='utf-8'))
            raw.update(changes)
            p = Path(tmp)/'config.json'
            p.write_text(json.dumps(raw), encoding='utf-8')
            return subprocess.run([sys.executable, '-B', '-c', code], cwd=tmp,
                env={**os.environ, 'WEFLOW_BRIDGE_CONFIG':str(p), 'PYTHONPATH':str(BRIDGE), 'PYTHONUTF8':'1'},
                capture_output=True, text=True, encoding='utf-8', timeout=10)

    def test_default_mode_is_off_and_legacy_private_behavior_is_unchanged(self):
        result = self.run_config({}, "import config; assert not config.UIA_DIRECT_WINDOW; assert config.is_direct_window_session_allowed('any')")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_standalone_rejects_direct_mode_without_whitelist(self):
        result = self.run_config({'uia_direct_window':True}, 'import config')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('白名单', result.stderr)

    def test_whitelist_covers_private_unknown_empty_and_removed_sessions(self):
        result = self.run_config({'uia_direct_window':True, 'group_reply_filter_mode':'whitelist',
            'group_reply_filter_sessions':['group@chatroom','wxid_friend']}, """
import config
assert config.is_direct_window_session_allowed('GROUP@chatroom')
assert config.is_direct_window_session_allowed('wxid_friend')
assert not config.is_direct_window_session_allowed('')
assert not config.is_direct_window_session_allowed('unknown')
config.GROUP_REPLY_FILTER_SESSIONS=[]
assert not config.is_direct_window_session_allowed('wxid_friend')
config.GROUP_REPLY_FILTER_MODE='blacklist'
assert not config.is_direct_window_session_allowed('group@chatroom')
""")
        self.assertEqual(result.returncode, 0, result.stderr)


class DirectWindowQueueTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.config = types.SimpleNamespace(UIA_DIRECT_WINDOW=True, SEARCH_BY_WXID=True,
            GROUP_REPLY_FILTER_MODE='whitelist', GROUP_REPLY_FILTER_SESSIONS=['allowed'],
            is_group_reply_allowed=lambda sid: sid in self.config.GROUP_REPLY_FILTER_SESSIONS,
            is_direct_window_session_allowed=lambda sid: sid in self.config.GROUP_REPLY_FILTER_SESSIONS)
        self.state = types.SimpleNamespace(sender_instance=Mock(), _ob_private_id_to_session_id={123:'allowed'},
            _ob_id_to_contact={123:'会话标题'}, _ob_group_id_to_session_id={})
        with patch.dict(sys.modules, {'config':self.config,'state':self.state}):
            spec=importlib.util.spec_from_file_location('test_direct_ob_protocol',BRIDGE/'ob_protocol.py')
            self.protocol=importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.protocol)

    def test_direct_private_target_uses_title_not_wxid(self):
        self.assertEqual(self.protocol._resolve_reply_contact('send_private_msg',{'user_id':123})[2], '会话标题')
        self.config.UIA_DIRECT_WINDOW=False
        self.assertEqual(self.protocol._resolve_reply_contact('send_private_msg',{'user_id':123})[2], 'allowed')

    async def test_private_and_group_file_sends_outside_whitelist_are_blocked(self):
        for action, is_group in [('send_private_msg',False),('send_group_msg',True),('upload_private_file',False),('upload_group_file',True)]:
            with patch.object(self.protocol,'_send_file_operation',new_callable=AsyncMock) as file:
                await self.protocol._process_send_request({'action':action,'params':{'message':'hello','file':'x'},
                    'contact':'target','session_id':'unknown','is_group':is_group})
                file.assert_not_called()
        self.state.sender_instance.send_text.assert_not_called()

    async def test_removed_session_stops_remaining_operations(self):
        self.state.sender_instance.send_text.side_effect=lambda *args: self.config.GROUP_REPLY_FILTER_SESSIONS.clear() or True
        with patch.object(self.protocol,'_coalesce_message_operations',return_value=[('text','one'),('text','two')]):
            await self.protocol._process_send_request({'action':'send_private_msg','params':{},'contact':'会话标题','session_id':'allowed'})
        self.state.sender_instance.send_text.assert_called_once_with('会话标题','one')

    async def test_permission_revoked_during_file_download_prevents_send(self):
        def download(_):
            self.config.GROUP_REPLY_FILTER_SESSIONS.clear()
            return 'fake-file', None
        with patch.object(self.protocol, '_download_remote_file', side_effect=download), \
             patch.object(self.protocol.os.path, 'getsize', return_value=1):
            await self.protocol._process_send_request({'action':'upload_private_file',
                'params':{'file':'https://example.invalid/test'},'contact':'会话标题','session_id':'allowed'})
        self.state.sender_instance.send_file.assert_not_called()

    async def test_permission_revoked_during_image_decode_prevents_send(self):
        def decode(_):
            self.config.GROUP_REPLY_FILTER_SESSIONS.clear()
            return 'fake-image'
        with patch.object(self.protocol, '_decode_base64_image', side_effect=decode), \
             patch.object(self.protocol.os, 'unlink') as unlink:
            await self.protocol._process_send_request({'action':'send_private_msg',
                'params':{'message':[{'type':'image','data':{'file':'base64://test'}}]},
                'contact':'会话标题','session_id':'allowed'})
            unlink.assert_called_once_with('fake-image')
        self.state.sender_instance.send_image.assert_not_called()
