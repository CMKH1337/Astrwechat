"""
OneBot WebSocket 客户端模块。

维护到 当前选中的机器人服务端的 WebSocket 长连接，
推送事件并从服务端接收 API 请求。
"""

import asyncio
import json
import logging
import threading

import websockets

import state
import config
from connection_config import safe_endpoint
from ob_protocol import _handle_ob_api

log = logging.getLogger("ob11-bridge")


def _client_is_active(generation: int) -> bool:
    """Only the newest bridge run may own the reverse WebSocket connection."""
    return state.running and state.ob_client_generation == generation


async def _retry_delay(generation: int, seconds: float = 5.0) -> bool:
    """Sleep interruptibly so stop/start cannot leave an old client reconnecting."""
    deadline = asyncio.get_running_loop().time() + seconds
    while _client_is_active(generation):
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            return True
        await asyncio.sleep(min(0.1, remaining))
    return False


def _run_ob_client(generation: int):
    """后台线程：维护到当前服务端的 WebSocket 连接。"""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    if state.ob_client_generation != generation:
        loop.close()
        return

    state._ob_ws_loop = loop
    try:
        loop.run_until_complete(_ob_client_main(generation))
    finally:
        try:
            loop.close()
        except Exception:
            pass

        # A superseded client must never clear a newer client's connection.
        if state._ob_ws_loop is loop:
            state._ob_ws_loop = None
        if state.ob_client_thread is threading.current_thread():
            state.ob_client_thread = None
            state.ob_client_started = False
        if state.ob_client_generation == generation:
            state._ob_ws = None
            state.set_ob_connected(False)


async def _ob_client_main(generation: int):
    """连接当前服务端，推送事件并接收 OneBot API 请求。"""
    while _client_is_active(generation):
        ws = None
        try:
            state.set_ob_connection("connecting")
            log.info(f"[OB11] 正在连接 {config.OB_LABEL}: {safe_endpoint(config.OB_URL)}")
            headers = {
                "X-Self-ID": str(state._self_id_int),
                "X-Client-Role": "Universal",
                "User-Agent": "OneBot/11",
            }
            if config.OB_TOKEN:
                headers["Authorization"] = f"Bearer {config.OB_TOKEN}"

            async with websockets.connect(
                config.OB_URL,
                additional_headers=headers,
                open_timeout=10, close_timeout=2, max_size=10 * 1024 * 1024,
            ) as ws:
                if not _client_is_active(generation):
                    break

                state._ob_ws = ws
                state.set_ob_connected(True)
                log.info(f"[OB11] ✅ 已连接到 {config.OB_LABEL}")

                async def _keepalive():
                    while _client_is_active(generation):
                        await asyncio.sleep(15)
                        try:
                            await ws.ping()
                        except Exception:
                            break

                ka_task = asyncio.create_task(_keepalive())
                try:
                    # 顺序处理 API 请求：先立即回响应，再按 FIFO 入发送队列。
                    async for raw in ws:
                        if not _client_is_active(generation):
                            break
                        try:
                            data = json.loads(raw)
                            await _handle_ob_api(data)
                        except json.JSONDecodeError:
                            log.warning("[OB11] 收到无效 JSON")
                        except Exception as e:
                            log.error(f"[OB11] 处理 API 异常: {e}")
                finally:
                    ka_task.cancel()
                    try:
                        await ka_task
                    except asyncio.CancelledError:
                        pass

        except websockets.exceptions.ConnectionClosed as exc:
            if _client_is_active(generation):
                code = getattr(getattr(exc, "rcvd", None), "code", None)
                error = (f"{config.OB_LABEL} 鉴权失败，请检查两端 Token"
                         if code in (4001, 4003, 1008)
                         else f"{config.OB_LABEL} 连接断开，5 秒后重连")
                state.set_ob_connection("error", error)
                log.warning(f"[OB11] {error}")
        except (ConnectionRefusedError, OSError):
            if _client_is_active(generation):
                error = f"无法连接 {config.OB_LABEL}，请确认服务已启动、地址及端口正确；5 秒后重试"
                state.set_ob_connection("error", error)
                log.warning(f"[OB11] {error}")
        except Exception as exc:
            if _client_is_active(generation):
                response = getattr(exc, "response", None)
                code = getattr(response, "status_code", None) or getattr(exc, "status_code", None)
                error = (f"{config.OB_LABEL} 鉴权失败，请检查两端 Token"
                         if code in (401, 403)
                         else f"{config.OB_LABEL} 连接失败，请检查 WS 地址、服务端和证书；5 秒后重试")
                state.set_ob_connection("error", error)
                log.error(f"[OB11] {error}")
        finally:
            if ws is not None and state._ob_ws is ws:
                state._ob_ws = None
                if state.ob_state == "connected":
                    state.set_ob_connection("disconnected")

        if not _client_is_active(generation):
            break
        if not await _retry_delay(generation):
            break
