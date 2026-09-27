"""Bounded per-session transcripts, with message identity rather than text deduplication."""
from collections import OrderedDict
from dataclasses import dataclass
import json
import threading
from model_limits import ContextBudgetError


@dataclass(frozen=True)
class Turn:
    id: int
    role: str
    content: str
    reply_to: int = 0
    truncated: bool = False


class Transcripts:
    def __init__(self, max_sessions=64, max_turns=120, max_content=8000, max_session_chars=256000):
        self.sessions = OrderedDict()
        self.max_sessions, self.max_turns = max_sessions, max_turns
        self.max_content, self.max_session_chars = max_content, max_session_chars
        self.serial = 0
        self.lock = threading.RLock()

    def clear(self, session=None):
        with self.lock:
            if session is None:
                self.sessions.clear()
            else:
                self.sessions.pop(session, None)

    def _append(self, session, role, content, reply_to=0):
        self.serial += 1
        turn = Turn(self.serial, role, content[:self.max_content], reply_to, len(content) > self.max_content)
        bucket = self.sessions.setdefault(session, [])
        bucket.append(turn)
        del bucket[:-self.max_turns]
        size = sum(len(t.content) for t in bucket)
        while len(bucket) > 1 and size > self.max_session_chars:
            size -= len(bucket.pop(0).content)
        self.sessions.move_to_end(session)
        while len(self.sessions) > self.max_sessions:
            self.sessions.popitem(last=False)
        return turn.id

    def observe(self, session, data, is_group):
        text = str(data.get('content') or '').strip()
        if is_group:
            # JSON metadata is untrusted user data, never a system instruction.
            metadata = {"sender": str(data.get('senderName') or data.get('sourceName') or '未知')[:100],
                        "sender_id": str(data.get('senderUsername') or '')[:120],
                        "time": str(data.get('timestamp') or '')[:40]}
            text = json.dumps(metadata, ensure_ascii=False) + '\n' + text
        with self.lock:
            return self._append(session, 'user', text)

    def replied(self, session, text, reply_to):
        with self.lock:
            self._append(session, 'assistant', text, reply_to)

    def replied_if_present(self, session, text, reply_to):
        with self.lock:
            if any(t.id == reply_to and t.role == 'user' for t in self.sessions.get(session, [])):
                self._append(session, 'assistant', text, reply_to)

    def snapshot(self, session, trigger_ids, context_rounds, _is_group, max_chars=24000, required=False):
        """Return the latest per-session dialogue rounds without leaking newer messages.

        A round is one inbound user message.  An assistant reply is attached to the
        user message it answers, but a group message still consumes one round even
        when it never triggers an AI reply.
        """
        ids = set(trigger_ids)
        if not ids:
            return []
        last = max(ids)
        with self.lock:
            bucket = list(self.sessions.get(session, []))
        user_turns = [t for t in bucket if t.role == 'user']
        user_ids = {t.id for t in user_turns}
        if not ids.issubset(user_ids):
            return ([], 0) if required else []  # Evicted/cleared triggers must not be replayed into another session.
        if any(t.truncated and t.id in ids for t in user_turns):
            raise ContextBudgetError('当前消息超出本地单条内容上限')

        try:
            round_limit = min(1000, max(1, int(context_rounds)))
        except (TypeError, ValueError):
            round_limit = 50

        # Keep every message in the current job, then fill the remaining quota with
        # the newest earlier messages.  This makes a buffered group message count as
        # one round even when it was not mentioned and produced no model response.
        eligible = [t for t in user_turns if t.id <= last]
        selected_ids = set(ids)
        remaining = max(0, round_limit - len(selected_ids))
        for turn in reversed(eligible):
            if turn.id in selected_ids:
                continue
            if remaining <= 0:
                break
            selected_ids.add(turn.id)
            remaining -= 1

        selected = [t for t in bucket if (
            (t.role == 'user' and t.id in selected_ids)
            or (t.role == 'assistant' and t.reply_to in selected_ids)
        )]
        selected.sort(key=lambda t: t.id)

        # Keep the configured round window first, then apply the conservative
        # character budget required by the provider's actual context window.
        kept, kept_ids, size = [], set(), 0
        for turn in reversed(selected):
            cost = len(turn.content) + 32
            if size + cost > max_chars:
                if turn.id in ids:
                    raise ContextBudgetError('当前合并消息超出本地历史上限')
                continue
            kept.append(turn)
            kept_ids.add(turn.id)
            size += cost
        if not ids.issubset(kept_ids):
            raise ContextBudgetError('当前合并消息超出本地历史上限')
        kept_turns = list(reversed(kept))
        result = [(turn.role, turn.content) for turn in kept_turns]
        required_indexes = [index for index, turn in enumerate(kept_turns) if turn.id in ids]
        required_count = len(result) - min(required_indexes)
        return (result, required_count) if required else result

