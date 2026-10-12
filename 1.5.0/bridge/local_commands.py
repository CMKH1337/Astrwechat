"""Local-only command routing, stable administrator IDs and recent group history."""
from collections import OrderedDict, deque
import hashlib
import json
import logging
import os
from pathlib import Path
import queue
import re
import threading
import time
import unicodedata

from local_media import AttachmentCache

log = logging.getLogger("ob11-bridge")
MENU_COMMAND = re.compile(r"^#aw(?:\s|$)", re.IGNORECASE)
DIRECT_COMMAND = re.compile(r"^#(uid|status|stop|start|ac)(?:\s|$)", re.IGNORECASE)
UID_PATTERN = re.compile(r"^AW-[A-F0-9]{24}$")


def stable_uid(identity):
    """Never hash display names or a group session into an administrator identity."""
    identity = str(identity or "").strip().casefold()
    return "AW-" + hashlib.sha256(("astrwechat:user:v1:" + identity).encode()).hexdigest()[:24].upper() if identity else ""


def clean_contact_name(value):
    """Normalize a displayed chat name without changing its visible wording."""
    name = unicodedata.normalize("NFKC", str(value or ""))
    name = name.replace("\u200b", "").replace("\ufeff", "").strip()
    return re.sub(r"\s*\(\s*\d+\s*\)\s*$", "", name).strip()


def is_group(data):
    return data.get("sessionType") == "group" or bool(data.get("groupName")) or "@chatroom" in session_id(data)


def session_id(data):
    return str(data.get("sessionId") or data.get("talkerId") or "").strip().casefold()


def sender_identity(data):
    if data.get("isSend") in (True, 1, "1"):
        return ""  # Own messages are not command input in this version.
    if is_group(data):
        identity = str(data.get("senderUsername") or "").strip()
        return identity if identity and "@chatroom" not in identity else ""
    identity = str(data.get("sessionId") or data.get("talkerId") or "").strip()
    return identity if identity and "@chatroom" not in identity else ""


def version():
    supplied = os.environ.get("ASTRWECHAT_VERSION", "").strip()
    if supplied:
        return supplied
    try:
        return str(json.loads((Path(__file__).resolve().parent.parent / "package.json").read_text(encoding="utf-8-sig"))["version"])
    except (OSError, ValueError, KeyError):
        return "未知"


