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
from unittest.mock import MagicMock, Mock, patch, AsyncMock

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
    def test_all_direct_send_types_ignore_empty_unreadable_and_special_child_surfaces(self, _sleep):
        cases = (
            [],
            [Child('MMUIRenderSubWindowHW', visible=False)],
            [Child('Qt51514QWindowToolSaveBits')],
            [Child('Chrome_WidgetWin_0')],
            RuntimeError('UIA child enumeration unavailable'),
        )
        for children in cases:
            for method in ('send_text', 'send_image', 'send_file'):
                with self.subTest(children=repr(children), method=method):
                    sender, windows = direct_sender('群A')
                    window = windows[0]
                    window.GetChildren = (Mock(side_effect=children) if isinstance(children, Exception)
                                          else Mock(return_value=children))
                    with patch.dict(sys.modules, {'pyperclip': Mock()}), \
                            patch.object(uia_sender.os.path, 'isfile', return_value=True), \
                            patch.object(uia_sender.os.path, 'getsize', return_value=123), \
                            patch.object(sender, '_copy_image_to_clipboard'), \
                            patch.object(sender, '_copy_file_to_clipboard'), \
                            patch.object(sender, '_switch_contact', side_effect=AssertionError('must not search')):
                        self.assertTrue(getattr(sender, method)('群A', 'payload'))
                    self.assertEqual(sender._auto.keys, ['{Ctrl}v', '{Enter}'])
                    window.GetChildren.assert_not_called()


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

    def test_voice_audio_formats_default_and_live_update(self):
        result = self.run_config({}, """
import config, json, main
assert config.VOICE_AUDIO_FORMATS == ["mp3", "wav"]
main._apply_config({**config.config, "voice_audio_formats": ["WAV", ".mp3", "flac", "wav", "exe"]})
assert config.VOICE_AUDIO_FORMATS == ["wav", "mp3", "flac"]
print(json.dumps(config.VOICE_AUDIO_FORMATS))
""")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout.splitlines()[-1]), ["wav", "mp3", "flac"])

    def test_default_mode_is_off_and_legacy_private_behavior_is_unchanged(self):
        result = self.run_config({}, "import config; assert not config.UIA_DIRECT_WINDOW")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_standalone_direct_mode_needs_no_local_whitelist(self):
        result = self.run_config({'uia_direct_window': True}, 'import config; assert config.UIA_DIRECT_WINDOW')
        self.assertEqual(result.returncode, 0, result.stderr)


    def test_stale_filters_do_not_create_runtime_authorization(self):
        result = self.run_config({'uia_direct_window': True, 'group_reply_filter_mode': 'whitelist',
                                 'group_reply_filter_sessions': [], 'active_reply_whitelist': ['old']}, """
import config, main
assert config.UIA_DIRECT_WINDOW
assert not hasattr(config, 'GROUP_REPLY_FILTER_MODE')
assert not hasattr(config, 'is_direct_window_session_allowed')
main._apply_config({**config.config, 'group_reply_filter_mode': 'blacklist'})
assert config.UIA_DIRECT_WINDOW
assert not hasattr(config, 'GROUP_REPLY_FILTER_MODE')
""")
        self.assertEqual(result.returncode, 0, result.stderr)



class DirectWindowQueueTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.runtime = tempfile.TemporaryDirectory(prefix="bridge-send-media-test-")
        self.addCleanup(self.runtime.cleanup)
        self.config = types.SimpleNamespace(UIA_DIRECT_WINDOW=True, SEARCH_BY_WXID=True,
            RUNTIME_DIR=self.runtime.name, ASTRBOT_ATTACHMENTS='', VOICE_BUBBLE_ENABLED=False, VOICE_AUDIO_OUTPUT_DEVICE_ID='',
            VOICE_AUDIO_FORMATS=['mp3', 'wav'])
        self.state = types.SimpleNamespace(running=True, sender_instance=Mock(), _ob_private_id_to_session_id={123:'allowed'},
            _ob_id_to_contact={123:'会话标题'}, _ob_group_id_to_session_id={})
        with patch.dict(sys.modules, {'config':self.config,'state':self.state}):
            spec=importlib.util.spec_from_file_location('test_direct_ob_protocol',BRIDGE/'ob_protocol.py')
            self.protocol=importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.protocol)

    def test_direct_private_target_uses_title_not_wxid(self):
        self.assertEqual(self.protocol._resolve_reply_contact('send_private_msg',{'user_id':123})[2], '会话标题')
        self.config.UIA_DIRECT_WINDOW=False
        self.assertEqual(self.protocol._resolve_reply_contact('send_private_msg',{'user_id':123})[2], 'allowed')

    async def test_unresolved_private_and_group_targets_do_not_send(self):
        for action, is_group in [('send_private_msg',False),('send_group_msg',True),('upload_private_file',False),('upload_group_file',True)]:
            with patch.object(self.protocol,'_send_file_operation',new_callable=AsyncMock) as file:
                await self.protocol._process_send_request({'action':action,'params':{'message':'hello','file':'x'},
                    'contact':'target','session_id':'','is_group':is_group})
                file.assert_not_called()
        self.state.sender_instance.send_text.assert_not_called()

    async def test_shutdown_stops_remaining_operations(self):
        self.state.sender_instance.send_text.side_effect=lambda *args: setattr(self.state, "running", False) or True
        with patch.object(self.protocol,'_coalesce_message_operations',return_value=[('text','one'),('text','two')]):
            await self.protocol._process_send_request({'action':'send_private_msg','params':{},'contact':'会话标题','session_id':'allowed'})
        self.state.sender_instance.send_text.assert_called_once_with('会话标题','one')

    async def test_shutdown_during_file_download_prevents_send(self):
        def download(_):
            setattr(self.state, "running", False)
            return 'fake-file', None
        with patch.object(self.protocol, '_download_remote_file', side_effect=download), \
             patch.object(self.protocol.os.path, 'getsize', return_value=1):
            await self.protocol._process_send_request({'action':'upload_private_file',
                'params':{'file':'https://example.invalid/test'},'contact':'会话标题','session_id':'allowed'})
        self.state.sender_instance.send_file.assert_not_called()

    async def test_shutdown_during_image_decode_prevents_send(self):
        def decode(_):
            setattr(self.state, "running", False)
            return 'fake-image'
        with patch.object(self.protocol, '_decode_base64_image', side_effect=decode), \
             patch.object(self.protocol.os, 'unlink') as unlink:
            await self.protocol._process_send_request({'action':'send_private_msg',
                'params':{'message':[{'type':'image','data':{'file':'base64://test'}}]},
                'contact':'会话标题','session_id':'allowed'})
            unlink.assert_called_once_with('fake-image')
        self.state.sender_instance.send_image.assert_not_called()


    async def test_server_authorized_send_ignores_old_empty_whitelist(self):
        self.config.GROUP_REPLY_FILTER_MODE = 'whitelist'
        self.config.GROUP_REPLY_FILTER_SESSIONS = []
        for action, group in [('send_private_msg', False), ('send_group_msg', True)]:
            await self.protocol._process_send_request({'action': action, 'params': {'message': 'hello'},
                'contact': '会话标题', 'session_id': 'allowed', 'is_group': group})
        self.assertEqual(self.state.sender_instance.send_text.call_count, 2)

    async def test_queued_bot_reply_uses_captured_local_stop_epoch(self):
        self.state.bridge_instance = types.SimpleNamespace(local=types.SimpleNamespace(
            can_forward=lambda sid, epoch: sid == 'allowed' and epoch == 2))
        request = {'action': 'send_private_msg', 'params': {'message': 'hello'},
                   'contact': '会话标题', 'session_id': 'allowed', 'local_epoch': 1}
        await self.protocol._process_send_request(request)
        self.state.sender_instance.send_text.assert_not_called()
        await self.protocol._process_send_request({**request, 'local_epoch': 2})
        self.state.sender_instance.send_text.assert_called_once()

    def test_video_segment_keeps_video_operation_type(self):
        self.assertEqual(self.protocol._coalesce_message_operations([
            {"type": "video", "data": {"file": "C:/media/clip.mp4"}},
        ]), [("video", "C:/media/clip.mp4")])

    def test_record_and_voice_segments_are_routed_to_voice_bubbles(self):
        self.assertEqual(self.protocol._coalesce_message_operations([
            {"type": "record", "data": {"file": "https://example.invalid/answer.mp3"}},
            {"type": "voice", "data": {"url": "C:/audio/second.mp3"}},
        ]), [
            ("voice", "https://example.invalid/answer.mp3"),
            ("voice", "C:/audio/second.mp3"),
        ])

    def test_selected_audio_file_formats_become_voice_only_when_feature_enabled(self):
        message = [
            {"type": "file", "data": {"file": "C:/audio/answer.mp3"}},
            {"type": "file", "data": {"file": "C:/audio/answer.wav"}},
        ]
        self.config.VOICE_BUBBLE_ENABLED = False
        self.assertEqual(self.protocol._coalesce_message_operations(message), [("file", item["data"]["file"]) for item in message])
        self.config.VOICE_BUBBLE_ENABLED = True
        self.assertEqual(self.protocol._coalesce_message_operations(message), [("voice", item["data"]["file"]) for item in message])
        self.config.VOICE_AUDIO_FORMATS = ["wav"]
        self.assertEqual(self.protocol._coalesce_message_operations(message), [
            ("file", "C:/audio/answer.mp3"), ("voice", "C:/audio/answer.wav"),
        ])

    def test_local_video_file_survives_queue_cleanup_until_retention_expires(self):
        with tempfile.TemporaryDirectory(prefix="video-stage-source-") as folder:
            source = Path(folder) / "clip.mp4"
            source.write_bytes(b"mp4 payload")
            params = {"message": [{"type": "video", "data": {"file": str(source)}}]}
            cleanup_dirs = self.protocol._stage_local_files_in_params("send_private_msg", params)
            staged = Path(params["message"][0]["data"]["file"])
            self.assertNotEqual(str(staged), str(source))
            self.assertTrue(staged.is_file())
            stale_time = staged.parent.stat().st_mtime - self.protocol._SEND_MEDIA_RETENTION_SECONDS - 5
            os.utime(staged.parent, (stale_time, stale_time))

            self.protocol._cleanup_staged_files(cleanup_dirs)
            self.assertTrue(staged.is_file(), "WeChat may still be reading the staged video after Enter")

            expired_at = staged.parent.stat().st_mtime + self.protocol._SEND_MEDIA_RETENTION_SECONDS + 1
            self.protocol._cleanup_expired_send_media(now=expired_at)
            self.assertFalse(staged.exists())

    async def test_remote_download_uses_persistent_outgoing_media_directory(self):
        response = MagicMock()
        response.__enter__.return_value = response
        response.headers = {"Content-Length": "10", "Content-Type": "video/mp4"}
        response.url = "https://example.invalid/clip.mp4"
        response.iter_content.return_value = [b"mp4 payload"]
        with patch.object(self.protocol.requests, "get", return_value=response):
            file_path, temp_dir = await asyncio.to_thread(
                self.protocol._download_remote_file, "https://example.invalid/clip.mp4",
            )

        self.assertEqual(Path(temp_dir).parent, Path(self.config.RUNTIME_DIR) / "send_media")
        self.assertEqual(Path(file_path).read_bytes(), b"mp4 payload")
        self.protocol._cleanup_staged_files([temp_dir])
        self.assertTrue(Path(file_path).is_file())

    async def test_remote_video_file_is_not_deleted_when_uia_returns(self):
        temp_dir = Path(self.protocol._new_send_media_dir("astrwechat-file-"))
        staged = temp_dir / "clip.mp4"
        staged.write_bytes(b"mp4 payload")
        with patch.object(self.protocol, "_download_remote_file", return_value=(str(staged), str(temp_dir))):
            sent = await self.protocol._send_file_operation(
                "会话标题", "https://example.invalid/clip.mp4", media_label="Video",
                can_send=lambda: True,
            )
        self.assertTrue(sent)
        self.state.sender_instance.send_file.assert_called_once_with("会话标题", str(staged))
        self.assertTrue(staged.is_file(), "retain remote video until the upload safety window expires")

    def test_expired_cleanup_only_removes_astrwechat_send_folders(self):
        root = Path(self.protocol._send_media_root())
        expired = root / "astrwechat-stage-expired"
        unrelated = root / "keep-this-folder"
        expired.mkdir()
        unrelated.mkdir()
        (expired / "clip.mp4").write_bytes(b"old")
        expired_at = expired.stat().st_mtime + self.protocol._SEND_MEDIA_RETENTION_SECONDS + 1
        self.protocol._cleanup_expired_send_media(now=expired_at)
        self.assertFalse(expired.exists())
        self.assertTrue(unrelated.exists())

    async def test_wav_voice_send_uses_selected_device_and_rechecks_session_permission(self):
        import tempfile
        self.config.VOICE_BUBBLE_ENABLED = True
        self.config.VOICE_AUDIO_OUTPUT_DEVICE_ID = "selected-output-device"
        self.state.prepare_voice_audio = Mock(return_value=("c" * 32, ""))
        self.state.start_voice_audio = Mock(return_value=True)
        self.state.wait_voice_audio = Mock(return_value=(True, ""))
        self.state.cancel_voice_audio = Mock()
        with tempfile.TemporaryDirectory(prefix="voice-send-test-") as folder:
            path = Path(folder) / "answer.wav"
            path.write_bytes(b"fake wav payload")
            sent = await self.protocol._send_voice_operation(
                "会话标题", str(path), can_send=lambda: True,
            )
        self.assertTrue(sent)
        self.state.sender_instance.send_voice_file.assert_called_once()
        args = self.state.sender_instance.send_voice_file.call_args.args
        self.assertEqual(args[:3], ("会话标题", str(path), "selected-output-device"))
        self.assertEqual(args[4:], (
            self.state.prepare_voice_audio,
            self.state.start_voice_audio,
            self.state.wait_voice_audio,
            self.state.cancel_voice_audio,
        ))

    async def test_unselected_voice_audio_format_is_rejected_before_sender(self):
        self.config.VOICE_BUBBLE_ENABLED = True
        self.config.VOICE_AUDIO_FORMATS = ["mp3"]
        with tempfile.TemporaryDirectory(prefix="voice-format-test-") as folder:
            path = Path(folder) / "answer.flac"
            path.write_bytes(b"fake flac payload")
            sent = await self.protocol._send_voice_operation("会话标题", str(path))
        self.assertFalse(sent)
        self.state.sender_instance.send_voice_file.assert_not_called()


    async def test_over_60_second_voice_falls_back_to_regular_file_send(self):
        self.config.VOICE_BUBBLE_ENABLED = True
        self.config.VOICE_AUDIO_OUTPUT_DEVICE_ID = "selected-output-device"
        self.state.prepare_voice_audio = Mock(return_value=("request", "", ""))
        self.state.start_voice_audio = Mock(return_value=True)
        self.state.wait_voice_audio = Mock(return_value=(True, ""))
        self.state.cancel_voice_audio = Mock()
        self.state.sender_instance.send_voice_file.return_value = "voice_too_long"
        with tempfile.TemporaryDirectory(prefix="voice-fallback-test-") as folder:
            path = Path(folder) / "long-answer.mp3"
            path.write_bytes(b"fake mp3 payload")
            with patch.object(self.protocol, "_send_file_operation", new_callable=AsyncMock,
                              return_value=True) as send_file:
                sent = await self.protocol._send_voice_operation("会话标题", str(path), can_send=lambda: True)
        self.assertTrue(sent)
        self.state.sender_instance.send_voice_file.assert_called_once()
        send_file.assert_awaited_once_with("会话标题", str(path), media_label="Long audio", can_send=unittest.mock.ANY)
