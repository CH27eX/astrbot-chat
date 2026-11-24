# astrbot_plugin_webchat_admin

给 WebChat 客户端（[astrbot-chat](../..)）补三个 **AstrBot 自带 HTTP API 做不到** 的接口。

## 为什么需要它

AstrBot 的会话接口在服务层硬比较 `session.creator == username`（`chat_service.py`
`delete_webchat_session` / `update_session_display_name` / `get_session`），而 API Key 的身份是
`api_key:<key_id>`，会话的 creator 却是 WebChat 用户名（例如 `astrbot`）——两者永远不相等。
结果是：用 API Key 删会话、改会话名、读会话详情，**必然 `Permission denied`**；legacy 路由又要
面板 JWT。插件跑在 AstrBot 进程里，用自己的身份操作数据库，这条限制就绕开了。

## 安装

把整个目录放到 AstrBot 的插件目录（`data/plugins/`）下，然后在面板里重载插件：

```
data/plugins/astrbot_plugin_webchat_admin/
├── main.py
└── metadata.yaml
```

要求 AstrBot **v4.26+**（`register_web_api` + `astrbot.api.web.request`）。

## 接口

前缀：`/api/v1/plugins/extensions/astrbot_plugin_webchat_admin/`，**需要 `plugin` scope 的 API Key**。

| 方法 | 路径 | 参数 | 返回 |
|---|---|---|---|
| GET | `health` | — | `{plugin, version, features}` |
| GET | `history` | `session_id`, `page=1`, `page_size=100` | `{messages[], hasMore, total, displayName}` |
| POST | `rename` | `{session_id, name}`（空字符串 = 清除备注名） | `{session_id, display_name}` |
| POST | `delete` | `{session_id}` | `{deleted, session_id}` |

消息形状和 BFF 的 `parseHistoryRow` 一致：
`{id:"m<dbid>", role:"user"|"assistant", text, media:[{type,attachmentId,filename}], sender, createdAt}`。

约定：成功 `{"status":"ok","message":"","data":{...}}`，失败 `{"status":"error","message":"..."}`；
**HTTP 状态码一律 200**，调用方必须看 `status`。

## 安全

- 只操作 `platform_id == "webchat"` 的会话，不会误删 QQ 会话。
- 删除会清掉：该会话的 conversations（LLM 上下文）、消息历史、WebChat 侧线程、会话行。
- 权限边界就是 AstrBot 的 `plugin` scope：能拿到这把 Key 的人本来就能管插件。

## 许可

MIT。运行时依赖 AstrBot（AGPL-3.0-or-later），本插件通过公开插件接口与其交互。
