# 在 AstrBot 中设置群聊主动回复

1.5.2 的 AstrBot 连接会将群消息逐条转发，由 AstrBot 决定会话访问、唤醒、主动回复和上下文。
AstrWeChat 的主动回复开关、概率、附加上下文和会话黑白名单均已删除。旧配置中的本地名单不再拦截收发，也不会自动写入 AstrBot；需要限制哪些会话可响应时，在 AstrBot 中配置。

## 怎么设置

1. 在 AstrWeChat 的「机器人」页面选择 AstrBot，保存连接地址和 Token。
2. 在 AstrBot「平台配置 → 白名单」启用会话白名单，填写 `/sid` 返回的会话 ID。这里控制群聊和私聊是否继续处理。AstrBot 4.28.2 的白名单为空或未启用时不限制；管理员是否豁免也由 AstrBot 配置决定。
3. 在 AstrBot「扩展功能 → 群聊上下文感知」中开启「主动回复」，选择 `possibility_reply` 并设置概率。
4. 若只希望部分群主动回复，在目标微信群发送 `/sid`，把 AstrBot 返回的完整会话 ID 填入 AstrBot 的主动回复白名单。不要直接使用微信的 `@chatroom` ID。
5. 按需要开启 AstrBot 的群聊上下文注入或持久化记录。是否进入模型、是否触发回复继续由 AstrBot 的配置和插件控制。

AstrWeChat 基础配置已移除主动回复与会话过滤卡片，不保留替代提示、会话扫描或选择列表。AstrBot 连接下的群聊模式和群消息合并不再参与判断，页面保留的是私聊消息缓冲。
机器人昵称仍建议填写正确，用于来源缺少结构化 @ 信息时识别文本中的完整昵称。

机器人页面的自定义触发词已移除，旧 `force_push_triggers` 配置不再生效，保存时自动清理。群消息逐条转发；私聊中的 `/sid`、`/help` 等斜杠指令仍立即转发，其他文字按现有私聊缓冲发送，唤醒规则在 AstrBot 中配置。

## 消息现在如何处理

| 微信消息或设置 | AstrWeChat 的处理 |
| --- | --- |
| 普通群消息 | 每条生成独立事件，保留群和发送者；不增加 @ 标记 |
| 明确 @ 机器人 | 根据来源标记或完整昵称匹配生成 `at` 消息段，保留其他文字 |
| `/sid` 等指令 | 保留指令正文，让 AstrBot 自己解析 |
| 图片、动画表情 | 保留图片段；准备失败时保留占位文字 |
| 文件 | 沿用原有文件名和本机路径文本处理，不新增文件消息段 |
| 语音、视频 | 本次保留已有文字或占位信息，不新增语音转写/视频理解 |
| 本地 `#stop`、`#start` 等指令 | 继续由 AstrWeChat 处理，停止后的旧队列消息不会重放 |
| 会话访问控制 | 由 AstrBot 原生白名单判断；Bridge 不再使用本地黑白名单 |
| 独立窗口发送 | 无需本地名单；必须找到唯一匹配的微信目标窗口，未找到或重名时停止发送 |

媒体和后续文字按接收顺序处理，因此等待图片或文件准备可能使后续转发延迟。群消息待处理队列上限为 256 条，超限会记录警告并丢弃新消息。

KouriChat 和内置模型仍保留群聊模式、消息缓冲等设置，但不再提供 AstrWeChat 自己的概率主动回复。
保存配置后会移除 `group_reply_filter_mode`、`group_reply_filter_sessions`、`active_reply_whitelist` 及废弃主动回复字段。读取旧配置或重启时，这些字段也不参与运行。

本地 `#uid`、`#status`、`#stop`、`#start`、`#ac` 仍由 AstrWeChat 处理，本地管理员身份检查保持不变；这些指令不经过 AstrBot 白名单。AstrBot 4.28.2 核心会话控制是白名单；黑名单若由插件提供，则遵循插件配置，本次没有新增或模拟 AstrBot 黑名单。

## 已验证与边界

- 桌面项目 Python Bridge：215 项回归通过。
- Node Bridge：101 项回归通过，包括旧名单丢弃、配置清理及独立窗口启动；已删除原会话选择器的 6 项测试。
- 前端和 Bridge TypeScript 类型检查通过；30 项打包测试通过。
- 对照 AstrBot **v4.28.2** 官方源码离线执行了适配器、唤醒判断片段、主动回复判断和群聊上下文记录方法，并直接执行官方会话白名单初始化和处理方法。验证群聊/私聊放行与拦截、空名单、管理员豁免，以及普通消息概率判断、真实 @、`/sid`、会话/群白名单、关闭主动回复以及图片上下文。
- 此离线检查替换了框架对象和网络 API，不等于真实微信及完整 AstrBot 服务的端到端测试。未修改用户正在使用的配置，也未发送测试消息。
- 消息事件补充了 Bridge 运行期间的递增 `message_id`、`sub_type`、`font` 和来源时间。这个 ID 是 Bridge 本地标识，不是微信服务器消息 ID；本次没有新增引用、撤回或跨重启消息检索功能。

## 开发验证

在 `1.5.2` 目录使用 PowerShell 7，安装项目现有依赖后运行：

```powershell
npm run test:bridge
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.bridge.json
node scripts/bridge-model-ui.test.cjs
```

官方源码检查所用参考文件来自以下固定版本。检查脚本只读取本地文件，不主动联网或启动机器人。

```powershell
New-Item -ItemType Directory -Force tmp/astrbot-reference
$base = 'https://raw.githubusercontent.com/AstrBotDevs/AstrBot/v4.28.2'
Invoke-WebRequest "$base/astrbot/core/platform/sources/aiocqhttp/aiocqhttp_platform_adapter.py" -OutFile tmp/astrbot-reference/adapter.py
Invoke-WebRequest "$base/astrbot/core/pipeline/waking_check/stage.py" -OutFile tmp/astrbot-reference/waking_check.py
Invoke-WebRequest "$base/astrbot/builtin_stars/astrbot/group_chat_context.py" -OutFile tmp/astrbot-reference/group_chat_context.py
Invoke-WebRequest "$base/astrbot/core/pipeline/whitelist_check/stage.py" -OutFile tmp/astrbot-reference/whitelist_check.py
python -B scripts/verify-astrbot-native.py --source-dir tmp/astrbot-reference
```

参考文件的 SHA-256：

- `adapter.py`：`8fc25fd07d5af724b4db1b123524a875c1eb1f46e98cbbaaa6c1e92b7cbde7d2`
- `waking_check.py`：`2d5160944f6123b2b76aa95ef5367c0d412d8b053a33d5da7a5ca1168a69bc8a`
- `group_chat_context.py`：`fadd15e4d9d7b2956b6d0c7fdd7f8a314947d8604018bd3de7fc0a86cb013192`
- `whitelist_check.py`：`6133fbf89bd8a91800fd1945db6d93cc161641a526c93bae599f4122c8ed9b2a`
