"""
OneBot v11 协议处理模块。

包括：
- make_message_event() — 构造 OneBot 消息事件 JSON
- push_event() — 通过 WebSocket 推送事件给 AstrBot
- _handle_ob_api() — 处理 AstrBot 发来的 API 请求（send_msg 等）
- _extract_text() — 从 OneBot message 段提取纯文本
"""

import asyncio
import base64
import json
import os
import tempfile
import time
import logging
import mimetypes
import re
import shutil
from email.message import Message
from urllib.parse import unquote, urlparse

import requests

import state
import config

log = logging.getLogger("ob11-bridge")


_send_queue = None
_send_worker_task = None
_send_worker_loop = None


def _ensure_send_queue():
    """为当前 WebSocket 事件循环创建唯一的 FIFO 发送队列。"""
    global _send_queue, _send_worker_task, _send_worker_loop
    loop = asyncio.get_running_loop()
    if (
        _send_queue is None
        or _send_worker_loop is not loop
        or _send_worker_task is None
        or _send_worker_task.done()
    ):
        _send_queue = asyncio.Queue()
        _send_worker_loop = loop
        _send_worker_task = asyncio.create_task(_send_worker(_send_queue))
    return _send_queue


async def _send_worker(queue: asyncio.Queue):
    """严格按 AstrBot API 到达顺序执行微信 UIA 发送。"""
    while True:
        request = await queue.get()
        try:
            await _process_send_request(request)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.exception(f"[OB11] 发送队列处理异常: {e}")
        finally:
            cleanup_dirs = request.get("cleanup_dirs", [])
            if cleanup_dirs:
                await asyncio.to_thread(_cleanup_staged_files, cleanup_dirs)
            queue.task_done()


async def _send_ob_response(action: str, echo):
    """尽快回复 OneBot API，避免 AstrBot 在等待 UIA 时超时。"""
    resp_sent = False
    resp_data = {"status": "ok", "retcode": 0, "data": {}}
    if echo is not None:
        resp_data["echo"] = echo

    for retry in range(10):
        try:
            if state._ob_ws:
                await state._ob_ws.send(json.dumps(resp_data, ensure_ascii=False))
                resp_sent = True
                log.info(f"[OB11] 已回响应: {action}")
                break
            if retry < 9:
                await asyncio.sleep(0.5)
        except Exception as e:
            log.warning(f"[OB11] 回响应失败 (重试 {retry + 1}/10): {e}")
            if retry < 9:
                await asyncio.sleep(0.5)

    if not resp_sent:
        log.warning(f"[OB11] 无法回响应（WS 未连接），消息仍尝试本地排队: {action}")


def _coalesce_message_operations(message) -> list[tuple[str, str]]:
    """
    将一次 OneBot send_* 请求合并为有序操作。

    OneBot 的多个 text segment 本来属于同一条消息，不应逐段抢占 UIA 锁；
    at segment 暂不转成微信原生 @，但也不能把相邻文本拆开。
    """
    if isinstance(message, str):
        message = [{"type": "text", "data": {"text": message}}]
    elif isinstance(message, dict):
        message = [message]
    elif not isinstance(message, list):
        return []

    operations: list[tuple[str, str]] = []
    text_parts: list[str] = []

    def flush_text():
        if not text_parts:
            return
        text = "".join(text_parts).strip()
        text_parts.clear()
        if text:
            operations.append(("text", text))

    for seg in message:
        if not isinstance(seg, dict):
            continue
        seg_type = str(seg.get("type", ""))
        seg_data = seg.get("data", {}) or {}

        if seg_type == "text":
            text_parts.append(str(seg_data.get("text", "")))
        elif seg_type == "image":
            flush_text()
            file_val = str(seg_data.get("file", "")).strip()
            if file_val:
                operations.append(("image", file_val))
        elif seg_type in ("file", "video"):
            # AstrBot sends videos through the standard OneBot media segment.
            # WeChat UIA uses the same file-drop path for both files and videos,
            # but keep a distinct operation type for diagnostics and extension.
            flush_text()
            file_val = str(seg_data.get("file") or seg_data.get("url") or "").strip()
            if file_val:
                operations.append((seg_type, file_val))
        elif seg_type == "face":
            flush_text()
            operations.append(("text", "[表情]"))
        elif seg_type == "at":
            # 微信原生 @ 需要单独的 UIA 选人流程；当前保持既有行为：
            # 忽略 OneBot at 元数据，但继续合并其前后的文本。
            continue

    flush_text()
    return operations


