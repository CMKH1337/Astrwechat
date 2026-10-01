"""Bounded, ephemeral attachment storage for local #AW commands.

Only exact message IDs are accepted. File names/timestamps never authorize a match.
"""
import os
import hashlib
from pathlib import Path
import re
import shutil
import tempfile
import threading
import time
from urllib.parse import urljoin, urlsplit

import requests


def bounded(value, fallback, low, high):
    try:
        return min(high, max(low, int(value)))
    except (ValueError, TypeError, OverflowError):
        return fallback


def exact_message(messages, event):
    server = str(event.get("serverId") or event.get("rawid") or "").strip()
    local = str(event.get("localId") or "").strip()
    session = str(event.get("sessionId") or event.get("talkerId") or "").strip().casefold()
    for message in messages if isinstance(messages, list) else []:
        if not isinstance(message, dict):
            continue
        candidate_session = str(message.get("sessionId") or message.get("talkerId") or "").strip().casefold()
        if candidate_session and candidate_session != session:
            continue
        candidate_server = str(message.get("serverIdRaw") or message.get("serverId") or message.get("rawid") or "").strip()
        if server and server != "0" and candidate_server and candidate_server != "0":
            if server == candidate_server:
                return message
            continue  # A conflicting server ID must not fall back to local ID/name/time.
        if local and local != "0" and str(message.get("localId") or "") == local:
            return message
    return None


def safe_name(value, fallback):
    name = str(value or "").replace("\\", "/").split("/")[-1]
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")[:120]
    if not name or name.split(".")[0].upper() in {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(10)), *(f"LPT{i}" for i in range(10))}:
        return fallback
    return name


