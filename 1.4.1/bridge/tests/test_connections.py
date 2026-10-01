"""Local-only WS tests. No database, credentials, model calls or UIA sends."""
import asyncio
import importlib.util
import json
import os
import subprocess
import tempfile
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

import websockets

BRIDGE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BRIDGE))
from connection_config import resolve_connection


class ProfileTests(unittest.TestCase):
    def test_legacy_and_selected_tokens(self):
        self.assertEqual(resolve_connection({'astrbot_ob_token': ' old '}),
                         ('astrbot', 'AstrBot', 'ws://127.0.0.1:11229/ws', 'old'))
        self.assertEqual(resolve_connection({'bot_backend': 'kourichat', 'astrbot_ob_token': 'old', 'kourichat_ob_token': 'new'})[-1], 'new')

    def test_defaults_match_shared_json(self):
        raw = json.loads((BRIDGE.parent/'shared/bridge-default-config.json').read_text(encoding='utf-8'))
        for backend in ('astrbot', 'kourichat'):
            self.assertEqual(resolve_connection({'bot_backend': backend})[2], raw[f'{backend}_ob_url'])

    def test_invalid_active_but_inactive_draft_allowed(self):
        for config in [{'bot_backend': 'invalid'}, {'astrbot_ob_url': ''}, {'astrbot_ob_url': 'http://localhost'},
                       {'astrbot_ob_url': 'ws://user:pw@localhost'}, {'astrbot_ob_url': 'ws://localhost:99999'},
                       {'astrbot_ob_token': 'a\nb'}]:
            with self.assertRaises(ValueError): resolve_connection(config)
        resolve_connection({'kourichat_ob_url': ''})


class ClientTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fake_config = types.SimpleNamespace(OB_URL='', OB_TOKEN='local-test-token', OB_LABEL='KouriChat', BOT_BACKEND='kourichat')
        state_spec = importlib.util.spec_from_file_location('test_bridge_state', BRIDGE/'state.py')
        self.state = importlib.util.module_from_spec(state_spec)
        state_spec.loader.exec_module(self.state)
        self.state.running = True
        self.state.ob_client_generation = 1
        self.state._self_id_int = 123456
        self.actions = []
        async def handle(data):
            self.actions.append(data)
            await self.state._ob_ws.send(json.dumps({'status': 'ok', 'retcode': 0, 'data': {}, 'echo': data.get('echo')}))
        modules = {'config': self.fake_config, 'state': self.state, 'ob_protocol': types.SimpleNamespace(_handle_ob_api=handle)}
        with patch.dict(sys.modules, modules):
            spec = importlib.util.spec_from_file_location('test_ob_client', BRIDGE/'ob_client.py')
            self.client = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.client)
        async def retry(generation, seconds=0.02):
            await asyncio.sleep(0.02)
            return self.client._client_is_active(generation)
        self.client._retry_delay = retry
        self.task = None

    async def asyncTearDown(self):
        self.state.running = False
        self.state.ob_client_generation += 1
        if self.state._ob_ws:
            await self.state._ob_ws.close()
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)

    async def wait_for(self, condition):
        async def poll():
            while not condition(): await asyncio.sleep(0.01)
        await asyncio.wait_for(poll(), 3)

    async def start(self, server):
        self.fake_config.OB_URL = f'ws://127.0.0.1:{server.sockets[0].getsockname()[1]}/ws'
        self.task = asyncio.create_task(self.client._ob_client_main(1))

    async def test_reverse_ws_headers_event_upload_and_action_echo(self):
        result = asyncio.get_running_loop().create_future()
        async def handler(ws):
            try:
                self.assertEqual(ws.request.headers.get('Authorization'), 'Bearer local-test-token')
                self.assertEqual(ws.request.headers.get('X-Self-ID'), '123456')
                self.assertEqual(ws.request.headers.get('X-Client-Role'), 'Universal')
                event = json.loads(await ws.recv())
                self.assertEqual(event['post_type'], 'message')
                self.assertEqual(event['message'][0]['data']['text'], 'synthetic incoming text')
                for action in ('send_private_msg', 'send_group_msg'):
                    await ws.send(json.dumps({'action': action, 'params': {'message': [{'type':'text','data':{'text':'synthetic reply'}}]}, 'echo': action}))
                    self.assertEqual(json.loads(await ws.recv())['echo'], action)
                result.set_result(True)
                await ws.wait_closed()
            except Exception as error:
                if not result.done(): result.set_exception(error)
        async with websockets.serve(handler, '127.0.0.1', 0) as server:
            await self.start(server)
            await self.wait_for(lambda: self.state._ob_ws_ready.is_set())
            await self.state._ob_ws.send(json.dumps({'post_type':'message','message_type':'private','user_id':42,'message':[{'type':'text','data':{'text':'synthetic incoming text'}}]}))
            await asyncio.wait_for(result, 3)
            self.assertEqual(len(self.actions), 2)
            await self.asyncTearDown()

    async def test_authentication_close_is_reported_without_token_leak(self):
        seen = []
        self.state.set_status_callback(lambda: seen.append((self.state.ob_state, self.state.ob_error)))
        async def handler(ws): await ws.close(code=4001, reason='unauthorized')
        async with websockets.serve(handler, '127.0.0.1', 0) as server:
            await self.start(server)
            await self.wait_for(lambda: any('鉴权失败' in error for _, error in seen))
            self.assertNotIn('local-test-token', str(seen))
            await self.asyncTearDown()

    async def test_disconnect_reconnects_but_invalidated_generation_never_reconnects(self):
        attempts = []
        async def handler(ws):
            attempts.append(ws)
            if len(attempts) == 1: await ws.close()
            else: await ws.wait_closed()
        async with websockets.serve(handler, '127.0.0.1', 0) as server:
            await self.start(server)
            await self.wait_for(lambda: len(attempts) >= 2 and self.state._ob_ws_ready.is_set())
            self.state.ob_client_generation += 1
            await self.state._ob_ws.close()
            await asyncio.wait_for(self.task, 2)
            count = len(attempts)
            await asyncio.sleep(0.1)
            self.assertEqual(len(attempts), count)


    async def test_http_authentication_failure_is_visible(self):
        seen = []
        self.state.set_status_callback(lambda: seen.append((self.state.ob_state, self.state.ob_error)))
        async def deny(connection, request): return connection.respond(401, 'unauthorized')
        async def handler(ws): await ws.wait_closed()
        async with websockets.serve(handler, '127.0.0.1', 0, process_request=deny) as server:
            await self.start(server)
            await self.wait_for(lambda: any('鉴权失败' in error for _, error in seen))
            self.assertFalse(self.state._ob_ws_ready.is_set())
            await self.asyncTearDown()

    async def test_empty_token_does_not_send_authorization(self):
        self.fake_config.OB_TOKEN = ''
        self.fake_config.OB_LABEL = 'AstrBot'
        observed = asyncio.get_running_loop().create_future()
        async def handler(ws):
            observed.set_result(ws.request.headers.get('Authorization'))
            await ws.wait_closed()
        async with websockets.serve(handler, '127.0.0.1', 0) as server:
            await self.start(server)
            self.assertIsNone(await asyncio.wait_for(observed, 3))
            await self.asyncTearDown()


