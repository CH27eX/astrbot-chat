"""WebChat Admin —— 给 WebChat 客户端补三个 AstrBot HTTP API 做不到的接口。

背景：AstrBot 的 `/api/v1/chat/sessions*` 在服务层硬比较 `session.creator == username`，
而 API Key 的身份是 `api_key:<key_id>`，所以用 Key 调「删会话 / 改名 / 读会话详情」永远是
`Permission denied`；legacy 路由又要求面板 JWT。插件运行在 AstrBot 进程里，可以用自己的
身份直接操作数据库，这条限制就绕开了。

接口（都挂在 /api/v1/plugins/extensions/astrbot_plugin_webchat_admin/ 下，需要 plugin scope）：

    GET  health                         → {status, data:{plugin, version, features}}
    GET  history?session_id&page&page_size
                                        → {data:{messages[], hasMore, total, displayName}}
    POST rename   {session_id, name}    → {data:{session_id, display_name}}
    POST delete   {session_id}          → {data:{deleted, session_id}}

约定：成功 {"status":"ok","message":"","data":{...}}，失败 {"status":"error","message":"..."}；
HTTP 状态码一律 200（和 AstrBot 面板一致，调用方要看 status，不能只看状态码）。
"""

from __future__ import annotations

import time
from datetime import datetime, timezone

from astrbot.api import logger
from astrbot.api.star import Context, Star, register

try:  # v4.26+：插件 Web API 的请求对象
    from astrbot.api.web import request as _request
except ImportError:  # 更早的版本没有这个代理
    _request = None

PLUGIN_NAME = "astrbot_plugin_webchat_admin"
ROUTE_PREFIX = f"/{PLUGIN_NAME}/"
VERSION = "0.1.1"
MAX_PAGE_SIZE = 500
WEBCHAT = "webchat"


def _ok(data: dict | None = None, message: str = "") -> dict:
    return {"status": "ok", "message": message, "data": data or {}}


def _err(message: str) -> dict:
    return {"status": "error", "message": message, "data": {}}


def _query(name: str, default: str = "") -> str:
    if _request is None:
        return default
    value = _request.query.get(name, default)
    return str(value if value is not None else default)


async def _body() -> dict:
    if _request is None:
        return {}
    data = await _request.json(default={})
    return data if isinstance(data, dict) else {}


def _iso(value: datetime | None) -> str:
    if not isinstance(value, datetime):
        return ""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _serialize_message(row) -> dict:
    """把 platform_message_history 的一行翻成客户端认识的形状（和 BFF 的 parseHistoryRow 对齐）。"""
    content = row.content if isinstance(row.content, dict) else {}
    role = "user" if content.get("type") == "user" else "assistant"
    segments = content.get("message")
    if not isinstance(segments, list):
        segments = []

    texts: list[str] = []
    media: list[dict] = []
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        kind = segment.get("type")
        if kind == "plain":
            texts.append(str(segment.get("text") or ""))
        elif kind in ("image", "record", "video", "file"):
            media.append(
                {
                    "type": kind,
                    "attachmentId": segment.get("attachment_id"),
                    "filename": segment.get("filename"),
                }
            )

    return {
        "id": f"m{row.id}",
        "role": role,
        "text": "\n".join(texts),
        "media": media,
        "sender": row.sender_name or "",
        "createdAt": _iso(row.created_at),
    }