class AttachmentCache:
    def __init__(self, config, clock=time.time):
        self.config = config
        self.clock = clock
        self.lock = threading.RLock()
        self.entries = {}
        self.directory = None
        self.closed = False

    def settings(self):
        raw = getattr(self.config, "config", {})
        return (
            bounded(raw.get("ac_cache_hours"), 24, 1, 168) * 3600,
            bounded(raw.get("ac_file_max_mb"), 100, 1, 1024) * 1024 * 1024,
            bounded(raw.get("ac_cache_max_mb"), 512, 1, 4096) * 1024 * 1024,
        )

    def _remove(self, key):
        entry = self.entries.pop(key)
        target = Path(entry["path"]).parent.resolve()
        # Delete only a direct child created inside this cache's private directory.
        if self.directory and target.parent == Path(self.directory.name).resolve():
            shutil.rmtree(target)

    def prune(self):
        with self.lock:
            ttl, max_file, max_total = self.settings()
            now = self.clock()
            for key, entry in list(self.entries.items()):
                if now - entry["created"] >= ttl or entry["size"] > max_file or not os.path.isfile(entry["path"]):
                    self._remove(key)
            total = sum(entry["size"] for entry in self.entries.values())
            for key, entry in list(self.entries.items()):
                if total <= max_total:
                    break
                total -= entry["size"]
                self._remove(key)

    def available(self, session, code):
        with self.lock:
            self.prune()
            return (session, code) in self.entries

    def _root(self):
        if self.directory is None:
            parent = Path(self.config.RUNTIME_DIR) / "aw-ac-cache"
            parent.mkdir(parents=True, exist_ok=True)
            if parent.is_symlink() or parent.resolve().parent != Path(self.config.RUNTIME_DIR).resolve():
                raise ValueError("附件缓存目录必须位于 Bridge 数据目录内")
            # A crashed previous process may leave cache files. Never reuse them.
            # The bridge has an account-scoped singleton lock before this is called.
            for child in parent.glob("awac-*"):
                if child.is_dir() and not child.is_symlink() and child.resolve().parent == parent.resolve():
                    shutil.rmtree(child)
            self.directory = tempfile.TemporaryDirectory(prefix="awac-", dir=parent)
        return Path(self.directory.name)

    def store(self, session, code, event, kind):
        """Resolve exact source, then make our own bounded copy before publishing code."""
        server = str(event.get("serverId") or event.get("rawid") or "")
        local = event.get("localId")
        if (not server or server == "0") and not local:
            raise ValueError("缺少原消息标识")
        selected = None
        for delay in (0, 0.5, 1, 2):
            if self.closed:
                return False
            if delay:
                time.sleep(delay)
            params = {"access_token": self.config.ACCESS_TOKEN, "talker": event.get("sessionId") or event.get("talkerId"), "media": "true", "file": "true" if kind == "file" else "false", "file_source_only": "true", "voice": "true" if kind == "voice" else "false", "limit": 30}
            if server and server != "0":
                params["server_id"] = server
            if local:
                params["local_id"] = local
            with requests.get(f"{self.config.WE_FLOW_BASE_URL}/api/v1/messages", params=params, timeout=15) as response:
                response.raise_for_status()
                payload = response.json()
            messages = payload if isinstance(payload, list) else payload.get("messages", payload.get("data", []))
            selected = exact_message(messages, event)
            if selected:
                local_path = str(selected.get("mediaSourcePath") or selected.get("mediaLocalPath") or "")
                expected = bounded(selected.get("fileSize") or event.get("fileSize"), 0, 0, 2**63 - 1) if kind == "file" else 0
                if local_path and os.path.isfile(local_path) and os.path.getsize(local_path) > 0 and (not expected or os.path.getsize(local_path) == expected):
                    return self._save(session, code, event, kind, selected, local_path=local_path)
                if selected.get("mediaUrl"):
                    return self._save(session, code, event, kind, selected, media_url=str(selected["mediaUrl"]))
        raise ValueError("附件尚未下载或无法精确定位")

    def _save(self, session, code, event, kind, selected, local_path=None, media_url=None):
        with self.lock:
            if self.closed:
                return False
            self.prune()
            ttl, max_file, max_total = self.settings()
            remaining = max_total - sum(entry["size"] for entry in self.entries.values())
            limit = min(max_file, remaining)
            if limit <= 0:
                raise ValueError("附件缓存已满")
            expected = bounded(selected.get("fileSize") or event.get("fileSize"), 0, 0, 2**63 - 1) if kind == "file" else 0
            if expected > limit:
                raise ValueError("附件超过缓存大小限制")
            suffix = {"image": ".jpg", "video": ".mp4", "voice": ".mp3"}.get(kind, ".bin")
            name = safe_name(event.get("fileName") or selected.get("fileName") or selected.get("mediaFileName") or (os.path.basename(local_path) if local_path else ""), f"附件-{code}{suffix}")
            directory = Path(tempfile.mkdtemp(prefix=f"{code}-", dir=self._root()))
            target = directory / name
            size = 0
            checksum = hashlib.md5()
            expected_md5 = str(event.get("fileMd5") or selected.get("fileMd5") or "").strip().lower() if kind == "file" else ""
            try:
                def copy(chunks):
                    nonlocal size
                    with target.open("xb") as output:
                        for chunk in chunks:
                            if self.closed:
                                raise ValueError("缓存已关闭")
                            size += len(chunk)
                            if size > limit:
                                raise ValueError("附件超过缓存大小限制")
                            output.write(chunk)
                            checksum.update(chunk)
                    if not size or (expected and size != expected):
                        raise ValueError("附件尚未完整下载")
                    if re.fullmatch(r"[0-9a-f]{32}", expected_md5) and checksum.hexdigest() != expected_md5:
                        raise ValueError("附件内容校验失败")
                if local_path:
                    if os.path.getsize(local_path) > limit:
                        raise ValueError("附件超过缓存大小限制")
                    with open(local_path, "rb") as source:
                        copy(iter(lambda: source.read(64 * 1024), b""))
                else:
                    base = self.config.WE_FLOW_BASE_URL.rstrip("/") + "/"
                    url = urljoin(base, media_url)
                    if urlsplit(url)[:2] != urlsplit(base)[:2] or urlsplit(url).username:
                        raise ValueError("拒绝非本地媒体服务的附件地址")
                    # Never forward the local API token to redirects/remote hosts.
                    with requests.get(url, params={"access_token": self.config.ACCESS_TOKEN}, timeout=(5, 30), stream=True, allow_redirects=False) as response:
                        if response.status_code != 200:
                            raise ValueError("附件下载失败")
                        content_type = response.headers.get("Content-Type", "").lower()
                        if kind == "image" and not event.get("fileName"):
                            extension = next((ext for mime, ext in (("png", ".png"), ("gif", ".gif"), ("webp", ".webp")) if mime in content_type), ".jpg")
                            target = target.with_suffix(extension)
                        if bounded(response.headers.get("Content-Length"), 0, 0, 2**63 - 1) > limit:
                            raise ValueError("附件超过缓存大小限制")
                        copy(response.iter_content(64 * 1024))
                self.entries[(session, code)] = {"path": str(target), "kind": kind, "size": size, "created": self.clock()}
                return True
            except Exception:
                if directory.resolve().parent == self._root().resolve():
                    shutil.rmtree(directory)
                raise

    def send(self, session, code, sender, contact):
        with self.lock:
            self.prune()
            entry = self.entries.get((session, code))
            if not entry or self.closed:
                return None
            method = sender.send_image if entry["kind"] == "image" else sender.send_file
            return bool(method(contact, entry["path"]))

    def close(self):
        self.closed = True
        with self.lock:
            self.entries.clear()
            if self.directory:
                self.directory.cleanup()
                self.directory = None