async def _send_image_operation(contact: str, file_val: str) -> bool:
    img_path = None
    temporary_file = False

    if file_val.startswith("base64://"):
        try:
            img_path = await asyncio.to_thread(_decode_base64_image, file_val[9:])
            temporary_file = bool(img_path)
            if img_path:
                log.info(f"[OB11] 图片已解码: {os.path.basename(img_path)}")
        except Exception as e:
            log.warning(f"[OB11] base64 图片解码失败: {e}")
            return False
    elif config.ASTRBOT_ATTACHMENTS:
        candidates = [
            os.path.join(config.ASTRBOT_ATTACHMENTS, file_val),
            os.path.join(config.ASTRBOT_ATTACHMENTS, "wechat_images", file_val),
        ]
        for candidate in candidates:
            if os.path.exists(candidate):
                img_path = candidate
                break
        if not img_path:
            log.warning(f"[OB11] 图片文件未找到: {file_val}")

    if not img_path:
        return False

    try:
        sent = await asyncio.to_thread(state.sender_instance.send_image, contact, img_path)
        if sent:
            log.info(f"[OB11] 图片已发送至 {contact}")
        else:
            log.error(f"[OB11] 图片发送失败: {contact}")
        return bool(sent)
    finally:
        if temporary_file:
            try:
                os.unlink(img_path)
            except Exception:
                pass


def _resolve_local_file(file_val: str) -> str | None:
    """Resolve a file path that is accessible from the Bridge process."""
    file_val = os.path.expandvars(os.path.expanduser(str(file_val or "").strip()))
    if not file_val:
        return None

    if file_val.lower().startswith("file://"):
        parsed = urlparse(file_val)
        file_val = unquote(parsed.path)
        if parsed.netloc:
            file_val = f"//{parsed.netloc}{file_val}"
        elif os.name == "nt" and len(file_val) >= 3 and file_val[0] == "/" and file_val[2] == ":":
            file_val = file_val[1:]

    candidates = []
    if os.path.isabs(file_val):
        candidates.append(file_val)
    if config.ASTRBOT_ATTACHMENTS:
        candidates.extend([
            os.path.join(config.ASTRBOT_ATTACHMENTS, file_val),
            os.path.join(config.ASTRBOT_ATTACHMENTS, "wechat_files", file_val),
        ])

    for candidate in candidates:
        resolved = os.path.abspath(candidate)
        if os.path.isfile(resolved):
            return resolved
    return None


_MAX_REMOTE_FILE_BYTES = 1024 * 1024 * 1024


def _stage_local_file(file_val: str) -> tuple[str, str] | None:
    """Keep a local file alive after AstrBot receives the immediate API response."""
    scheme = urlparse(str(file_val or "")).scheme.lower()
    if scheme in ("http", "https"):
        return None

    source_path = _resolve_local_file(file_val)
    if not source_path:
        return None

    temp_dir = tempfile.mkdtemp(prefix="astrwechat-stage-")
    staged_path = os.path.join(temp_dir, os.path.basename(source_path))
    try:
        try:
            os.link(source_path, staged_path)
            method = "hardlink"
        except OSError:
            shutil.copy2(source_path, staged_path)
            method = "copy"
        log.info(
            f"[OB11] Local file staged before API response ({method}): "
            f"{os.path.basename(staged_path)}"
        )
        return staged_path, temp_dir
    except Exception:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise


