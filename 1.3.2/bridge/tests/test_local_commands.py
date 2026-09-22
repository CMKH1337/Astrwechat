"""Local command integration tests. No WeChat UI, credentials or remote services."""
from pathlib import Path
import queue
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from local_commands import stable_uid, sender_identity, version
from local_media import AttachmentCache, exact_message, safe_name
from test_bridge_core import load_bridge_core, group_message, DummyTimer


class Sender:
    def __init__(self):
        self.sent = []
    def send_text(self, target, text):
        self.sent.append(("text", target, text))
        return True
    def send_image(self, target, path):
        self.sent.append(("image", target, Path(path).read_bytes()))
        return True
    def send_file(self, target, path):
        self.sent.append(("file", target, Path(path).name, Path(path).read_bytes()))
        return True


class LocalCommandFixture(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        self.core, self.config, self.state = load_bridge_core()
        self.config.config = {"local_command_admins": [{"uid": stable_uid("wxid_admin"), "note": "测试"}]}
        self.config.RUNTIME_DIR = self.root.name
        self.config.WE_FLOW_BASE_URL = "http://127.0.0.1:5031"
        self.config.ACCESS_TOKEN = "local-test-token"
        self.config.SEARCH_BY_WXID = False
        self.sender = Sender()
        self.bridge = self.core.WeFlowBridge(self.sender)
        self.local = self.bridge.local
        self.local._workers = lambda: None
        self.now = [1000.0]
        self.local.clock = self.local.cache.clock = lambda: self.now[0]
        self.local.sse_connected = True
        self.state._ob_ws_ready = threading.Event()
        self.state._ob_ws_ready.set()
        self.pushed = []
        self.core.push_event = lambda event: self.pushed.append(event) or True
        self.timer_patch = patch.object(self.core.threading, "Timer", DummyTimer)
        self.timer_patch.start()
        self.addCleanup(self.timer_patch.stop)
        self.addCleanup(self.bridge.close)
        self.counter = 0

    def message(self, content, sender="wxid_admin", group="group-a@chatroom", **extra):
        self.counter += 1
        data = group_message(group, sender, "管理员" if sender == "wxid_admin" else "用户", content)
        data.update(rawid=str(self.counter), serverId=str(self.counter), timestamp=int(self.now[0]), localType=1, event="message.new")
        data.update(extra)
        return data

    def receive(self, content, **extra):
        self.now[0] += 2
        data = self.message(content, **extra)
        self.bridge.add_to_buffer(data)
        return data

    def flush(self):
        while not self.local.outputs.empty():
            self.local.deliver(self.local.outputs.get_nowait())
        return self.sender.sent[-1][2] if self.sender.sent else ""

class LocalCommandTests(LocalCommandFixture):
    def test_uid_stable_across_private_group_and_names(self):
        group = self.message("#UID")
        other = dict(group, sessionId="other@chatroom", groupName="其他群", sourceName="改名")
        private = {"sessionId": "wxid_admin", "sessionType": "private"}
        self.assertEqual(stable_uid(sender_identity(group)), stable_uid(sender_identity(other)))
        self.assertEqual(stable_uid(sender_identity(group)), stable_uid(sender_identity(private)))
        self.assertEqual(stable_uid("WXID_ADMIN"), stable_uid("wxid_admin"))
        self.assertNotEqual(stable_uid("wxid_admin"), stable_uid("wxid_other"))
        self.assertEqual(version(), "1.3.2")

    def test_public_menu_uid_and_no_automatic_admin(self):
        self.config.config["local_command_admins"] = []
        self.receive("#aw")
        menu = self.flush()
        self.assertIn("AstrWeChat v1.3.2", menu)
        self.assertIn("#uid - 查看UID", menu)
        self.assertNotIn("#AW UID", menu)
        self.assertNotIn("#STOP", menu)
        self.receive("#uId")
        result = self.flush()
        self.assertTrue(result.startswith("#uid\n"))
        self.assertIn(stable_uid("wxid_admin"), result)
        self.assertIn("普通用户", result)
        self.receive("#STOP")
        self.assertIn("仅管理员", self.flush())
        self.assertFalse(self.local.is_paused("group-a@chatroom"))
        self.assertFalse(self.pushed)

    def test_status_exact_no_blank_line_and_actual_connection(self):
        self.receive("#status")
        self.assertEqual(self.flush(), "#status\n消息推送：正常\nAstrBot：已连接\n当前会话：测试群-group-a@chatroom\n回复模式：仅提及")
        self.state._ob_ws_ready.clear()
        self.receive("#STATUS")
        self.assertIn("AstrBot：未连接", self.flush())
        self.assertFalse(self.pushed)

    def test_uid_cannot_be_spoofed_by_nickname_or_group_id(self):
        self.receive("#STOP", sender="wxid_stranger", sourceName=stable_uid("wxid_admin"))
        self.assertIn("仅管理员", self.flush())
        self.receive("#STOP", senderUsername="", sourceName="wxid_admin")
        self.assertIn("无法识别", self.flush())
        self.receive("#STOP", senderUsername="group-a@chatroom")
        self.assertIn("无法识别", self.flush())
        self.assertFalse(self.local.paused)

    def test_group_filter_precedes_all_commands(self):
        self.config.GROUP_REPLY_FILTER_SESSIONS = ["group-a@chatroom"]
        self.receive("#UID")
        self.receive("#STOP")
        self.assertTrue(self.local.outputs.empty())
        self.assertFalse(self.local.paused)
        self.assertFalse(self.local.history)

    def test_namespace_consumed_unknown_and_invalid_arguments(self):
        self.receive("#AW UID")
        self.assertIn("#aw 仅用于显示菜单", self.flush())
        for text in ("#STOP now", "#AC ../../secret", "#AW\nSTATUS\nextra"):
            self.receive(text)
        self.assertEqual(len(self.pushed), 0)
        self.assertFalse(self.bridge.pending_buffers)
        self.assertFalse(self.bridge._group_context_history)
        self.assertFalse(self.local.history)
        self.assertEqual(self.local.outputs.qsize(), 3)

    def test_incidental_text_not_a_command_and_rich_card_cannot_execute(self):
        self.receive("今天讨论 #STOP 的功能")
        self.assertFalse(self.local.paused)
        self.receive("#AWAY")
        self.assertFalse(self.local.outputs.qsize())
        self.receive("#STOP", localType=49)
        self.assertFalse(self.local.paused)
        self.assertEqual(len(self.local.history["group-a@chatroom"]["messages"]), 2)

    def test_commands_and_own_replies_never_enter_any_context(self):
        self.receive("正常消息")
        self.receive("#STATUS")
        output = self.flush()
        self.receive(output)
        self.receive("对方撤回了一条消息 内容为“#STOP”", event="message.revoke")
        self.assertEqual(len(self.local.history["group-a@chatroom"]["messages"]), 1)
        self.assertEqual(self.bridge._group_context_history["group-a@chatroom"], ["管理员：正常消息"])
        self.assertFalse(self.pushed)

    def test_stop_is_session_scoped_start_does_not_replay(self):
        self.config.ACTIVE_REPLY_PROBABILITY = 1
        self.receive("旧消息")
        self.receive("其他群消息", group="group-b@chatroom")
        stale = self.bridge.pending_buffers["group-a@chatroom_wxid_admin"]
        self.receive("#STOP")
        self.assertIn("已暂停", self.flush())
        self.assertNotIn("group-a@chatroom_wxid_admin", self.bridge.pending_buffers)
        self.assertIn("group-b@chatroom_wxid_admin", self.bridge.pending_buffers)
        self.assertFalse(stale["timer"].started)
        self.receive("暂停期间消息")
        self.receive("#STATUS")
        self.assertIn("消息推送：已暂停", self.flush())
        self.receive("#AC")
        self.assertIn("暂停期间消息", self.flush())
        self.receive("#START")
        self.flush()
        self.assertNotIn("group-a@chatroom_wxid_admin", self.bridge.pending_buffers)
        self.receive("恢复后的消息")
        entry = self.bridge.pending_buffers["group-a@chatroom_wxid_admin"]
        self.bridge.process_sender("group-a@chatroom_wxid_admin", stale["timer_version"])
        self.assertFalse(self.pushed)
        self.bridge.process_sender("group-a@chatroom_wxid_admin", entry["timer_version"])
        self.assertIn("恢复后的消息", str(self.pushed))
        self.assertNotIn("暂停期间消息", str(self.pushed))

    def test_late_media_and_final_push_do_not_cross_stop_start_boundary(self):
        epoch = self.local.epoch("group-a@chatroom")
        self.receive("#STOP")
        self.receive("#START")
        self.bridge.add_text_to_buffer("group-a@chatroom", "管理员", "测试群", "group-a@chatroom", "旧附件", True, "old", local_epoch=epoch)
        self.assertNotIn("old", self.bridge.pending_buffers)
        called = []
        self.assertFalse(self.local.forward("group-a@chatroom", epoch, lambda: called.append(True)))
        self.assertFalse(called)

    def test_history_ten_order_group_isolation_revoke_voice_and_no_commands(self):
        for number in range(12):
            self.receive(f"消息{number}")
        self.receive("另一个群", group="group-b@chatroom")
        self.receive("对方撤回了一条消息", event="message.revoke")
        self.receive("#AW")
        self.receive("#UID")
        self.receive("#STATUS")
        self.receive("#AC")
        lines = self.flush().splitlines()
        self.assertEqual(lines[0], "Anti-Callback")
        self.assertEqual(len(lines), 11)
        self.assertEqual(lines[1], "管理员：消息2")
        self.assertEqual(lines[-1], "管理员：消息11")
        rendered = "\n".join(lines)
        self.assertNotIn("另一个群", rendered)
        self.assertNotIn("#AW", rendered)
        self.assertNotIn("#UID", rendered)
        self.assertNotIn("#STATUS", rendered)
        self.assertNotIn("#AC", rendered)
        self.receive("[语音]", localType=34)
        self.assertIn("[语音]", self.local.history_text("group-a@chatroom"))

    def test_history_not_recorded_until_admin_configured_and_expires(self):
        self.config.config["local_command_admins"] = []
        self.receive("不缓存")
        self.assertFalse(self.local.history)
        self.config.config["local_command_admins"] = [stable_uid("wxid_admin")]
        self.receive("现在缓存")
        self.now[0] += 86401
        self.assertIn("暂无", self.local.history_text("group-a@chatroom"))

    def test_private_ac_rejected_uid_routes_to_current_contact(self):
        data = {"sessionId": "wxid_admin", "sessionType": "private", "sourceName": "测试好友", "content": "#AC"}
        self.bridge.add_to_buffer(data)
        self.assertIn("仅支持群聊", self.flush())
        self.now[0] += 2
        self.config.SEARCH_BY_WXID = True
        data["content"] = "#UID"
        self.bridge.add_to_buffer(data)
        self.flush()
        self.assertEqual(self.sender.sent[-1][1], "wxid_admin")

    def test_queued_reply_rechecks_revoked_admin_and_group_permission(self):
        self.receive("#STATUS")
        self.config.config["local_command_admins"] = []
        self.flush()
        self.assertFalse(self.sender.sent)
        self.receive("#UID")
        self.config.GROUP_REPLY_FILTER_SESSIONS = ["group-a@chatroom"]
        self.flush()
        self.assertFalse(self.sender.sent)

    def test_attachment_code_on_same_line_only_after_cache_success(self):
        self.receive("资料.zip", localType=49, appMsgKind="file", fileName="资料.zip")
        session, code, event, record = self.local.media_jobs.get_nowait()
        self.assertIn("附件缓存中", self.local.history_text(session))
        self.assertNotIn("回溯码：", self.local.history_text(session))
        source = Path(self.root.name)/"资料.zip"
        source.write_bytes(b"test zip")
        self.local.cache._save(session, code, event, "file", {}, local_path=str(source))
        record["status"] = "ready"
        text = self.local.history_text(session)
        self.assertEqual(text, f"Anti-Callback\n管理员：[文件] 资料.zip ｜ 回溯码：{code}")
        source.unlink()  # Revoke/deletion of source must not destroy our own copy.
        self.receive(f"#AC {code}")
        self.flush()
        self.assertEqual(self.sender.sent[-1], ("file", "测试群-group-a@chatroom", "资料.zip", b"test zip"))
        for i in range(12):
            self.receive(f"新消息{i}")
        self.assertNotIn(code, self.local.history_text(session))
        self.receive(f"#AC {code}")
        self.flush()
        self.assertEqual(self.sender.sent[-1][0], "file")
        self.receive(f"#AC {code}", group="group-b@chatroom")
        self.assertIn("不属于当前群聊", self.flush())
        self.now[0] += 86401
        self.receive(f"#AC {code}")
        self.assertIn("附件已过期", self.flush())

    def test_same_name_distinct_ids_unique_codes_and_dedup(self):
        a = self.receive("same.zip", localType=49, fileName="same.zip")
        self.bridge.add_to_buffer(a)
        self.receive("same.zip", localType=49, fileName="same.zip")
        self.assertEqual(self.local.media_jobs.qsize(), 2)
        codes = [entry["code"] for entry in self.local.history["group-a@chatroom"]["messages"]]
        self.assertEqual(len(set(codes)), 2)

    def test_self_message_and_unknown_sender_cannot_authorize(self):
        self.receive("#STOP", isSend=1)
        self.assertFalse(self.local.paused)
        self.assertTrue(self.local.outputs.empty())

    def test_slash_command_passes_normally_but_not_while_paused(self):
        self.receive("/help")
        self.assertEqual(len(self.pushed), 1)
        self.receive("#STOP")
        self.receive("/help")
        self.assertEqual(len(self.pushed), 1)


class MediaFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = [0]
        self.config = types.SimpleNamespace(RUNTIME_DIR=self.temp.name, config={"ac_file_max_mb": 1, "ac_cache_max_mb": 1, "ac_cache_hours": 1}, ACCESS_TOKEN="test", WE_FLOW_BASE_URL="http://127.0.0.1:5031")
        self.cache = AttachmentCache(self.config, clock=lambda: self.now[0])
        self.addCleanup(self.cache.close)

class MediaTests(MediaFixture):
    def test_exact_ids_not_same_name_time_or_conflicting_ids(self):
        candidates = [{"serverId": "111", "localId": 1, "fileName": "same.zip", "createTime": 10}]
        self.assertIsNone(exact_message(candidates, {"serverId": "222", "localId": 1, "fileName": "same.zip", "timestamp": 10}))
        self.assertIsNone(exact_message(candidates, {"fileName": "same.zip", "timestamp": 10}))
        self.assertEqual(exact_message(candidates, {"serverId": "111"}), candidates[0])
        self.assertEqual(exact_message(candidates, {"localId": 1}), candidates[0])
        self.assertIsNone(exact_message([{**candidates[0], "sessionId": "b"}], {"serverId": "111", "sessionId": "a"}))

    def test_safe_filenames(self):
        self.assertEqual(safe_name('../../evil.zip', 'file.bin'), 'evil.zip')
        self.assertEqual(safe_name('C:\\folder\\same.zip', 'file.bin'), 'same.zip')
        self.assertEqual(safe_name('CON.txt', 'file.bin'), 'file.bin')
        self.assertEqual(safe_name('..', 'file.bin'), 'file.bin')

    def test_size_and_expiry_bounds(self):
        source = Path(self.temp.name)/'source.bin'
        source.write_bytes(b'x' * (1024 * 1024 + 1))
        with self.assertRaisesRegex(ValueError, '大小限制'):
            self.cache._save('a', 'AAAAAAAA', {}, 'file', {}, local_path=str(source))
        self.assertFalse(self.cache.entries)
        source.write_bytes(b'x' * (600 * 1024))
        self.cache._save('a', 'AAAAAAAA', {}, 'file', {}, local_path=str(source))
        with self.assertRaisesRegex(ValueError, '大小限制'):
            self.cache._save('a', 'BBBBBBBB', {}, 'file', {}, local_path=str(source))
        self.assertEqual(len(self.cache.entries), 1)
        self.now[0] = 3601
        self.cache.prune()
        self.assertFalse(self.cache.entries)
        self.assertFalse(list(Path(self.cache.directory.name).iterdir()))

    def test_partial_file_not_published(self):
        source = Path(self.temp.name)/'source.bin'
        source.write_bytes(b'partial')
        with self.assertRaisesRegex(ValueError, '完整下载'):
            self.cache._save('a', 'AAAAAAAA', {}, 'file', {'fileSize': 100}, local_path=str(source))
        self.assertFalse(self.cache.entries)

    def test_remote_media_rejected_without_token_leak(self):
        with patch('local_media.requests.get') as get:
            with self.assertRaisesRegex(ValueError, '非本地'):
                self.cache._save('a', 'AAAAAAAA', {}, 'image', {}, media_url='https://example.invalid/x')
            get.assert_not_called()
        self.assertFalse(self.cache.entries)

    def test_file_api_enables_file_export_and_strict_source_match(self):
        source = Path(self.temp.name)/'file.zip'
        source.write_bytes(b'archive')
        response = unittest.mock.MagicMock()
        response.__enter__.return_value = response
        response.json.return_value = {'messages': [{'serverId': '888', 'mediaSourcePath': str(source), 'fileName': 'file.zip', 'fileSize': 7}]}
        with patch('local_media.requests.get', return_value=response) as get:
            self.assertTrue(self.cache.store('a', 'AAAAAAAA', {'sessionId': 'a', 'serverId': '888', 'fileName': 'file.zip'}, 'file'))
            params = get.call_args.kwargs['params']
            self.assertEqual(params['file'], 'true')
            self.assertEqual(params['file_source_only'], 'true')
            self.assertEqual(params['server_id'], '888')
        self.assertTrue(self.cache.available('a', 'AAAAAAAA'))
        self.assertFalse(self.cache.available('b', 'AAAAAAAA'))


class AdditionalLocalTests(LocalCommandFixture):
    def test_long_history_splits_without_breaking_lines_or_echoing_to_server(self):
        for number in range(10):
            self.receive(f'{number}' + '字' * 950)
        self.receive('#AC')
        self.flush()
        self.assertGreater(len(self.sender.sent), 1)
        for operation in list(self.sender.sent):
            self.assertLessEqual(len(operation[2]), 1800)
            self.assertTrue(operation[2].startswith('Anti-Callback'))
            self.receive(operation[2])
        self.assertEqual(len(self.local.history['group-a@chatroom']['messages']), 10)
        self.assertFalse(self.pushed)

    def test_sse_commands_voices_and_revokes_use_unified_local_intake(self):
        import json
        self.state.running = True
        self.bridge.start_timestamp = 0
        events = [self.message('hello'), self.message('[语音]', localType=34), self.message('#STATUS')]
        response = unittest.mock.MagicMock()
        response.status_code = 200
        response.iter_lines.return_value = [f'data:{json.dumps(event, ensure_ascii=False)}' for event in events]
        with patch.object(self.core.requests, 'get', return_value=response):
            self.bridge.listen_sse()
        self.assertFalse(self.local.sse_connected)
        self.assertIsNone(self.bridge._sse_session)
        self.assertEqual(len(self.local.history['group-a@chatroom']['messages']), 2)
        self.assertEqual(self.local.outputs.qsize(), 1)
        self.assertFalse(self.pushed)

    def test_cache_recreated_on_restart_and_cleaned_on_close(self):
        source = Path(self.root.name)/'source.zip'
        source.write_bytes(b'zip')
        self.local.cache._save('group-a@chatroom', 'AAAAAAAA', {}, 'file', {}, local_path=str(source))
        directory = Path(self.local.cache.directory.name)
        self.assertTrue(directory.exists())
        self.bridge.close()
        self.assertFalse(directory.exists())
        replacement = self.core.WeFlowBridge(self.sender)
        try:
            self.assertFalse(replacement.local.paused)
            self.assertFalse(replacement.local.history)
            self.assertFalse(replacement.local.cache.available('group-a@chatroom', 'AAAAAAAA'))
        finally:
            replacement.close()


class IntegrityTests(MediaFixture):
    def test_md5_mismatch_does_not_publish_wrong_same_name_file(self):
        source = Path(self.temp.name)/'same.zip'
        source.write_bytes(b'wrong')
        with self.assertRaisesRegex(ValueError, '校验失败'):
            self.cache._save('a', 'AAAAAAAA', {'fileMd5': '0' * 32}, 'file', {}, local_path=str(source))
        self.assertFalse(self.cache.entries)

    def test_downward_quota_change_prunes_existing_files(self):
        self.config.config['ac_cache_max_mb'] = 3
        source = Path(self.temp.name)/'same.zip'
        source.write_bytes(b'x' * (600 * 1024))
        self.cache._save('a', 'AAAAAAAA', {}, 'file', {}, local_path=str(source))
        self.cache._save('a', 'BBBBBBBB', {}, 'file', {}, local_path=str(source))
        self.config.config['ac_cache_max_mb'] = 1
        self.cache.prune()
        self.assertFalse(self.cache.available('a', 'AAAAAAAA'))
        self.assertTrue(self.cache.available('a', 'BBBBBBBB'))



class DirectWindowLocalCommandTests(LocalCommandFixture):
    def setUp(self):
        super().setUp()
        self.config.UIA_DIRECT_WINDOW = True
        self.config.GROUP_REPLY_FILTER_MODE = 'whitelist'
        self.config.GROUP_REPLY_FILTER_SESSIONS = ['group-a@chatroom', 'wxid_admin']
        self.config.is_direct_window_session_allowed = lambda sid: (
            self.config.GROUP_REPLY_FILTER_MODE == 'whitelist'
            and sid in self.config.GROUP_REPLY_FILTER_SESSIONS)

    def test_local_private_uses_title_despite_search_by_wxid(self):
        self.config.SEARCH_BY_WXID = True
        self.bridge.add_to_buffer({'sessionId':'wxid_admin', 'sessionType':'private', 'sourceName':'测试好友', 'content':'#UID'})
        self.flush()
        self.assertEqual(self.sender.sent[-1][1], '测试好友')

    def test_unlisted_private_command_never_enqueues_or_sends(self):
        self.bridge.add_to_buffer({'sessionId':'wxid_other', 'sessionType':'private', 'sourceName':'其他好友', 'content':'#UID'})
        self.flush()
        self.assertFalse(self.sender.sent)
        self.assertFalse(self.pushed)

    def test_queued_private_command_respects_removed_session(self):
        self.bridge.add_to_buffer({'sessionId':'wxid_admin', 'sessionType':'private', 'sourceName':'测试好友', 'content':'#UID'})
        self.config.GROUP_REPLY_FILTER_SESSIONS.clear()
        self.flush()
        self.assertFalse(self.sender.sent)


if __name__ == '__main__':
    unittest.main()
