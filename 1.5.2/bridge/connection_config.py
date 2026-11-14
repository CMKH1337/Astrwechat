"""Side-effect-free selection/validation of the one active OneBot profile."""
from urllib.parse import urlsplit

LEGACY_KOURI_URL = "ws://127.0.0.1:6700"
BACKENDS = {"astrbot": ("AstrBot", "ws://127.0.0.1:11229/ws"),
            "kourichat": ("KOURI-RE", "ws://127.0.0.1:8080/onebot/v11/ws"),
            "builtin": ("内置模型", "")}


def resolve_connection(raw):
    backend = raw.get("bot_backend", "astrbot")
    if backend not in BACKENDS:
        raise ValueError("请选择 AstrBot、KOURI-RE 或内置模型")
    if backend == "builtin":
        from builtin_model import validate_model_config
        validate_model_config(raw)
        return backend, "内置模型", "", ""
    label, default_url = BACKENDS[backend]
    configured_url = raw.get(f"{backend}_ob_url")
    if configured_url is None or (backend == "kourichat" and str(configured_url).strip() == LEGACY_KOURI_URL):
        url = default_url
    else:
        url = str(configured_url or "").strip()
    original_token = str(raw.get(f"{backend}_ob_token", "") or "")
    if "\r" in original_token or "\n" in original_token:
        raise ValueError(f"{label} Token 不能包含换行")
    try:
        parsed = urlsplit(url)
        if (parsed.scheme not in ("ws", "wss") or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or parsed.fragment or any(c.isspace() for c in url)):
            raise ValueError()
        _ = parsed.port
    except ValueError:
        raise ValueError(f"{label} 地址必须是有效的 ws:// 或 wss:// 地址") from None
    return backend, label, url, original_token.strip()


def safe_endpoint(url):
    """Never put query-string credentials into connection logs."""
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path}"