class ConfigPathTests(unittest.TestCase):
    def test_python_loads_user_config_and_writes_log_outside_install_directory(self):
        with tempfile.TemporaryDirectory(prefix="astrwechat-user-config-") as tmp:
            root = Path(tmp)
            data = root / "user data"
            data.mkdir()
            script_dir = root / "read only install"
            script_dir.mkdir()
            selected = data / "config.json"
            raw = json.loads((BRIDGE.parent / "shared/bridge-default-config.json").read_text(encoding="utf-8"))
            raw.update(bot_wxid="wxid_test_user", astrbot_ob_token="test-A", kourichat_ob_token="test-K")
            selected.write_text("\ufeff" + json.dumps(raw), encoding="utf-8")
            env = {**os.environ, "WEFLOW_BRIDGE_CONFIG": str(selected), "PYTHONPATH": str(BRIDGE), "PYTHONDONTWRITEBYTECODE": "1"}
            result = subprocess.run([sys.executable, "-B", "-c", "import config, json; print(json.dumps({'wxid':config.BOT_WXID,'path':config.CONFIG_FILE,'runtime':config.RUNTIME_DIR,'token':config.OB_TOKEN}))"], cwd=script_dir, env=env, capture_output=True, text=True, timeout=10, check=True)
            loaded = json.loads(result.stdout)
            self.assertEqual(loaded['wxid'], 'wxid_test_user')
            self.assertEqual(loaded['token'], 'test-A')
            self.assertEqual(Path(loaded['path']), selected)
            self.assertEqual(Path(loaded['runtime']), data)
            self.assertTrue((data / 'bridge.log').is_file())
            self.assertFalse((script_dir / 'config.json').exists())
            self.assertFalse((script_dir / 'bridge.log').exists())
