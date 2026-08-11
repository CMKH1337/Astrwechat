"""
桥接核心模块：WeFlowBridge 类。

职责：
1. 连接 WeFlow SSE 推送，接收微信消息
2. 消息缓冲合并（BUFFER_SECONDS）
3. 构造 OneBot 事件，推送给 AstrBot
4. 多层消息去重（rawid、内容、自回复）
"""

import json
import logging
import os
import queue
import re
import threading
import time
import base64
from collections import defaultdict
from datetime import datetime

import requests

import state
import config
from ob_protocol import push_event, make_message_event

log = logging.getLogger("ob11-bridge")


# ============ 桥接核心 ============


class WeFlowBridge:
    """WeFlow ↔ AstrBot 桥接器（OneBot v11 版）。"""

    def __init__(self, sender):
        self.sender = sender
        self.processed_ids = set()
        self.start_timestamp = int(time.time())
        self.pending_buffers = {}
        self.buffer_lock = threading.Lock()
        self.chat_histories = defaultdict(list)
        self.contact_map = {}
        self._sse_session = None
        self._recent_seen = {}
        self._sent_recently = {}
        self._sse_event_keys = {}
        self._pending_mention_images = {}  # session_id → {"data": data, "time": timestamp} 先媒体后文暂存

    def should_ignore(self, data):
        content = data.get("content", "")
        msg_type = data.get("type", 0) or data.get("msgType", 0)
        if data.get("sourceName", "") in config.BOT_NICKNAMES:
            return True
        if config.BOT_WXID and data.get("talkerId", "") == config.BOT_WXID:
            return True
        if msg_type in (34,):  # 34=语音
            return True
        if content and "[语音]" in content:
            return True
        if not content or content.strip() == "":
            return True
        return False

    def _is_mentioned(self, data):
        """检测群消息是否 @ 了机器人。

        WeFlow SSE 推送不含 @ 结构字段，只能从 content 文本检测。
        """
        content = data.get("content", "")
        if not content:
            return False

        for nick in config.BOT_NICKNAMES:
            # 标准 @昵称（ASCII @）
            if f"@{nick}" in content:
                return True
            # 全角 @昵称（部分微信版本可能用全角符号）
            if f"＠{nick}" in content:
                return True

        # 日志：content 以 @ 开头但未匹配到任何昵称（便于排查）
        if (content.startswith("@") or content.startswith("＠")) and len(content) > 1:
            log.debug(f"⚠️ content 以@开头但未匹配昵称: content={content[:40]!r} nicknames={config.BOT_NICKNAMES}")

        return False

    def add_to_buffer(self, data):
        """将消息加入缓冲区，等待合并后统一推送给 AstrBot。"""
        content = data.get("content", "")
        file_path = data.get("filePath", "")
        if data.get("appMsgKind") == "file" and file_path:
            content = f"{content}\n[本机文件路径] {file_path}"
        source_name = data.get("sourceName", "") or data.get("talkerName", "") or "未知"

        # 先判断群聊/私聊（图片/表情分支也需要用到）
        session_id_data = data.get("sessionId", "") or source_name
        group_name_raw = data.get("groupName", "")
        is_group = (data.get("sessionType", "") == "group") or bool(group_name_raw) or "@chatroom" in session_id_data

        if content == "[图片]":
            # 图片消息（mention 模式下需 @ 才处理）
            if is_group and state.group_reply_mode == "mention" and not self._is_mentioned(data):
                # 先图后文：暂存图片，等后续同人发 @ 文字时合并
                self._pending_mention_images[session_id_data] = {"data": data, "time": time.time()}
                log.info(f"📸 暂存图片，等待关联 @ 文字 (session={session_id_data})")
                return
            threading.Thread(target=self.process_image_message,
                           args=(data,), daemon=True).start()
            return

        if content in ("[动画表情]", "[表情]"):
            # 表情包消息（mention 模式下需 @ 才处理）
            if is_group and state.group_reply_mode == "mention" and not self._is_mentioned(data):
                # 先图后文：暂存表情，等后续同人发 @ 文字时合并
                self._pending_mention_images[session_id_data] = {"data": data, "time": time.time()}
                log.info(f"😀 暂存表情，等待关联 @ 文字 (session={session_id_data})")
                return
            threading.Thread(target=self.process_emoji_message,
                           args=(data,), daemon=True).start()
            return

        now = time.time()
        if content and content in self._sent_recently and now - self._sent_recently[content] < 120:
            log.info(f"⏭️ 自回复去重跳过: {content[:30]}")
            return

        sender_in_group = data.get("senderName", "") or data.get("sender", "") or data.get("sourceName", "")

        if is_group:
            if state.group_reply_mode == "mention" and not self._is_mentioned(data):
                log.debug(f"⏭️ mention 模式跳过（未检测到 @）: data keys={list(data.keys())} nickname={config.BOT_NICKNAMES} content={content[:40]}")
                return
            group_raw = group_name_raw or source_name
            base_name = re.sub(r'\s*\(\d+\)\s*$', '', group_raw).strip()
            contact = base_name
        else:
            contact = source_name

        if is_group and state.group_reply_mode == "batch":
            buffer_key = f"__batch__{base_name}"
        elif is_group and sender_in_group:
            buffer_key = f"{session_id_data}_{sender_in_group}"
        else:
            buffer_key = session_id_data

        with self.buffer_lock:
            if buffer_key not in self.pending_buffers:
                self.pending_buffers[buffer_key] = {
                    "messages": [],
                    "media_segments": [],
                    "timer": None,
                    "timer_version": 0,
                    "processing": False,
                    "contact": contact,
                    "is_group": is_group,
                    "source_name": source_name,
                    "group_name": base_name if is_group else "",
                    "sender_in_group": sender_in_group if is_group else "",
                    "session_id_data": session_id_data,
                }
            entry = self.pending_buffers[buffer_key]
            if is_group and state.group_reply_mode == "batch" and sender_in_group:
                entry["messages"].append(f'成员"{sender_in_group}"在群"{base_name}"中对你说：{content}')
            else:
                entry["messages"].append(content)

            if not entry["processing"]:
                if entry["timer"]:
                    entry["timer"].cancel()
                entry["timer_version"] += 1
                version = entry["timer_version"]

                # 检查是否有暂存的图片（先图后文场景）
                has_pending_image = False
                if is_group and state.group_reply_mode == "mention":
                    cached = self._pending_mention_images.pop(session_id_data, None)
                    if cached and time.time() - cached["time"] < 15:
                        has_pending_image = True
                        log.info(f"📸 检测到关联图片，延长缓冲等待描述")
                        # 异步下载图片并在缓冲期内注入 OneBot 消息段。
                        threading.Thread(
                            target=self._inject_cached_image,
                            args=(cached["data"], buffer_key, version),
                            daemon=True,
                        ).start()

                buffer_delay = 15 if has_pending_image else config.BUFFER_SECONDS
                log.info(f"📩 收到来自 {contact} 的消息，等待 {buffer_delay}s 后统一推送")
                timer = threading.Timer(buffer_delay, lambda v=version, sid=buffer_key: self.process_sender(sid, v))
                timer.daemon = True
                timer.start()
                entry["timer"] = timer

    def process_sender(self, sender_id, version=None):
        """缓冲到期：通过 OneBot 事件推送给 AstrBot。"""
        with self.buffer_lock:
            if sender_id not in self.pending_buffers:
                return
            entry = self.pending_buffers[sender_id]
            if version is not None and entry.get("timer_version", 0) != version:
                return
            if not entry["messages"]:
                return
            msgs = entry["messages"].copy()
            media_segments = entry.get("media_segments", []).copy()
            entry["messages"] = []
            entry["media_segments"] = []
            entry["processing"] = True
            if entry["timer"]:
                entry["timer"].cancel()
                entry["timer"] = None

        contact = entry.get("contact", sender_id)
        is_group = entry.get("is_group", False)
        combined = "\n".join(msgs)
        log.info(f"推送 {len(msgs)} 条消息 [{'群' if is_group else '私'}|{contact}]")

        # 构建 OneBot 事件（user_id 要用发言人身份，不能用群 sessionId）
        if is_group:
            sender_wxid = entry.get("session_id_data", "") + "_" + (entry.get("sender_in_group", "") or entry.get("source_name", ""))
        else:
            sender_wxid = entry.get("session_id_data", sender_id)
        user_id = state._wxid_to_int(sender_wxid)

        if is_group:
            group_id = state._wxid_to_int(entry.get("group_name", contact))
            sender_name = entry.get("sender_in_group", "") or entry.get("source_name", "未知")

            if state.group_reply_mode == "batch":
                # 批处理模式：消息已预格式化好，直接使用
                formatted = combined
            else:
                # 来源由 OneBot 的 sender/group 字段表达，正文必须保留原始文本，
                # 否则 /help 等命令不再位于消息开头，AstrBot 无法识别。
                clean_text = combined
                for nick in config.BOT_NICKNAMES:
                    at_pattern = f"@{nick}"
                    if at_pattern in clean_text:
                        clean_text = clean_text.replace(at_pattern, "").strip()

                formatted = clean_text

            # 消息段：mention 模式带 at 机器人标记，all/batch 不带
            if state.group_reply_mode == "mention":
                msg_segments = [
                    {"type": "at", "data": {"qq": str(state._self_id_int)}},
                    {"type": "text", "data": {"text": f" {formatted}"}},
                ] + media_segments
            else:
                msg_segments = [
                    {"type": "text", "data": {"text": formatted}},
                ] + media_segments
            event = make_message_event("group", user_id, msg_segments,
                                       group_id=group_id,
                                       group_name=entry.get("group_name", contact),
                                       nickname=sender_name)
        else:
            sender_name = entry.get("source_name", contact)
            event = make_message_event("private", user_id,
                                       [{"type": "text", "data": {"text": combined}}] + media_segments,
                                       nickname=sender_name)

        # 记录 user_id → contact 映射，供 API 回复时查找
        if is_group:
            group_id = state._wxid_to_int(entry.get("group_name", contact))
            state._ob_id_to_contact[group_id] = contact
        else:
            state._ob_id_to_contact[user_id] = contact

        sent = push_event(event)
        if sent:
            log.info(f"✅ 已推送至 AstrBot 客户端 [{contact}]")
        else:
            log.warning(f"⚠️ 无 AstrBot 客户端在线 [{contact}]")

        with self.buffer_lock:
            if sender_id in self.pending_buffers:
                self.pending_buffers[sender_id]["processing"] = False

    def listen_sse(self):
        """连接 WeFlow SSE 推送。"""
        sse_url = f"{config.WE_FLOW_BASE_URL}/api/v1/push/messages?access_token={config.ACCESS_TOKEN}"
        log.info(f"连接 WeFlow 推送服务: {sse_url}")
        headers = {"Accept": "text/event-stream", "Cache-Control": "no-cache"}

        try:
            self._sse_session = requests.get(sse_url, headers=headers, stream=True, timeout=None)
            if self._sse_session.status_code != 200:
                log.error(f"连接失败: HTTP {self._sse_session.status_code}")
                return
            log.info("✅ 已连接到 WeFlow 推送")

            for line in self._sse_session.iter_lines(decode_unicode=True):
                if not state.running:
                    break
                if not line:
                    continue
                if line.startswith("data:"):
                    data_str = line[5:].strip()
                    if not data_str:
                        continue
                    try:
                        data = json.loads(data_str)
                        msg_time = data.get("timestamp", 0)
                        if msg_time < self.start_timestamp:
                            continue
                        raw_id = data.get("rawid", "")
                        if raw_id in self.processed_ids:
                            continue
                        self.processed_ids.add(raw_id)
                        if not self.should_ignore(data):
                            if data.get("sessionType", "") == "group" or "@chatroom" in data.get("sessionId", ""):
                                content = data.get("content", "")
                                log.info(f"📩 群消息 [{data.get('sourceName','')}]: {content[:60]}")
                                if state.group_reply_mode == "mention":
                                    mentioned = any(f"@{n}" in content for n in config.BOT_NICKNAMES)
                                    log.info(f"   @={mentioned}")
                            else:
                                log.info(f"📩 收到: {data.get('sourceName','')} → {data.get('content','')[:50]}")
                            self.add_to_buffer(data)
                    except json.JSONDecodeError:
                        pass

        except requests.exceptions.ConnectionError:
            log.error("无法连接 WeFlow")
        except Exception as e:
            log.error(f"SSE 异常: {e}")
        finally:
            self._sse_session = None

    @staticmethod
    def _normalize_message_id(value) -> str:
        text = str(value or "").strip()
        if not text or text == "0":
            return ""
        if text.isdigit():
            return text.lstrip("0") or "0"
        return text

    def _select_media_message(self, messages, event_data, allow_time_fallback=False):
        """按 serverId/rawid、localId、时间邻近顺序定位本次媒体消息。"""
        if not isinstance(messages, list):
            return None

        candidates = [
            msg for msg in messages
            if isinstance(msg, dict)
            and (
                msg.get("mediaType") in ("image", "sticker", "emoji")
                or int(msg.get("localType") or 0) in (3, 47)
            )
        ]
        if not candidates:
            return None

        target_server_id = self._normalize_message_id(
            event_data.get("serverId") or event_data.get("rawid")
        )
        target_local_id = int(event_data.get("localId") or 0)
        target_timestamp = int(event_data.get("timestamp") or 0)

        if target_server_id:
            for msg in candidates:
                candidate_id = self._normalize_message_id(
                    msg.get("serverId") or msg.get("serverIdRaw") or msg.get("rawid")
                )
                if candidate_id and candidate_id == target_server_id:
                    return msg

        if target_local_id > 0:
            for msg in candidates:
                if int(msg.get("localId") or 0) == target_local_id:
                    return msg

        if (target_server_id or target_local_id > 0) and not allow_time_fallback:
            return None

        if target_timestamp > 0:
            nearby = []
            for msg in candidates:
                create_time = int(msg.get("createTime") or msg.get("timestamp") or 0)
                if not create_time:
                    continue
                distance = abs(create_time - target_timestamp)
                if distance <= 15:
                    nearby.append((distance, 0 if msg.get("mediaUrl") else 1, msg))
            if nearby:
                nearby.sort(key=lambda item: (item[0], item[1]))
                return nearby[0][2]

        if allow_time_fallback:
            with_url = [msg for msg in candidates if msg.get("mediaUrl")]
            return with_url[0] if with_url else candidates[0]
        return None

    def _fetch_wechat_image(self, event_data: dict) -> str | None:
        """精确查找本次图片；文件尚未落盘时进行有限重试。"""
        talker = str(event_data.get("sessionId") or event_data.get("talkerId") or "").strip()
        if not talker:
            log.warning("图片事件缺少 sessionId/talkerId")
            return None

        target_server_id = self._normalize_message_id(
            event_data.get("serverId") or event_data.get("rawid")
        )
        target_local_id = int(event_data.get("localId") or 0)
        target_timestamp = int(event_data.get("timestamp") or 0)
        retry_delays = (0.0, 0.45, 0.8, 1.2, 1.8)

        for attempt, delay in enumerate(retry_delays, start=1):
            if delay:
                time.sleep(delay)

            # 最后一次去掉精确 API 过滤，允许按时间邻近做兼容回退。
            allow_time_fallback = attempt == len(retry_delays)
            params = {
                "access_token": config.ACCESS_TOKEN,
                "talker": talker,
                "media": "true",
                "limit": 30,
            }
            if target_timestamp > 0:
                params["start"] = max(0, target_timestamp - 20)
                params["end"] = target_timestamp + 30
            if not allow_time_fallback:
                if target_server_id:
                    params["server_id"] = target_server_id
                if target_local_id > 0:
                    params["local_id"] = target_local_id

            try:
                url = f"{config.WE_FLOW_BASE_URL}/api/v1/messages"
                resp = requests.get(url, params=params, timeout=20)
                if resp.status_code != 200:
                    log.warning(
                        f"WeFlow 消息API: HTTP {resp.status_code} "
                        f"attempt={attempt}/{len(retry_delays)}"
                    )
                    continue

                payload = resp.json()
                messages = payload if isinstance(payload, list) else payload.get("messages", payload.get("data", []))
                selected = self._select_media_message(
                    messages,
                    event_data,
                    allow_time_fallback=allow_time_fallback,
                )
                if not selected:
                    log.info(
                        f"图片消息尚未出现在 API 结果中，等待重试 "
                        f"attempt={attempt}/{len(retry_delays)} talker={talker} "
                        f"serverId={target_server_id or '-'} localId={target_local_id or '-'}"
                    )
                    continue

                media_url = str(selected.get("mediaUrl") or "").strip()
                if not media_url:
                    log.info(
                        f"已定位图片但 mediaUrl 尚未生成，等待重试 "
                        f"attempt={attempt}/{len(retry_delays)} talker={talker} "
                        f"serverId={selected.get('serverId', '-')} localId={selected.get('localId', '-')}"
                    )
                    continue

                if media_url.startswith("/"):
                    media_url = config.WE_FLOW_BASE_URL.rstrip("/") + media_url
                sep = "&" if "?" in media_url else "?"
                dl_url = media_url if "access_token=" in media_url else f"{media_url}{sep}access_token={config.ACCESS_TOKEN}"
                img_resp = requests.get(dl_url, timeout=30)
                if img_resp.status_code != 200 or not img_resp.content:
                    log.warning(
                        f"图片下载失败: HTTP {img_resp.status_code} "
                        f"attempt={attempt}/{len(retry_delays)}"
                    )
                    continue

                content_type = str(img_resp.headers.get("Content-Type", "")).lower()
                ext = ".jpg"
                if "png" in content_type:
                    ext = ".png"
                elif "gif" in content_type:
                    ext = ".gif"
                elif "webp" in content_type:
                    ext = ".webp"

                identifier = target_server_id or str(target_local_id or int(time.time() * 1000))
                safe_identifier = re.sub(r"[^a-zA-Z0-9_-]+", "_", identifier)[:80]
                filename = f"wechat_{safe_identifier}_{int(time.time() * 1000)}{ext}"
                base_dir = config.ASTRBOT_ATTACHMENTS or os.path.dirname(os.path.abspath(__file__))
                save_dir = os.path.join(base_dir, "wechat_images")
                os.makedirs(save_dir, exist_ok=True)
                save_path = os.path.join(save_dir, filename)

                with open(save_path, "wb") as image_file:
                    image_file.write(img_resp.content)

                log.info(
                    f"✅ 微信图片已保存: {save_path} "
                    f"match={'time-fallback' if allow_time_fallback else 'exact'} "
                    f"attempt={attempt}/{len(retry_delays)}"
                )
                return save_path
            except Exception as error:
                log.warning(
                    f"获取微信图片重试异常: {error} "
                    f"attempt={attempt}/{len(retry_delays)} talker={talker}"
                )

        log.warning(
            f"图片精确查询失败 (talker={talker}, serverId={target_server_id or '-'}, "
            f"localId={target_local_id or '-'}, timestamp={target_timestamp or '-'})"
        )
        return None

    def _make_image_segment(self, image_path: str) -> dict | None:
        """将本地图片编码为 AstrBot 可接收的 OneBot 图片段。"""
        try:
            with open(image_path, "rb") as image_file:
                encoded = base64.b64encode(image_file.read()).decode("ascii")
            return {"type": "image", "data": {"file": f"base64://{encoded}"}}
        except OSError as error:
            log.warning(f"读取图片失败: {error}")
            return None

    def process_image_message(self, data):
        """处理图片消息：从 WeFlow 下载后，以 OneBot 图片段直接转发。"""
        session_id = data.get("sessionId", "")
        source_name = data.get("sourceName", "") or "未知"
        group_name = data.get("groupName", "")

        log.info(f"🖼️ 收到图片: {source_name}" +
                 (f" (群:{group_name})" if group_name else ""))

        talker_id = data.get("talkerId", "") or data.get("sessionId", "")
        is_group = bool(group_name) or "@chatroom" in session_id
        image_path = self._fetch_wechat_image(data)
        image_segment = self._make_image_segment(image_path) if image_path else None
        if image_segment:
            log.info("🖼️ 微信图片已准备为 OneBot 图片段")
        else:
            log.warning("⚠️ 图片下载或编码失败，仅转发图片占位文本")

        self.add_text_to_buffer(
            talker_id,
            source_name,
            group_name,
            session_id,
            "[图片]",
            is_group,
            talker_id,
            [image_segment] if image_segment else [],
        )

    def process_emoji_message(self, data):
        """处理表情包消息：下载后作为 OneBot 图片段直接转发。"""
        session_id = data.get("sessionId", "")
        source_name = data.get("sourceName", "") or "未知"
        group_name = data.get("groupName", "")
        content = data.get("content", "[表情]")

        log.info(f"😀 收到表情包: {source_name}" +
                 (f" (群:{group_name})" if group_name else ""))

        talker_id = data.get("talkerId", "") or data.get("sessionId", "")
        is_group = bool(group_name) or "@chatroom" in session_id

        # 下载表情包并转为图片段，失败时保留原文占位。
        try:
            image_path = self._fetch_wechat_image(data)
            image_segment = self._make_image_segment(image_path) if image_path else None
            if image_segment:
                log.info("😀 表情包已准备为 OneBot 图片段")
            else:
                log.warning("😀 表情包下载或编码失败，仅转发表情占位文本")

            self.add_text_to_buffer(talker_id, source_name, group_name,
                                    session_id, content, is_group, talker_id,
                                    [image_segment] if image_segment else [])
        except Exception as e:
            log.warning(f"😀 表情包处理异常: {e}")
            # 异常时也保底发送原文
            self.add_text_to_buffer(talker_id, source_name, group_name,
                                    session_id, content, is_group, talker_id)

    def _inject_cached_image(self, image_data, buffer_key, version):
        """下载缓存图片并在缓冲计时器到期前注入 OneBot 图片段。"""
        try:
            img_path = self._fetch_wechat_image(image_data)
            image_segment = self._make_image_segment(img_path) if img_path else None

            with self.buffer_lock:
                if buffer_key in self.pending_buffers:
                    entry = self.pending_buffers[buffer_key]
                    # 版本匹配才注入（版本变了说明被新消息重置过）
                    if entry.get("timer_version") == version:
                        entry["messages"].insert(0, "[图片]")
                        if image_segment:
                            entry.setdefault("media_segments", []).insert(0, image_segment)
                            log.info("📸 缓存图片已作为 OneBot 图片段注入")
                        else:
                            log.warning("📸 缓存图片下载或编码失败，仅注入图片占位文本")
                    else:
                        log.info(f"📸 缓存图片跳过（buffer 版本已变更）")
        except Exception as e:
            log.warning(f"📸 缓存图片处理异常: {e}")

    def add_text_to_buffer(self, session_id_data, source_name, group_name,
                           session_id, content, is_group, sender_key,
                           media_segments=None):
        """通用：将一段文本直接加入缓冲队列（供表情/图片等异步处理完后调用）"""
        with self.buffer_lock:
            buffer_key = sender_key
            if buffer_key not in self.pending_buffers:
                self.pending_buffers[buffer_key] = {
                    "messages": [],
                    "media_segments": [],
                    "timer": None,
                    "timer_version": 0,
                    "processing": False,
                    "contact": group_name if is_group and group_name else source_name,
                    "is_group": is_group,
                    "source_name": source_name,
                    "session_id_data": session_id,
                    "group_name": group_name if is_group else "",
                    "sender_in_group": source_name if is_group else "",
                }
            entry = self.pending_buffers[buffer_key]
            entry["messages"].append(content)
            if media_segments:
                entry.setdefault("media_segments", []).extend(media_segments)

            if not entry["processing"]:
                if entry["timer"]:
                    entry["timer"].cancel()
                entry["timer_version"] += 1
                version = entry["timer_version"]
                delay = 2  # 表情/图片单独推送，短缓冲
                timer = threading.Timer(delay, lambda v=version, sid=buffer_key: self.process_sender(sid, v))
                timer.daemon = True
                timer.start()
                entry["timer"] = timer
                entry["timer_version"] = version
