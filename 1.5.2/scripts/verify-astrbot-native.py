"""Offline contract check against official AstrBot source, without starting AstrBot/WeChat.

Usage: python -B scripts/verify-astrbot-native.py --source-dir tmp/astrbot-reference
Source files: adapter.py, waking_check.py, group_chat_context.py, whitelist_check.py (AstrBot v4.28.2).
Real upstream methods are executed; framework objects and network APIs are lightweight test doubles.
"""
import argparse
import ast
import asyncio
import collections
import copy
import datetime
import hashlib
import itertools
import json
import logging
from pathlib import Path
import random
import sys
import time
import types
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT/'bridge/tests'), str(ROOT/'bridge')]
from test_astrbot_native import NativeGroupTests


class Component:
    def __init__(self, **kwargs): self.__dict__.update(kwargs)


class Event(dict):
    __getattr__ = dict.get


class Member:
    def __init__(self, user_id, nickname): self.user_id, self.nickname = user_id, nickname


class Group:
    def __init__(self, group_id): self.group_id = group_id


class Message:
    def __init__(self): self.type = self.sender = self.group_id = None


class ParsedEvent:
    def __init__(self, message):
        self.message_obj = message
        self.message_str = message.message_str
        self.is_at_or_wake_command = self.is_wake = False
        kind, session = ('GroupMessage', message.group_id) if message.type == 'group' else ('FriendMessage', message.sender.user_id)
        self.unified_msg_origin = f'wechat:{kind}:{session}'
        self.role = 'member'
        self.stopped = False
        self.extra = {}
    def get_message_type(self): return self.message_obj.type
    def get_messages(self): return self.message_obj.message
    def get_self_id(self): return self.message_obj.self_id
    def get_group_id(self): return self.message_obj.group_id
    def is_private_chat(self): return self.message_obj.type == 'private'
    def get_platform_name(self): return 'aiocqhttp'
    def stop_event(self): self.stopped = True
    def set_extra(self, key, value): self.extra[key] = value


async def no_api(**kwargs): return {}


def namespace():
    ns = dict(itertools=itertools, time=time, random=random, uuid=uuid,
              datetime=datetime, logger=logging.getLogger('astrbot-contract'),
              AstrBotMessage=Message, MessageMember=Member, Group=Group,
              MessageType=types.SimpleNamespace(GROUP_MESSAGE='group', FRIEND_MESSAGE='private'),
              ActionFailed=type('ActionFailed', (Exception,), {}))
    for name in ['Plain','At','AtAll','Image','File','Face','Forward','Json','Record','Reply','Video']:
        ns[name] = type(name, (Component,), {})
    ns['ComponentTypes'] = {'text':ns['Plain'],'at':ns['At'],'image':ns['Image']}
    return ns


def extract(tree, method):
    return copy.deepcopy(next(n for n in ast.walk(tree) if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name==method))


def execute(node, ns):
    module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0),node],type_ignores=[])
    exec(compile(ast.fix_missing_locations(module),'official_astrbot_source','exec'),ns)
    return ns[node.name]