class LocalCommands:
    def __init__(self, bridge, config, state, clock=time.time):
        self.bridge, self.config, self.state, self.clock = bridge, config, state, clock
        self.lock = threading.RLock()
        self.paused = set()
        self.epochs = {}
        self.history = OrderedDict()
        self.seen = OrderedDict()
        self.codes = {}  # code -> immutable message digest; never rebound during a run
        self.cooldowns = OrderedDict()
        self.echoes = OrderedDict()
        self.cache = AttachmentCache(config, clock)
        self.outputs = queue.Queue(maxsize=64)
        self.media_jobs = queue.Queue(maxsize=64)
        self.closed = threading.Event()
        self.workers_started = False
        self.sse_connected = False

    def settings(self):
        return getattr(self.config, "config", {})

    def admins(self):
        entries = self.settings().get("local_command_admins", [])
        if not isinstance(entries, list):
            return set()
        values = (str(item.get("uid", "") if isinstance(item, dict) else item).strip().upper() for item in entries[:100])
        return {uid for uid in values if UID_PATTERN.fullmatch(uid)}

    def is_admin(self, data):
        uid = stable_uid(sender_identity(data))
        return bool(uid and uid in self.admins())

    def epoch(self, session):
        with self.lock:
            return self.epochs.get(str(session).strip().casefold(), 0)

    def is_paused(self, session):
        with self.lock:
            return str(session).strip().casefold() in self.paused

    def can_forward(self, session, epoch=None):
        with self.lock:
            session = str(session).strip().casefold()
            return not self.closed.is_set() and session not in self.paused and (epoch is None or epoch == self.epochs.get(session, 0))

    def forward(self, session, epoch, callback):
        # Serialize the stop boundary with the final outbound push, not just intake.
        with self.lock:
            if not self.can_forward(session, epoch):
                return False
            return callback()

    def _workers(self):
        with self.lock:
            if self.workers_started or self.closed.is_set():
                return
            self.workers_started = True
            for target, name in ((self._output_worker, "aw-local-send"), (self._media_worker, "aw-local-cache")):
                threading.Thread(target=target, name=name, daemon=True).start()

    def reply(self, data, text, admin=False, code=None):
        self._workers()
        try:
            self.outputs.put_nowait((dict(data), text, admin, code))
        except queue.Full:
            log.warning("[AW] 本地回复队列已满，已丢弃回复；不会转发至服务端")

    def _contact(self, data):
        if (not is_group(data) and getattr(self.config, "SEARCH_BY_WXID", False)
                and not getattr(self.config, "UIA_DIRECT_WINDOW", False)):
            return str(data.get("sessionId") or data.get("talkerId") or "")
        name = data.get("groupName") if is_group(data) else data.get("sourceName") or ""
        return clean_contact_name(name) if is_group(data) else str(name).strip()

    def _output_worker(self):
        ole = None
        try:
            if os.name == "nt":
                import ctypes
                ole = ctypes.windll.ole32
                ole.CoInitialize(None)
            self._output_loop()
        finally:
            if ole is not None:
                ole.CoUninitialize()

    def _output_loop(self):
        while not self.closed.is_set():
            try:
                task = self.outputs.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                self.deliver(task)
            except Exception:
                log.exception("[AW] 本地回复发送失败")
            finally:
                self.outputs.task_done()

    def deliver(self, task):
        data, text, admin, code = task
        if self.closed.is_set() or not self.bridge._is_group_reply_allowed(data) or (admin and not self.is_admin(data)):
            return
        sender, contact = self.bridge.sender, self._contact(data)
        if not sender or not contact:
            log.warning("[AW] 无法确定本地回复目标，已拒绝发送")
            return
        if code:
            result = self.cache.send(session_id(data), code, sender, contact)
            if result:
                return
            text = "附件已过期、已清理或不属于当前群聊。" if result is None else "附件发送失败，请稍后重试。"
        # Keep long history replies bounded and never split an attachment line/code.
        parts, current = [], ""
        for line in text.splitlines():
            if current and len(current) + len(line) + 1 > 1800:
                parts.append(current)
                current = "Anti-Callback 续\n" if text.startswith("Anti-Callback\n") else ""
            current += ("\n" if current and not current.endswith("\n") else "") + line
        if current:
            parts.append(current)
        for part in parts:
            if self.closed.is_set() or not self.bridge._is_group_reply_allowed(data) or (admin and not self.is_admin(data)):
                return
            # SSE already excludes self messages; retain a scoped fallback for text echoes.
            with self.lock:
                key = (session_id(data), part.strip())
                self.echoes[key] = self.clock()
                while len(self.echoes) > 256:
                    self.echoes.popitem(last=False)
            if not sender.send_text(contact, part):
                log.warning("[AW] 本地文字回复发送失败")
                return

    def _media_worker(self):
        while not self.closed.is_set():
            try:
                session, code, event, record = self.media_jobs.get(timeout=1)
            except queue.Empty:
                try:
                    self.cache.prune()
                except OSError:
                    log.warning("[AW] 清理附件缓存失败")
                continue
            try:
                if not self.admins() or not self.bridge._is_group_reply_allowed(event):
                    record["status"] = "附件未缓存"
                    continue
                ok = self.cache.store(session, code, event, record["kind"])
                record["status"] = "ready" if ok else "附件未缓存"
            except ValueError as error:
                record["status"] = str(error)
            except Exception:
                record["status"] = "附件未缓存"
                log.warning("[AW] 附件缓存失败，未发布回溯码（不记录可能含本地访问令牌的请求异常）")
            finally:
                self.media_jobs.task_done()

    @staticmethod
    def _kind(data):
        content = str(data.get("content") or "")
        local_type = str(data.get("localType") or data.get("msgType") or "")
        if local_type in ("3", "47") or content in ("[图片]", "[动画表情]", "[表情]"):
            return "image"
        if local_type == "34" or content.startswith("[语音]"):
            return "voice"
        if local_type in ("43", "62") or content == "[视频]":
            return "video"
        if data.get("appMsgKind") == "file" or data.get("fileName"):
            return "file"
        return ""

    def observe(self, data):
        if not is_group(data) or not self.admins() or data.get("event") == "message.revoke":
            return
        session = session_id(data)
        identity = data.get("messageKey") or data.get("serverId") or data.get("rawid") or data.get("localId")
        # Missing IDs may still be displayed, but never yield an attachment code.
        key = (session, str(identity)) if identity else None
        with self.lock:
            if key and key in self.seen:
                return
            if key:
                self.seen[key] = self.clock()
                while len(self.seen) > 20000:
                    self.seen.popitem(last=False)
            now = self.clock()
            for group, item in list(self.history.items()):
                if now - item["time"] >= 86400:
                    del self.history[group]
            history = self.history.setdefault(session, {"time": now, "messages": deque(maxlen=10)})
            history["time"] = now
            self.history.move_to_end(session)
            while len(self.history) > 200:
                self.history.popitem(last=False)
            content = re.sub(r"\s+", " ", str(data.get("content") or "")).strip()
            if not content:
                return
            kind = self._kind(data)
            label = {"image": "[图片]", "file": "[文件]", "video": "[视频]", "voice": "[语音]"}.get(kind, "")
            text = (label + (" " + str(data["fileName"]) if data.get("fileName") else "")) if kind else content
            record = {"name": re.sub(r"\s+", " ", str(data.get("senderName") or data.get("sourceName") or "未知用户"))[:80], "text": text if len(text) <= 1000 else text[:988] + "…[已截断]", "kind": kind, "status": "附件未缓存", "code": ""}
            history["messages"].append(record)
            if not kind or not identity or len(self.codes) >= 20000:
                return
            digest = hashlib.sha256(json.dumps([session, str(identity), data.get("timestamp"), data.get("fileName"), sender_identity(data)], ensure_ascii=False).encode()).hexdigest().upper()
            # Extend on collision; never let an old code point at a different message.
            length = 8
            code = digest[:length]
            while code in self.codes and self.codes[code] != digest:
                length += 2
                code = digest[:length]
            self.codes[code] = digest
            record.update(code=code, status="附件缓存中")
            self._workers()
            try:
                self.media_jobs.put_nowait((session, code, dict(data), record))
            except queue.Full:
                record["status"] = "附件缓存繁忙"

    def history_text(self, session):
        label = "回溯码"
        with self.lock:
            history = self.history.get(session)
            records = list(history["messages"]) if history and self.clock() - history["time"] < 86400 else []
        lines = ["Anti-Callback"]
        for item in records:
            text = f'{item["name"]}：{item["text"]}'
            if item["kind"]:
                if item["status"] == "ready" and self.cache.available(session, item["code"]):
                    text += f' ｜ {label}：{item["code"]}'
                else:
                    text += " ｜ " + ("附件已过期或已清理" if item["status"] == "ready" else item["status"])
            lines.append(text)
        if not records:
            lines.append("暂无已缓存的群聊消息。")
        return "\n".join(lines)

    def handle(self, data):
        """True means consumed locally; called before contexts, merging and /commands."""
        text = str(data.get("content") or "").strip()
        session = session_id(data)
        with self.lock:
            sent_at = self.echoes.get((session, text))
            if sent_at is not None and self.clock() - sent_at < 120:
                return True
        if data.get("isSend") in (True, 1, "1"):
            return True
        if data.get("event") == "message.revoke":
            # Revoke summaries can embed the original command/menu text.
            return bool(re.search(r"#(?:aw|uid|status|stop|start|ac)\b", text, re.IGNORECASE))
        menu_match = MENU_COMMAND.match(text)
        direct_match = DIRECT_COMMAND.match(text)
        if not menu_match and not direct_match:
            self.observe(data)
            return False
        # The entire namespace is consumed, including malformed/unauthorized input.
        # Attachments/quoted rich cards cannot execute commands through their title.
        if str(data.get("localType") or data.get("msgType") or 1) != "1":
            return True
        identity = sender_identity(data)
        if not session or not identity:
            self.reply(data, "无法识别真实发送者，请使用另一个微信账号发送纯文字 #uid。")
            return True
        if identity.casefold() == str(getattr(self.config, "BOT_WXID", "")).casefold():
            return True
        now = self.clock()
        rate_key = (session, identity.casefold())
        with self.lock:
            if now - self.cooldowns.get(rate_key, -float("inf")) < 1:
                return True
            self.cooldowns[rate_key] = now
            self.cooldowns.move_to_end(rate_key)
            while len(self.cooldowns) > 4096:
                self.cooldowns.popitem(last=False)
        tokens = text.split()
        is_menu = tokens[0].casefold() == "#aw"
        command = "" if is_menu else tokens[0][1:].lower()
        admin = self.is_admin(data)
        if is_menu:
            if len(tokens) != 1:
                self.reply(data, "#aw 仅用于显示菜单；其他功能请直接发送 #uid、#status、#stop、#start 或 #ac。")
            else:
                lines = [f"AstrWeChat v{version()}", "#aw - 显示此菜单", "#uid - 查看UID"]
                if admin:
                    lines += ["#status - 查看连接状态与当前会话设置", "#stop - 暂停当前会话的消息转发", "#start - 恢复当前会话的消息转发", "#ac - 回显当前群聊最近10条消息", "#ac <回溯码> - 发送对应附件"]
                self.reply(data, "\n".join(lines), admin=admin)
        elif command == "uid":
            if len(tokens) != 1:
                self.reply(data, "指令格式不正确，请直接发送 #uid。")
            else:
                self.reply(data, f'#uid\n你的ID：{stable_uid(identity)}\n权限：{"管理员" if admin else "普通用户"}')
        elif not admin:
            self.reply(data, "此指令仅管理员可用。发送 #uid 查询ID后，在 AstrWeChat 的 AW配置页面添加管理员。")
        elif command == "status" and len(tokens) == 1:
            pushing = "已暂停" if self.is_paused(session) else ("正常" if self.sse_connected else "连接异常")
            ready = getattr(self.state, "_ob_ws_ready", None)
            connected = bool(ready and ready.is_set())
            name = data.get("groupName") if is_group(data) else data.get("sourceName")
            mode = {"mention": "仅提及", "all": "全部消息", "batch": "批处理"}.get(getattr(self.state, "group_reply_mode", "mention"), "未知") if is_group(data) else "私聊"
            self.reply(data, f'#status\n消息推送：{pushing}\n{getattr(self.config, "OB_LABEL", "AstrBot")}：{"已连接" if connected else "未连接"}\n当前会话：{name or session}\n回复模式：{mode}', admin=True)
        elif command in ("stop", "start") and len(tokens) == 1:
            with self.lock:
                if command == "stop":
                    self.paused.add(session)
                    self.epochs[session] = self.epochs.get(session, 0) + 1
                else:
                    self.paused.discard(session)
            if command == "stop":
                self.bridge.clear_session_buffers(session)
            self.reply(data, "已暂停当前会话的消息转发，本地指令和消息缓存继续可用。" if command == "stop" else "已恢复当前会话的消息转发，不补发暂停期间的消息。", admin=True)
        elif command == "ac" and len(tokens) in (1, 2):
            if not is_group(data):
                self.reply(data, "此指令仅支持群聊。", admin=True)
            elif len(tokens) == 1:
                self.reply(data, self.history_text(session), admin=True)
            elif re.fullmatch(r"[A-Fa-f0-9]{8,64}", tokens[1]):
                self.reply(data, "", admin=True, code=tokens[1].upper())
            else:
                self.reply(data, "回溯码格式不正确，请发送 #ac 查看。", admin=True)
        else:
            self.reply(data, "指令格式不正确，发送 #aw 查看菜单。")
        return True

    def close(self):
        self.closed.set()
        self.cache.close()
        with self.lock:
            self.history.clear()
            self.echoes.clear()
