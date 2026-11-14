"""Provider-scoped limits; conservative local input budgeting without tokenizer downloads."""

class ContextBudgetError(ValueError):
    pass


def _limit(value, default=0):
    try:
        n = int(value)
        return n if not isinstance(value, bool) and 0 < n <= 100_000_000 else default
    except (ValueError, TypeError, OverflowError):
        return default


def model_metadata(raw):
    meta = raw.get('builtin_model_metadata') or {}
    if not isinstance(meta, dict) or any((
        meta.get('id') != str(raw.get('builtin_model') or '').strip(),
        meta.get('baseUrl') != str(raw.get('builtin_base_url') or '').strip().rstrip('/'),
        meta.get('protocol') != raw.get('builtin_protocol'),
    )):
        meta = {}
    return meta


def limits(raw):
    meta = model_metadata(raw)
    contexts = [n for n in (_limit(raw.get('builtin_context_tokens')), _limit(meta.get('contextWindow'))) if n]
    context = min(contexts) if contexts else _limit(meta.get('maxInputTokens'), 32768)
    output = min(_limit(raw.get('builtin_max_output_tokens'), 2048), _limit(meta.get('maxOutputTokens'), 1_000_000), max(1, context // 2))
    budget = min(context - output, _limit(meta.get('maxInputTokens'), context)) - min(512, max(32, context // 20))
    return budget, output


def fit_turns(turns, system_prompt, budget, image_count=0, required_count=1):
    # UTF-8 bytes intentionally overestimate ordinary text tokens for unknown tokenizers.
    # Image accounting is an estimate; provider billing/tokenization remains authoritative.
    size = len(system_prompt.encode('utf-8')) + 64 + image_count * 4096
    cost = lambda turn: len(turn[1].encode('utf-8')) + 32
    required_count = max(1, required_count)
    if not turns or size + sum(cost(turn) for turn in turns[-required_count:]) > budget:
        raise ContextBudgetError('当前消息或系统提示词超出输入预算')
    kept = list(reversed(turns[-required_count:]))
    size += sum(cost(turn) for turn in kept)
    for turn in reversed(turns[:-required_count]):
        if size + cost(turn) > budget:
            break
        kept.append(turn)
        size += cost(turn)
    kept.reverse()
    while len(kept) > 1 and kept[0][0] == 'assistant':
        kept.pop(0)
    return kept