@register(PLUGIN_NAME, "astrbot-chat", "给 WebChat 客户端补读历史/改名/删会话三个接口", VERSION)
class WebchatAdminPlugin(Star):
    def __init__(self, context: Context, config: dict | None = None) -> None:
        super().__init__(context, config)
        self._register()
        logger.info(f"[webchat_admin] v{VERSION} 已加载")

    async def initialize(self) -> None:
        self._register()

    async def terminate(self) -> None:
        self._unregister()

    # ---------------- 注册 ----------------

    def _routes(self):
        return [
            ("health", ["GET"], self.health, "WebChat Admin：探活"),
            ("history", ["GET"], self.history, "WebChat Admin：读会话历史"),
            ("rename", ["POST"], self.rename, "WebChat Admin：改会话名"),
            ("delete", ["POST"], self.delete_session, "WebChat Admin：删会话"),
        ]

    def _register(self) -> None:
        context = getattr(self, "context", None)
        register_api = getattr(context, "register_web_api", None)
        if not callable(register_api):
            logger.info(
                "[webchat_admin] 当前 AstrBot 没有 register_web_api（需要 v4.26+），接口不注册"
            )
            return
        self._unregister()  # 插件重载时先清掉旧路由
        try:
            for path, methods, handler, desc in self._routes():
                register_api(ROUTE_PREFIX + path, self._wrap(handler), methods, desc)
        except Exception as exc:  # noqa: BLE001 - 注册失败不能拖垮插件加载
            logger.warning(f"[webchat_admin] 注册 Web 接口失败：{exc}")

    def _unregister(self) -> None:
        context = getattr(self, "context", None)
        apis = getattr(context, "registered_web_apis", None)
        if isinstance(apis, list):
            apis[:] = [
                api
                for api in apis
                if not str((api[0] if api else "") or "").startswith(ROUTE_PREFIX)
            ]

    @staticmethod
    def _wrap(handler):
        async def view(*_args, **_kwargs):
            try:
                return await handler()
            except Exception as exc:  # noqa: BLE001 - 接口异常要变成 JSON，不能 500
                logger.warning(f"[webchat_admin] 接口出错：{exc}")
                return _err(str(exc))

        return view

    # ---------------- 工具 ----------------

    def _db(self):
        return self.context.get_db()

    async def _get_webchat_session(self, session_id: str):
        session = await self._db().get_platform_session_by_id(session_id)
        if session is None:
            return None
        if session.platform_id != WEBCHAT:
            return None
        return session

    # ---------------- 接口实现 ----------------

    async def health(self) -> dict:
        return _ok(
            {
                "plugin": PLUGIN_NAME,
                "version": VERSION,
                "features": ["history", "rename", "delete"],
                "ts": int(time.time()),
            }
        )

    async def history(self) -> dict:
        session_id = _query("session_id").strip()
        if not session_id:
            return _err("缺少 session_id")
        session = await self._get_webchat_session(session_id)
        if session is None:
            return _err("会话不存在（或不是 WebChat 会话）")

        try:
            page = max(int(_query("page", "1") or 1), 1)
            page_size = min(max(int(_query("page_size", "100") or 100), 1), MAX_PAGE_SIZE)
        except ValueError:
            return _err("page / page_size 必须是整数")

        db = self._db()
        # 多取一条用来判断 hasMore：AstrBot 4.27.x 没有 count_platform_message_history，
        # 不能直接调（会 AttributeError），所以计数是「有则用、无则靠多取一条」。
        rows = list(
            await db.get_platform_message_history(
                platform_id=session.platform_id,
                user_id=session.session_id,
                page=page,
                page_size=page_size + 1,
            )
        )
        overflow = len(rows) > page_size
        if overflow:
            rows = rows[:page_size]

        total = await self._count_history(db, session)
        if total is None:
            has_more = overflow
        else:
            has_more = page * page_size < total

        # 库里是「新 → 旧」，客户端要「旧 → 新」
        messages = [_serialize_message(row) for row in reversed(rows)]
        return _ok(
            {
                "messages": messages,
                "hasMore": has_more,
                "total": total,
                "displayName": session.display_name,
                "page": page,
                "pageSize": page_size,
            }
        )

    @staticmethod
    async def _count_history(db, session) -> int | None:
        """总条数：老版本 AstrBot 没有这个接口，返回 None 让调用方退回「多取一条」。"""
        counter = getattr(db, "count_platform_message_history", None)
        if not callable(counter):
            return None
        try:
            return int(await counter(session.platform_id, session.session_id))
        except Exception:  # noqa: BLE001 - 计数失败不该让整页历史报错
            logger.warning("[webchat_admin] 统计历史条数失败", exc_info=True)
            return None

    async def rename(self) -> dict:
        payload = await _body()
        session_id = str(payload.get("session_id") or "").strip()
        if not session_id:
            return _err("缺少 session_id")
        session = await self._get_webchat_session(session_id)
        if session is None:
            return _err("会话不存在（或不是 WebChat 会话）")

        raw = payload.get("name")
        # 注意：AstrBot 的 update_platform_session 对 display_name=None 是「不动这一列」，
        # 想清掉备注名必须显式写空字符串（AstrBot 面板显示时会把空串当没有名字）。
        display_name = ""
        if isinstance(raw, str):
            trimmed = raw.strip()
            display_name = trimmed[:100] if trimmed else ""

        await self._db().update_platform_session(
            session_id=session_id,
            display_name=display_name,
        )
        return _ok({"session_id": session_id, "display_name": display_name})

    async def delete_session(self) -> dict:
        payload = await _body()
        session_id = str(payload.get("session_id") or "").strip()
        if not session_id:
            return _err("缺少 session_id")
        session = await self._get_webchat_session(session_id)
        if session is None:
            # 幂等：已经不存在就当删过了
            return _ok({"deleted": False, "session_id": session_id, "reason": "not found"})

        db = self._db()
        kind = "GroupMessage" if getattr(session, "is_group", 0) else "FriendMessage"
        umo = (
            f"{session.platform_id}:{kind}:"
            f"{session.platform_id}!{session.creator}!{session.session_id}"
        )

        # 1) LLM 上下文（conversations）2) 消息历史 3) WebChat 侧线程 4) 会话行
        await db.delete_conversations_by_user_id(umo)
        await db.delete_platform_message_offset(
            session.platform_id, session.session_id, 99999999
        )
        await db.delete_webchat_threads_by_parent_session(session.session_id)
        await db.delete_platform_session(session.session_id)

        logger.info(f"[webchat_admin] 已删除会话 {session_id}")
        return _ok({"deleted": True, "session_id": session_id})
