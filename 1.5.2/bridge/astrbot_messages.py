"""Convert a single WeChat group message without inventing a wake-up trigger."""
import re


def native_group_segments(data, self_id, nicknames, *, text=None, media=()):
    content = str(data.get("content") or "") if text is None else str(text)
    names = sorted({str(name).strip() for name in nicknames if str(name).strip()}, key=len, reverse=True)
    # Prefer explicit source metadata. Text fallback only matches a complete configured nickname.
    flags = [data[key] for key in ("mentionedBot", "isMentioned") if isinstance(data.get(key), bool)]
    mentioned = any(flags)
    matches = []
    if names and (not flags or mentioned):
        pattern = r"[@＠](?:" + "|".join(re.escape(name) for name in names) + r")(?=$|[\s,，。.!！?？:：;；、])"
        matches = list(re.finditer(pattern, content))
    segments, end = [], 0
    for match in matches:
        if match.start() > end:
            segments.append({"type": "text", "data": {"text": content[end:match.start()]}})
        segments.append({"type": "at", "data": {"qq": str(self_id)}})
        end = match.end()
    if mentioned and not matches:
        segments.append({"type": "at", "data": {"qq": str(self_id)}})
    if end < len(content):
        segments.append({"type": "text", "data": {"text": content[end:]}})
    return segments + list(media)
