"""Render only the temporary Heybox page explicitly created by GRIP."""

import asyncio
import json
import re
from pathlib import Path


SOURCE_URL = re.compile(r"https://www\.xiaoheihe\.cn/app/bbs/link/[a-f0-9]{12}")
MARKER = re.compile(r"[a-f0-9]{32}")
BUNDLE_PATH = Path(__file__).resolve().parent.parent / "dist" / "heybox-render.js"
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_WEBSOCKET_BYTES = 8 * 1024 * 1024
CAPTURE_TIMEOUT_SECONDS = 120
DISCOVERY_TIMEOUT_SECONDS = 20
POLL_SECONDS = 0.2


def _websocket_url(value):
    if not isinstance(value, str) or not re.fullmatch(
        r"ws://(?:localhost|127\.0\.0\.1):8080/devtools/page/[A-Za-z0-9_-]+",
        value,
    ):
        raise ValueError("拒绝连接非本地的小黑盒渲染页面")
    return value


async def _find_target(session, expected_url):
    while True:
        async with session.get(
            "http://localhost:8080/json", allow_redirects=False
        ) as response:
            if response.status != 200:
                raise RuntimeError("无法读取 Steam 本地浏览器页面")
            body = bytearray()
            async for chunk in response.content.iter_chunked(64 * 1024):
                body.extend(chunk)
                if len(body) > MAX_RESPONSE_BYTES:
                    raise ValueError("Steam 本地页面列表超过大小限制")
            targets = json.loads(body)
        if not isinstance(targets, list):
            raise ValueError("Steam 本地页面列表格式无效")
        matches = [
            target
            for target in targets
            if isinstance(target, dict)
            and target.get("type") == "page"
            and target.get("url") == expected_url
        ]
        if len(matches) > 1:
            raise ValueError("发现多个小黑盒临时页面，请重新导入")
        if matches:
            return _websocket_url(matches[0].get("webSocketDebuggerUrl"))
        await asyncio.sleep(POLL_SECONDS)


async def _capture(source_url, expected_url, bundle):
    # Decky already ships aiohttp; importing lazily keeps local non-Decky tests usable.
    import aiohttp

    async def reject_redirect(_session, _context, _params):
        raise ValueError("本地渲染连接不接受重定向")

    trace = aiohttp.TraceConfig()
    trace.on_request_redirect.append(reject_redirect)
    async with aiohttp.ClientSession(
        timeout=aiohttp.ClientTimeout(total=5), trace_configs=[trace]
    ) as session:
        websocket_url = await asyncio.wait_for(
            _find_target(session, expected_url), timeout=DISCOVERY_TIMEOUT_SECONDS
        )
        async with session.ws_connect(
            websocket_url, max_msg_size=MAX_WEBSOCKET_BYTES
        ) as websocket:
            # The guard executes in the target context before any bundle code runs.
            guard = (
                f"if (globalThis.location.href !== {json.dumps(expected_url)}) "
                '{ throw new Error("GRIP 临时页面已离开原文，请重新导入"); }'
            )
            expression = (
                f"(async () => {{ {guard}\n{bundle}\n;{guard}\n"
                "const guide = await GRIPHeyboxRenderer"
                f".renderHeyboxArticle({json.dumps(source_url)});\n"
                f"{guard}\nreturn JSON.stringify(guide); }})()"
            )
            await websocket.send_json(
                {
                    "id": 1,
                    "method": "Runtime.evaluate",
                    "params": {
                        "expression": expression,
                        "awaitPromise": True,
                        "returnByValue": True,
                    },
                }
            )
            while True:
                message = await websocket.receive()
                if message.type != aiohttp.WSMsgType.TEXT:
                    raise RuntimeError("小黑盒临时页面已关闭或渲染连接中断")
                if len(message.data.encode("utf-8")) > MAX_WEBSOCKET_BYTES:
                    raise ValueError("小黑盒渲染结果超过大小限制")
                reply = json.loads(message.data)
                if not isinstance(reply, dict):
                    raise ValueError("小黑盒渲染响应格式无效")
                if reply.get("id") != 1:
                    continue
                result = reply.get("result")
                if (
                    "error" in reply
                    or not isinstance(result, dict)
                    or "exceptionDetails" in result
                ):
                    details = result.get("exceptionDetails") if isinstance(result, dict) else None
                    description = None
                    if isinstance(details, dict):
                        exception = details.get("exception")
                        if isinstance(exception, dict):
                            description = exception.get("description")
                        if not isinstance(description, str):
                            description = details.get("text")
                    message = (
                        description.strip().splitlines()[0][:500]
                        if isinstance(description, str) and description.strip()
                        else "小黑盒文章渲染失败，请确认原文可以公开访问"
                    )
                    raise RuntimeError(message)
                remote = result.get("result")
                value = remote.get("value") if isinstance(remote, dict) else None
                if not isinstance(value, str):
                    raise ValueError("小黑盒文章没有返回有效正文")
                if len(value.encode("utf-8")) > MAX_RESPONSE_BYTES:
                    raise ValueError("小黑盒渲染结果超过大小限制")
                guide = json.loads(value)
                if not isinstance(guide, dict) or guide.get("sourceUrl") != source_url:
                    raise ValueError("小黑盒渲染结果与导入原文不一致")
                return guide


async def capture_heybox(source_url: str, marker: str) -> dict:
    """Capture the marked page; Rust validates its untrusted article before storage."""
    if not isinstance(source_url, str) or not SOURCE_URL.fullmatch(source_url):
        raise ValueError("仅支持小黑盒公开文章的完整链接")
    if not isinstance(marker, str) or not MARKER.fullmatch(marker):
        raise ValueError("小黑盒临时页面标记无效")
    try:
        bundle = BUNDLE_PATH.read_text(encoding="utf-8")
    except OSError as error:
        raise RuntimeError("小黑盒渲染组件缺失，请重新安装插件") from error
    if not bundle.strip():
        raise RuntimeError("小黑盒渲染组件为空，请重新安装插件")
    try:
        return await asyncio.wait_for(
            _capture(source_url, f"{source_url}#grip-import-{marker}", bundle),
            timeout=CAPTURE_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError as error:
        raise TimeoutError("小黑盒文章渲染超时，请保持临时页面打开后重试") from error