async def verify(directory):
    sources = {n:(directory/n).read_bytes() for n in ('adapter.py','waking_check.py','group_chat_context.py','whitelist_check.py')}
    trees = {n:ast.parse(b.decode('utf-8-sig')) for n,b in sources.items()}
    ns = namespace()
    initialize_whitelist = execute(extract(trees['whitelist_check.py'],'initialize'), ns)
    check_whitelist = execute(extract(trees['whitelist_check.py'],'process'), ns)
    convert = execute(extract(trees['adapter.py'],'_convert_handle_message_event'), ns)
    decide = execute(extract(trees['group_chat_context.py'],'need_active_reply'), ns)
    format_message = execute(extract(trees['group_chat_context.py'],'_format_message'), ns)
    record = execute(extract(trees['group_chat_context.py'],'handle_message'), ns)
    execute(extract(trees['group_chat_context.py'],'_trim_left'), ns)
    # Execute the unmodified wake-prefix/At/Reply portion; skip unrelated plugin dispatch.
    process = extract(trees['waking_check.py'],'process')
    def assignment(n,name):
        return isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id==name for t in n.targets)
    start = next(i for i,n in enumerate(process.body) if assignment(n,'wake_prefixes'))
    end = next(i for i,n in enumerate(process.body) if assignment(n,'activated_handlers'))
    wake_node = ast.parse('async def wake(self, event):\n    pass').body[0]
    wake_node.body = process.body[start:end]
    wake = execute(wake_node,ns)
    waking = types.SimpleNamespace(ctx=types.SimpleNamespace(astrbot_config={'wake_prefix':['/']}),
                                   ignore_at_all=False,friend_message_needs_wake_prefix=False)
    adapter = types.SimpleNamespace(bot=types.SimpleNamespace(call_action=no_api))
    settings = dict(enable_active_reply=True, ar_method='possibility_reply', ar_possibility=0.1,
                    ar_whitelist=[], image_caption=False, group_message_max_cnt=1000)
    locks = {}
    context = types.SimpleNamespace(cfg=lambda e:settings, raw_records=collections.defaultdict(collections.deque),
                                   _record_ids=collections.defaultdict(collections.deque),
                                   _get_lock=lambda umo:locks.setdefault(umo,asyncio.Lock()))
    context._format_message = types.MethodType(format_message,context)
    fixture=NativeGroupTests()
    fixture.setUp()
    checks=[]
    try:
        for text in ['普通消息','@Bot 在吗','/sid']:
            fixture.receive(text)
        fixture.drain()
        parsed=[]
        for envelope in fixture.events:
            message=await convert(adapter,Event(envelope))
            event=ParsedEvent(message)
            await wake(waking,event)
            parsed.append(event)
        ordinary,mention,command=parsed
        whitelist = types.SimpleNamespace()
        config = {'platform_settings': {'enable_id_white_list': True, 'id_whitelist': ['different'],
                   'wl_ignore_admin_on_group': False, 'wl_ignore_admin_on_friend': False, 'id_whitelist_log': False}}
        private_message = await convert(adapter, Event(fixture.protocol.make_message_event(
            'private', 20001, [{'type':'text','data':{'text':'private hello'}}], nickname='friend')))
        private = ParsedEvent(private_message)
        for candidate in (ordinary, private):
            for ids, enabled, blocked in [(['different'], True, True), ([candidate.unified_msg_origin], True, False),
                                          ([], True, False), (['different'], False, False)]:
                config['platform_settings'].update(id_whitelist=ids, enable_id_white_list=enabled)
                await initialize_whitelist(whitelist, types.SimpleNamespace(astrbot_config=config))
                candidate.stopped = False
                await check_whitelist(whitelist, candidate)
                assert candidate.stopped is blocked, (ids, enabled, blocked)
        config['platform_settings'].update(id_whitelist=[ordinary.get_group_id()], enable_id_white_list=True)
        await initialize_whitelist(whitelist, types.SimpleNamespace(astrbot_config=config))
        ordinary.stopped = False
        await check_whitelist(whitelist, ordinary)
        assert not ordinary.stopped
        checks.append('official session whitelist allows group/private UMO and group ID; blocks unmatched sessions')
        checks.append('empty or disabled AstrBot whitelist follows native allow-through behavior')
        config['platform_settings'].update(id_whitelist=['different'], wl_ignore_admin_on_group=True, wl_ignore_admin_on_friend=True)
        await initialize_whitelist(whitelist, types.SimpleNamespace(astrbot_config=config))
        for candidate in (ordinary, private):
            candidate.role, candidate.stopped = 'admin', False
            await check_whitelist(whitelist, candidate)
            assert not candidate.stopped
            candidate.role = 'member'
        checks.append('native administrator whitelist exemptions remain controlled by AstrBot')
        assert not ordinary.is_at_or_wake_command
        assert mention.is_at_or_wake_command and command.is_at_or_wake_command
        assert command.message_str=='sid'
        checks.append('official adapter + wake rules distinguish ordinary / real @ / sid')
        for value,expected in [(0.05,True),(0.9,False)]:
            with patch.object(random,'random',return_value=value) as draw:
                assert await decide(context,ordinary) is expected
                draw.assert_called_once()
        checks.append('possibility_reply is drawn by AstrBot with probability 0.1')
        for event in [mention,command]:
            with patch.object(random,'random') as draw:
                assert not await decide(context,event)
                draw.assert_not_called()
        checks.append('real mentions and commands bypass probability')
        for whitelist,expected in [(['different-session'],False),([ordinary.unified_msg_origin],True),([ordinary.get_group_id()],True)]:
            settings['ar_whitelist']=whitelist
            with patch.object(random,'random',return_value=0):
                assert await decide(context,ordinary) is expected
        checks.append('AstrBot whitelist accepts UMO/group ID and rejects other groups')
        settings.update(enable_active_reply=False,ar_whitelist=[])
        with patch.object(random,'random') as draw:
            assert not await decide(context,ordinary)
            draw.assert_not_called()
        checks.append('disabling native active reply suppresses ordinary-message replies')
        for event in parsed:
            await record(context,event)
        entries=context.raw_records[ordinary.unified_msg_origin]
        assert len(entries)==3
        assert '普通消息' in entries[0] and 'DIRECTED AT YOU' not in entries[0]
        assert 'DIRECTED AT YOU' in entries[1]
        assert all('_group_context_record_id' in e.extra for e in parsed)
        checks.append('official group context records separate messages and marks real mentions only')
        with patch.object(fixture.bridge,'_fetch_wechat_image',return_value='fake.png'), \
                patch.object(fixture.bridge,'_make_image_segment',return_value={'type':'image','data':{'file':'base64://AA=='}}):
            fixture.receive('[图片]')
            fixture.drain()
        image=ParsedEvent(await convert(adapter,Event(fixture.events[-1])))
        await record(context,image)
        assert '[Image]' in context.raw_records[image.unified_msg_origin][-1]
        checks.append('image segment reaches native group context')
    finally:
        fixture.doCleanups()
    result={'reference':'AstrBot v4.28.2','passed':True,'checks':checks,
            'source_sha256':{n:hashlib.sha256(b).hexdigest() for n,b in sources.items()},
            'scope':'Official methods with framework/network doubles; no live service or messages.'}
    print(json.dumps(result,ensure_ascii=False,indent=2))


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--source-dir',type=Path,required=True)
    args=parser.parse_args()
    asyncio.run(verify(args.source_dir))
