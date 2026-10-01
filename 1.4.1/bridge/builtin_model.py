"""Built-in replies: Pydantic AI handles the wire formats; Bridge owns policy."""
import asyncio
import base64
import inspect
import io
import logging
import os
from pathlib import Path
import queue
import re
import sys
import threading
import time
from collections import OrderedDict
from urllib.parse import urlsplit
from builtin_context import Transcripts
from model_limits import limits, fit_turns, model_metadata
from reply_segments import ReplySegments
from model_errors import ModelFailure, classify_model_error

log = logging.getLogger('builtin-model')
PROTOCOLS = {'responses', 'chat_completions', 'anthropic_messages'}


def validate_model_config(raw):
    if raw.get('builtin_protocol', 'chat_completions') not in PROTOCOLS:
        raise ValueError('不支持的模型接口格式')
    key, model = str(raw.get('builtin_api_key') or ''), str(raw.get('builtin_model') or '').strip()
    if not model or not key.strip() or any(ord(c) < 32 for c in key):
        raise ValueError('请填写模型名称和有效的 API Key')
    url = str(raw.get('builtin_base_url') or '').strip()
    try:
        parsed = urlsplit(url)
        _ = parsed.port
        if (parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username
                or parsed.password or parsed.query or parsed.fragment or any(c.isspace() for c in url)):
            raise ValueError()
        if parsed.scheme == 'http' and parsed.hostname not in ('localhost', '127.0.0.1', '::1'):
            raise ValueError()
        if parsed.path.rstrip('/').lower().endswith(('/chat/completions', '/responses', '/messages')):
            raise ValueError()
    except ValueError:
        raise ValueError('请填写 HTTPS 或本机 HTTP API 基础地址，不要填写完整接口路径') from None
    try:
        if not 5 <= float(raw.get('builtin_timeout_seconds', 60)) <= 300:
            raise ValueError()
    except (TypeError, ValueError):
        raise ValueError('请求超时必须在 5 到 300 秒之间') from None


def _model_vendor_path():
    """Select only wheels matching this interpreter; never mix CPython ABIs."""
    import platform

    root = Path(__file__).resolve().parent / 'vendor'
    if (sys.platform != 'win32' or sys.implementation.name != 'cpython'
            or sys.maxsize <= 2 ** 32 or platform.machine().lower() not in ('amd64', 'x86_64')):
        return None
    major, minor = sys.version_info[:2]
    versioned = root / f'cp{major}{minor}-win_amd64'
    if versioned.is_dir():
        return versioned
    # Retain the existing 3.10 layout for older packages and developer checkouts.
    if (major, minor) == (3, 10) and root.is_dir():
        return root
    return None


def load_sdk():
    vendor = _model_vendor_path()
    if vendor is not None and str(vendor) not in sys.path:
        sys.path.insert(0, str(vendor))
        log.info('内置模型依赖目录：%s', vendor)
    os.environ.setdefault('PYDANTIC_AI_NO_BANNER', '1')
    import pydantic_ai
    return pydantic_ai


def build_agent(raw):
    validate_model_config(raw)
    sdk = load_sdk()
    import httpx2
    from openai import AsyncOpenAI
    from anthropic import AsyncAnthropic
    from pydantic_ai.models.openai import OpenAIChatModel, OpenAIResponsesModel
    from pydantic_ai.models.anthropic import AnthropicModel
    from pydantic_ai.providers.openai import OpenAIProvider
    from pydantic_ai.providers.anthropic import AnthropicProvider
    protocol = raw.get('builtin_protocol', 'chat_completions')
    url, key, model = (str(raw[k]).strip() for k in ('builtin_base_url', 'builtin_api_key', 'builtin_model'))
    timeout = float(raw.get('builtin_timeout_seconds', 60))
    # Do not retry billable model calls automatically or forward keys through HTTP redirects.
    client_args = dict(api_key=key, base_url=url, max_retries=0, timeout=timeout,
                       http_client=httpx2.AsyncClient(timeout=timeout, follow_redirects=False))
    if protocol == 'anthropic_messages':
        transport = AnthropicModel(model, provider=AnthropicProvider(anthropic_client=AsyncAnthropic(**client_args)))
    else:
        provider = OpenAIProvider(openai_client=AsyncOpenAI(**client_args))
        transport = (OpenAIResponsesModel if protocol == 'responses' else OpenAIChatModel)(model, provider=provider)
    return sdk.Agent(transport, system_prompt=str(raw.get('builtin_system_prompt') or ''), retries=0)