def _stage_local_files_in_params(action: str, params: dict) -> list[str]:
    """Replace local OneBot file values with Bridge-owned staged paths."""
    cleanup_dirs = []
    file_slots = []

    if action in ("upload_private_file", "upload_group_file"):
        file_slots.append((params, "file"))
    else:
        message = params.get("message", [])
        if isinstance(message, dict):
            message = [message]
        if isinstance(message, list):
            for segment in message:
                if not isinstance(segment, dict) or str(segment.get("type", "")) not in ("file", "video"):
                    continue
                data = segment.get("data", {})
                if isinstance(data, dict):
                    file_slots.append((data, "file"))

    for container, key in file_slots:
        file_val = str(container.get(key, "")).strip()
        if not file_val:
            continue
        try:
            staged = _stage_local_file(file_val)
        except Exception as e:
            log.warning(f"[OB11] Failed to stage local file before API response: {file_val}: {e}")
            continue
        if staged:
            staged_path, temp_dir = staged
            container[key] = staged_path
            cleanup_dirs.append(temp_dir)
    return cleanup_dirs


def _cleanup_staged_files(cleanup_dirs: list[str]):
    for temp_dir in cleanup_dirs:
        shutil.rmtree(temp_dir, ignore_errors=True)


def _remote_file_name(response: requests.Response, file_url: str) -> str:
    """Choose a safe local filename from HTTP headers or the final URL."""
    file_name = ""
    content_disposition = response.headers.get("Content-Disposition", "")
    if content_disposition:
        message = Message()
        message["Content-Disposition"] = content_disposition
        file_name = message.get_filename() or ""

    if not file_name:
        file_name = os.path.basename(unquote(urlparse(response.url or file_url).path))
    if not file_name:
        file_name = "downloaded-file"

    file_name = os.path.basename(file_name.replace("\\", "/"))
    file_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", file_name).strip(" .")
    if not file_name or file_name in (".", ".."):
        file_name = "downloaded-file"

    if "." not in file_name:
        content_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip()
        extension = mimetypes.guess_extension(content_type) if content_type else None
        if extension:
            file_name += extension
    return file_name


def _download_remote_file(file_url: str) -> tuple[str, str]:
    """Download one HTTP(S) file and return (file_path, temporary_directory)."""
    temp_dir = tempfile.mkdtemp(prefix="astrwechat-file-")
    try:
        with requests.get(
            file_url,
            stream=True,
            allow_redirects=True,
            timeout=(10, 300),
            headers={"User-Agent": "AstrWeChat-Bridge/1.0"},
        ) as response:
            response.raise_for_status()
            content_length = response.headers.get("Content-Length")
            if content_length and int(content_length) > _MAX_REMOTE_FILE_BYTES:
                raise ValueError("remote file exceeds the 1 GiB limit")

            file_name = _remote_file_name(response, file_url)
            file_path = os.path.join(temp_dir, file_name)
            downloaded = 0
            with open(file_path, "wb") as output:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if not chunk:
                        continue
                    downloaded += len(chunk)
                    if downloaded > _MAX_REMOTE_FILE_BYTES:
                        raise ValueError("remote file exceeds the 1 GiB limit")
                    output.write(chunk)

        if not os.path.isfile(file_path) or os.path.getsize(file_path) == 0:
            raise ValueError("downloaded file is empty")
        return file_path, temp_dir
    except Exception:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise


async def _send_file_operation(contact: str, file_val: str, media_label: str = "File") -> bool:
    temporary_dir = None
    scheme = urlparse(file_val).scheme.lower()

    if scheme in ("http", "https"):
        try:
            log.info(f"[OB11] Downloading remote {media_label.lower()}: {file_val}")
            file_path, temporary_dir = await asyncio.to_thread(_download_remote_file, file_val)
            log.info(
                f"[OB11] Remote {media_label.lower()} downloaded: {os.path.basename(file_path)} "
                f"({os.path.getsize(file_path)} bytes)"
            )
        except Exception as e:
            log.warning(f"[OB11] Remote {media_label.lower()} download failed: {file_val}: {e}")
            return False
    else:
        file_path = _resolve_local_file(file_val)
        if not file_path:
            log.warning(f"[OB11] {media_label} is missing or inaccessible to Bridge: {file_val}")
            return False

    try:
        sent = await asyncio.to_thread(state.sender_instance.send_file, contact, file_path)
        if sent:
            log.info(f"[OB11] {media_label} sent to {contact}: {os.path.basename(file_path)}")
        else:
            log.error(f"[OB11] {media_label} send failed: {contact}: {os.path.basename(file_path)}")
        return bool(sent)
    finally:
        if temporary_dir:
            await asyncio.to_thread(shutil.rmtree, temporary_dir, True)


