"""Bounded, cancellable reply segmentation; user regexes never run without a timeout."""
import math
import random
import time

DEFAULT_REGEX = r'.*?[。！？!?；;.\n~～…]+|.+$'


class ReplySegments:
    def __init__(self, raw):
        self.enabled = raw.get('builtin_segment_enabled') is True
        self.only_llm = raw.get('builtin_segment_only_llm', True) is not False
        self.interval = raw.get('builtin_segment_interval', 'random')
        self.mode = raw.get('builtin_segment_mode', 'regex')
        self.threshold = int(raw.get('builtin_segment_threshold', 150))
        self.base = float(raw.get('builtin_segment_log_base', 2))
        self.range = (1.5, 3.5)
        self.pattern = self.filter = None
        if not self.enabled:
            return
        try:
            self.range = tuple(float(x) for x in str(raw.get('builtin_segment_random', '1.5,3.5')).split(','))
            if (len(self.range) != 2 or not all(math.isfinite(x) for x in self.range)
                    or not 0 <= self.range[0] <= self.range[1] <= 60
                    or not 1 < self.base <= 100 or not 1 <= self.threshold <= 10000
                    or self.interval not in ('random', 'log') or self.mode not in ('regex', 'newline')):
                raise ValueError()
            # regex is already bundled with the model SDK for both supported CPython versions.
            import regex
            pattern = str(raw.get('builtin_segment_regex', DEFAULT_REGEX))
            content_filter = str(raw.get('builtin_segment_filter', ''))
            if len(pattern) > 512 or len(content_filter) > 512 or (self.mode == 'regex' and not pattern):
                raise ValueError()
            if self.mode == 'regex':
                self.pattern = regex.compile(pattern, regex.DOTALL)
                if self.pattern.search('') is not None:
                    raise ValueError()
            if content_filter:
                self.filter = regex.compile(content_filter)
        except ImportError:
            raise
        except Exception:
            # Do not include raw patterns/content in diagnostics.
            raise ValueError('分段回复参数或正则表达式无效，请检查间隔、阈值和正则语法') from None

    def split(self, text, *, llm=True):
        if not self.enabled or (self.only_llm and not llm) or len(text) >= self.threshold:
            return [text]
        if self.mode == 'newline':
            parts = text.splitlines(keepends=True)
        else:
            parts, last = [], 0
            for match in self.pattern.finditer(text, timeout=0.05):
                if match.end() == match.start():
                    raise ValueError('分段正则不能匹配空文本')
                # Preserve unmatched gaps/tail and ignore capture-group tuples.
                parts.append(text[last:match.end()])
                last = match.end()
            if last < len(text):
                parts.append(text[last:])
        # Bound message count to prevent a custom pattern from flooding a chat.
        if len(parts) > 20:
            parts = parts[:19] + [''.join(parts[19:])]
        if self.filter:
            parts = [self.filter.sub('', part, timeout=0.05) for part in parts]
        return [part.strip() for part in parts if part.strip()]

    def delay(self, previous):
        return random.uniform(*self.range) if self.interval == 'random' else min(60, math.log(max(1, len(previous)), self.base))

    @staticmethod
    def wait(seconds, allowed, closed):
        end = time.monotonic() + seconds
        while allowed():
            remaining = end - time.monotonic()
            if remaining <= 0:
                return True
            if closed.wait(min(0.1, remaining)):
                return False
        return False