def safe_text(value):
    return re.sub(r'(?m)^\[本机文件路径\][^\r\n]*\r?\n?', '', str(value or '')).strip()


def sdk_history(turns, system_prompt):
    from pydantic_ai.messages import ModelRequest, ModelResponse, UserPromptPart, TextPart, SystemPromptPart
    history = [ModelRequest(parts=[UserPromptPart(content=safe_text(text))]) if role == 'user'
               else ModelResponse(parts=[TextPart(content=text)]) for role, text in turns]
    if history and system_prompt:
        history.insert(0, ModelRequest(parts=[SystemPromptPart(content=system_prompt)]))
    return history


async def async_request_reply(agent, text, turns, timeout, system_prompt='', images=(), max_tokens=2048):
    prompt = [text, *images] if images else text
    result = await asyncio.wait_for(agent.run(prompt, message_history=sdk_history(turns, system_prompt),
                        model_settings={'timeout': timeout, 'max_tokens': max_tokens, 'openai_store': False}), timeout)
    return str(result.output).strip()


def request_reply(agent, text, turns, timeout, system_prompt='', max_tokens=2048):
    # Compatibility helper for offline tests; production owns one persistent event loop.
    return agent.run_sync(text, message_history=sdk_history(turns, system_prompt),
                          model_settings={'timeout': timeout, 'max_tokens': max_tokens, 'openai_store': False}).output.strip()


def image_inputs(segments):
    from pydantic_ai.messages import BinaryContent
    from PIL import Image
    results, total = [], 0
    for segment in segments:
        if segment.get('type') != 'image' or len(results) >= 4:
            continue
        value = str(segment.get('data', {}).get('file', ''))
        if not value.startswith('base64://') or len(value) > 12 * 1024 * 1024:
            continue  # Never let model inputs fetch arbitrary URLs/local filesystem paths.
        try:
            data = base64.b64decode(value[9:], validate=True)
            with Image.open(io.BytesIO(data)) as image:
                fmt = str(image.format).lower()
                if fmt not in ('png', 'jpeg', 'gif', 'webp') or image.width * image.height > 20_000_000:
                    continue
                image.verify()
            if total + len(data) > 16 * 1024 * 1024:
                break
            total += len(data)
            results.append(BinaryContent(data=data, media_type=f'image/{fmt}'))
        except Exception:
            continue
    return results


def strip_bot_mentions(text, nicknames):
    """Remove standalone bot mentions, not other members, emails or nickname prefixes."""
    names = sorted({name.strip() for name in nicknames if isinstance(name, str) and name.strip()},
                   key=len, reverse=True)
    if not names:
        return str(text or '').strip()
    aliases = '|'.join(re.escape(name) for name in names)
    pattern = (rf'(?<![\w@＠])[@＠](?:{aliases})'
               r'(?=$|[\s\u200b，。！？、；：,.!?;:…（）()\[\]{}「」『』“”‘’])'
               r'(?:[^\S\r\n]|\u200b)*')
    return re.sub(pattern, '', str(text or '')).strip()