async def _process_send_request(request: dict):
    """Process one queued send request without interleaving its operations."""
    action = request["action"]
    params = request["params"]
    contact = request["contact"]
    echo = request.get("echo")

    if action in ("upload_private_file", "upload_group_file"):
        file_val = str(params.get("file", "")).strip()
        log.info(
            f"[OB11] Start file send: {action} echo={echo} "
            f"contact={contact} file={os.path.basename(file_val)}"
        )
        if not file_val:
            log.warning(f"[OB11] Skip empty file request: {action} echo={echo} contact={contact}")
            return
        await _send_file_operation(contact, file_val)
        return

    operations = _coalesce_message_operations(params.get("message", []))

    log.info(
        f"[OB11] 开始顺序发送: {action} echo={echo} "
        f"contact={contact} operations={len(operations)}"
    )

    if not operations:
        log.info(f"[OB11] 跳过空消息: {action} echo={echo} contact={contact}")
        return

    for operation_type, value in operations:
        if operation_type == "text":
            sent = await asyncio.to_thread(state.sender_instance.send_text, contact, value)
            if sent:
                log.info(f"[OB11] 文字已发送至 {contact}: {value[:50]}")
            else:
                log.error(f"[OB11] 文字发送失败: {contact}: {value[:50]}")
        elif operation_type == "image":
            await _send_image_operation(contact, value)
        elif operation_type == "file":
            await _send_file_operation(contact, value)
        elif operation_type == "video":
            log.info(
                f"[OB11] 开始视频发送: contact={contact} "
                f"source={os.path.basename(urlparse(value).path) or value}"
            )
            # The UIA sender transfers videos through the Windows file-drop
            # clipboard format; WeChat recognizes an mp4 as a video attachment.
            await _send_file_operation(contact, value, media_label="Video")


def _normalize_ob_target_id(value):
    """Normalize numeric OneBot IDs so string and integer forms share a route."""
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return value


def _resolve_reply_contact(action: str, params: dict):
    """Resolve send_msg/send_* to the original private or group session route."""
    message_type = str(params.get("message_type") or "").strip().lower()
    has_group_id = params.get("group_id") not in (None, "", 0, "0")
    is_group = action in ("send_group_msg", "upload_group_file") or (
        action == "send_msg" and (message_type == "group" or has_group_id)
    )
    target_key = "group_id" if is_group else "user_id"
    raw_target_id = params.get(target_key, 0)
    target_id = _normalize_ob_target_id(raw_target_id)
    contact = state._ob_id_to_contact.get(target_id, str(raw_target_id))
    return is_group, target_id, contact


async def _handle_ob_api(data: dict):
    """响应 OneBot API；发送类请求进入 FIFO 队列后立即返回。"""
    action = str(data.get("action", ""))
    params = data.get("params", {}) or {}
    echo = data.get("echo") if "echo" in data else None
    message = params.get("message", [])
    if isinstance(message, dict):
        message = [message]
    segment_types = [
        str(segment.get("type", ""))
        for segment in (message if isinstance(message, list) else [])
        if isinstance(segment, dict)
    ]
    segment_summary = ",".join(segment_types) or "-"
    log.info(f"[OB11] API: {action} echo={echo} segments={segment_summary}")

    send_actions = (
        "send_msg", "send_private_msg", "send_group_msg",
        "upload_private_file", "upload_group_file",
    )
    cleanup_dirs = []
    if action in send_actions:
        cleanup_dirs = await asyncio.to_thread(_stage_local_files_in_params, action, params)

    await _send_ob_response(action, echo)

    if action in ("send_msg", "send_private_msg", "send_group_msg"):
        is_group, target_id, contact = _resolve_reply_contact(action, params)
        queue = _ensure_send_queue()
        await queue.put({
            "action": action,
            "params": params,
            "echo": echo,
            "contact": contact,
            "cleanup_dirs": cleanup_dirs,
        })
        log.info(
            f"[OB11] 已进入发送队列: {action} echo={echo} "
            f"contact={contact} pending={queue.qsize()}"
        )
    elif action in ("upload_private_file", "upload_group_file"):
        is_group, target_id, contact = _resolve_reply_contact(action, params)
        queue = _ensure_send_queue()
        await queue.put({
            "action": action,
            "params": params,
            "echo": echo,
            "contact": contact,
            "cleanup_dirs": cleanup_dirs,
        })
        log.info(
            f"[OB11] File queued: {action} echo={echo} "
            f"contact={contact} pending={queue.qsize()}"
        )
    else:
        log.debug(f"[OB11] 未处理 API: {action}")


def _extract_text(message: list) -> str:
    """从 OneBot message 段中提取可发送的文本。"""
    text_parts = []
    for seg in message:
        if isinstance(seg, dict):
            t = seg.get("type", "")
            d = seg.get("data", {})
            if t == "text":
                text_parts.append(d.get("text", ""))
            elif t == "image":
                text_parts.append("[图片]")
            elif t == "face":
                text_parts.append("[表情]")
            elif t == "record":
                text_parts.append("[语音]")
            elif t == "video":
                text_parts.append("[视频]")
            elif t == "reply":
                if d.get("text"):
                    text_parts.append(f'"{d["text"]}"')
            elif t == "at":
                text_parts.append(f"@{d.get('qq', d.get('name', ''))}")
            else:
                # 其他未知类型也尝试提取文本
                text_parts.append(d.get("text", ""))
    return "".join(text_parts).strip()


# ============ OneBot 协议处理 ============


def make_message_event(message_type: str, user_id: int, message: list,
                       group_id: int = 0, group_name: str = "",
                       nickname: str = "") -> dict:
    """构造 OneBot v11 消息事件"""
    event = {
        "time": int(time.time()),
        "self_id": state._self_id_int,
        "post_type": "message",
    }
    if message_type == "group":
        event["message_type"] = "group"
        event["group_id"] = group_id
        event["user_id"] = user_id
        event["message"] = message
        event["raw_message"] = "".join(
            seg.get("data", {}).get("text", "") for seg in message
            if seg.get("type") == "text"
        )
        event["sender"] = {"user_id": user_id, "nickname": nickname or str(user_id)}
        event["group_name"] = group_name or str(group_id)
    else:
        event["message_type"] = "private"
        event["user_id"] = user_id
        event["message"] = message
        event["raw_message"] = "".join(
            seg.get("data", {}).get("text", "") for seg in message
            if seg.get("type") == "text"
        )
        event["sender"] = {"user_id": user_id, "nickname": nickname or str(user_id)}
    return event


def push_event(event: dict) -> bool:
    """通过 WebSocket 客户端连接向 AstrBot 推送事件。"""
    if not state._ob_ws or not state._ob_ws_loop:
        return False
    try:
        future = asyncio.run_coroutine_threadsafe(
            state._ob_ws.send(json.dumps(event, ensure_ascii=False)),
            state._ob_ws_loop,
        )
        future.result(timeout=5)
        return True
    except Exception as e:
        log.warning(f"[OB11] 推送事件失败: {e}")
        return False


def _decode_base64_image(b64_data: str) -> str | None:
    """在线程池中执行：解码 base64 图片并保存为临时文件。"""
    import tempfile
    img_data = base64.b64decode(b64_data)
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    tmp.write(img_data)
    tmp.close()
    return tmp.name