class BuiltinReplies:
    def __init__(self, bridge, raw, *, agent=None):
        self.bridge = bridge
        self.agent = agent if agent is not None else build_agent(raw)
        self.timeout = float(raw.get('builtin_timeout_seconds', 60))
        self.system_prompt = str(raw.get('builtin_system_prompt') or '')
        self.send_images = raw.get('builtin_send_images') is True and model_metadata(raw).get('vision') is not False
        self.send_errors = raw.get('builtin_send_errors') is True
        self.input_budget, self.max_tokens = limits(raw)
        try:
            self.context_rounds = max(1, min(1000, int(raw.get('builtin_context_rounds', 50) or 50)))
        except (TypeError, ValueError):
            self.context_rounds = 50
        self.segments = ReplySegments(raw)
        self.error_notice_attempts = OrderedDict()
        self.jobs = queue.Queue(maxsize=32)
        self.transcripts = Transcripts(max_turns=4000, max_content=256000)
        self.required_turns = 1
        self.closed = threading.Event()
        self.worker = threading.Thread(target=self._run, daemon=True, name='builtin-replies')
        self.worker.start()

    def observe(self, data, is_group):
        session = self.bridge._normalize_session_id(data)
        if is_group:
            import config
            # Clean before recording history, but keep the original event for routing/@ detection.
            data = dict(data, content=strip_bot_mentions(data.get('content'), config.BOT_NICKNAMES))
        return self.transcripts.observe(session, data, is_group)

    def close(self):
        self.closed.set()
        self.transcripts.clear()
        # A pending request is cancelled by the worker's 100ms permission poll.

    def clear_session(self, session):
        self.transcripts.clear(session)

    def submit(self, session, contact, is_group, trigger_ids, epoch, generation, media=()):
        if self.closed.is_set() or not trigger_ids:
            return False
        try:
            self.jobs.put_nowait((session, contact, is_group, tuple(trigger_ids), epoch, generation, list(media)))
            return True
        except queue.Full:
            log.warning('%s', ModelFailure('E_MODEL_QUEUE_FULL').description)
            return False

    async def _request(self, turns, media, allowed):
        images = image_inputs(media) if self.send_images else []
        turns = fit_turns(turns, self.system_prompt, self.input_budget, len(images), self.required_turns)
        task = asyncio.create_task(async_request_reply(self.agent, turns[-1][1], turns[:-1],
                                       self.timeout, self.system_prompt, images, self.max_tokens))
        try:
            while not task.done():
                if not allowed():
                    return None
                await asyncio.wait({task}, timeout=0.1)
            return await task
        finally:
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    def _send_text(self, session, contact, is_group, text, allowed):
        import config
        if not allowed():
            return False
        target = session if (not is_group and config.SEARCH_BY_WXID and not config.UIA_DIRECT_WINDOW) else contact
        method = self.bridge.sender.send_text
        if 'can_send' in inspect.signature(method).parameters:
            return method(target, text, can_send=allowed)
        return allowed() and method(target, text)

    def _send_reply(self, session, contact, is_group, reply, allowed, reply_to=0, *, llm=True):
        try:
            parts = self.segments.split(reply, llm=llm)
        except Exception:
            log.warning('[E_REPLY_SEGMENT] 分段规则执行失败或超时，本次按原文整条发送')
            parts = [reply]
        if not parts:
            log.info('[E_REPLY_FILTERED] 回复内容已被过滤，不发送空消息')
            return True
        delivered = []
        try:
            for index, part in enumerate(parts):
                if index and not self.segments.wait(self.segments.delay(parts[index - 1]), allowed, self.closed):
                    return False
                if not llm:
                    local = self.bridge.local
                    with local.lock:
                        if not allowed():
                            return False
                        local.echoes[(session, part.strip())] = local.clock()
                        while len(local.echoes) > 256:
                            local.echoes.popitem(last=False)
                if not self._send_text(session, contact, is_group, part, allowed):
                    return False
                delivered.append(part)
            return True
        finally:
            # Record only confirmed delivered pieces, even when later sends are cancelled.
            if llm and delivered:
                self.transcripts.replied_if_present(session, '\n'.join(delivered), reply_to)

    def _handle_model_failure(self, failure, session, contact, is_group, allowed, error=None):
        # Log fixed descriptions, numeric HTTP status and class only, never provider body/headers.
        log.warning('%s 异常类型：%s', failure.description, type(error).__name__ if error else '-')
        if not self.send_errors or not allowed():
            return
        now = time.monotonic()
        previous = self.error_notice_attempts.get(session)
        if previous is not None and now - previous < 60:
            log.info('错误码通知已限频：同一会话 60 秒内最多发送一次')
            return
        # Count attempts, including uncertain/failed sends; never retry a potentially sent message.
        self.error_notice_attempts[session] = now
        self.error_notice_attempts.move_to_end(session)
        while len(self.error_notice_attempts) > 128:
            self.error_notice_attempts.popitem(last=False)
        text = failure.notice
        try:
            # Prevent echoed local notices from becoming another model request.
            local = self.bridge.local
            with local.lock:
                if not allowed():
                    return
                local.echoes[(session, text.strip())] = local.clock()
                while len(local.echoes) > 256:
                    local.echoes.popitem(last=False)
            sent = self._send_reply(session, contact, is_group, text, allowed, llm=False)
            if sent:
                log.info('错误码通知已发送：%s', failure.code)
            elif allowed():
                log.warning('%s', ModelFailure('E_ERROR_NOTIFY_SEND').description)
        except Exception as send_error:
            log.warning('%s 异常类型：%s', ModelFailure('E_ERROR_NOTIFY_SEND').description,
                        type(send_error).__name__)
        # Error notices never enter the model's assistant history.

    def _run(self):
        import config
        import state
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            while not self.closed.is_set():
                try:
                    job = self.jobs.get(timeout=0.1)
                except queue.Empty:
                    continue
                session, contact, is_group, ids, epoch, generation, media = job
                try:
                    def allowed():
                        return (not self.closed.is_set() and state.running and state.paused.is_set()
                                and generation == state.reply_generation
                                and self.bridge.local.can_forward(session, epoch)
                                and config.is_direct_window_session_allowed(session)
                                and (not is_group or config.is_group_reply_allowed(session)))
                    if not allowed():
                        continue
                    try:
                        turns, self.required_turns = self.transcripts.snapshot(
                            session, ids, self.context_rounds, is_group,
                            max_chars=max(24000, min(self.input_budget, 256000)), required=True)
                        if not turns or turns[-1][0] != 'user':
                            continue
                        log.info('[内置模型] 正在请求模型 [%s|%s]', '群' if is_group else '私', contact)
                        reply = loop.run_until_complete(self._request(turns, media, allowed))
                    except asyncio.CancelledError:
                        log.info('[内置模型] 本次回复已取消 [%s|%s]', '群' if is_group else '私', contact)
                        continue
                    except Exception as error:
                        self._handle_model_failure(classify_model_error(error), session, contact,
                                                   is_group, allowed, error)
                        continue
                    if not allowed() or reply is None:
                        log.info('[内置模型] 本次回复已取消 [%s|%s]', '群' if is_group else '私', contact)
                        continue
                    if not reply.strip():
                        self._handle_model_failure(ModelFailure('E_MODEL_EMPTY'), session, contact,
                                                   is_group, allowed)
                        continue
                    log.info('[内置模型] 已收到模型回复 [%s|%s]', '群' if is_group else '私', contact)
                    try:
                        sent = self._send_reply(session, contact, is_group, reply, allowed, max(ids))
                    except Exception as error:
                        log.warning('%s 异常类型：%s', ModelFailure('E_WECHAT_SEND').description,
                                    type(error).__name__)
                        continue
                    # The shared UiaSender already logs each confirmed segment as [UIA✓].
                    # Do not emit another success line (including filtered/empty replies).
                    if not sent:
                        if allowed():
                            log.warning('%s', ModelFailure('E_WECHAT_SEND').description)
                        else:
                            log.info('[内置模型] 本次回复已取消 [%s|%s]', '群' if is_group else '私', contact)
                except Exception as error:
                    log.warning('%s 异常类型：%s', ModelFailure('E_BRIDGE_PROCESS').description,
                                type(error).__name__)
                finally:
                    self.jobs.task_done()
        finally:
            client = getattr(getattr(self.agent, 'model', None), 'client', None)
            if client is not None:
                try:
                    loop.run_until_complete(client.close())
                except Exception:
                    pass
            loop.close()
            while True:
                try:
                    self.jobs.get_nowait()
                    self.jobs.task_done()
                except queue.Empty:
                    break
