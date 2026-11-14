# AstrWeChat 1.3.1 Bridge 启动预检超时修复

## 结论与验证边界

用户反馈：数据库连接成功，但 Bridge 两次停在“检查微信数据库连接”并超时。

本地日志确认，AstrWeChat.exe 的原生初始化成功，数据库句柄已经打开，会话库和联系人诊断也成功。这不是此前改名引发的 -1006 重现。

源码存在可复现的状态检查阻塞缺陷：Bridge 的连接预检通过 WcdbService.isConnected 向同一个查询 Worker 发送消息；Worker 正在执行同步原生查询时，连只检查 initialized/handle 的状态请求也不能及时处理。Bridge 超时后再次重试只会继续排队。旧代码的 Worker 正常退出路径也可能遗留未拒绝的 Promise。

现有日志没有记录超时瞬间的具体未完成请求，因此不能据此断言某一个查询函数已经永久死锁。本次修复的是状态检查的队列依赖、相关生命周期一致性，并新增安全的后台请求提示；不代表已经修好所有潜在原生查询性能问题。

## 范围

- 仅修改 1.3.1；保留 1.3.0 和当前安装版。
- 保留 AstrWeChat.exe 名称及已验证的构建期 DLL 适配；不再修改原生 DLL。
- 未使用用户真实数据库或机器人账号进行端到端测试，未自动安装或重启当前软件。
- 测试使用模拟 Worker/HTTP/子进程，Python 测试不连接真实业务账号。

## 证据链

E1：只读检查现有 wcdb.log，观察到本次 AstrWeChat.exe 的 init warmup succeeded、open ok handle、message-db 发现成功、contact count 查询成功以及 open succeeded。不把账号路径和聊天信息复制进报告。

E2：调用链为 electron/main.ts 的 BridgeWechatSource.isDatabaseConnected → wcdbService.isConnected → callWorker('isConnected') → wcdbWorker → core.isConnected。最后一步原本仅返回 initialized && handle !== null，不需要数据库查询。

E3：新增 wcdb-connection-state.test.cjs 首个用例：先让真实 WcdbService 收到 open 成功响应，再模拟长时间未结束的 getSessions。旧代码在 100ms 上限内无法返回连接状态，测试失败；修复后不再发送 isConnected RPC，测试通过。

E4：新增 17 项状态/协议/Bridge 预检回归，覆盖首次未连接、初始化但未打开、open 未完成、关闭排队、同账号复用、排队关闭后的重开、testConnection 恢复失败、Worker 错误/正常退出、旧 Worker 回包、失败 open、发送异常、敏感数据不泄露、正式 Worker 响应协议和忙查询下的 Bridge 预检。

F1：状态检查不应依赖繁忙查询队列；已通过隔离复现证实并修复。具体业务现场的最长查询仍需新诊断日志确认。

P1：Worker 完成操作 → 随响应发送真实句柄状态 → 主进程维护确认状态 → Bridge 本地读取确认状态 → 启动本地 API/推送准备，不等待数据库查询队列空闲。

## 修改

- wcdbWorker.ts：普通响应及异常响应携带 core.isConnected() 的真实状态。
- wcdbService.ts：维护 Worker 确认状态；isConnected 不再排队发消息，不因“存在配置”或“存在线程”就宣称连接成功。
- 生命周期操作一经排队便暂时判为未连接；关闭、切号、错误、退出时使状态失效。
- Worker 正常退出也拒绝未完成请求；旧 Worker 的迟到响应不影响新 Worker。
- 同账号且已确认打开、又没有排队生命周期任务时，复用现有连接，不再让推送预热重新排队 open。
- postMessage 同步异常清理 pending，避免诊断和内存条目残留。
- BridgeWechatSource：如有超过 5 秒的未完成请求，显示请求类型和等待秒数，同时明确提示消息读取可能延迟。只显示类型/时长，不输出账号、SQL、密钥或 token。
- package.json：test:bridge 加入新的连接状态测试。

连接状态表示“已确认存在有效句柄”，不是对查询响应速度的保证。若原生查询长期不返回，Bridge 可以通过连接预检，但实际消息读取仍可能延迟；新增警告用于暴露此问题，而不是将其隐藏。

## 验证

- 93 项 Node 回归测试通过，日志保存在 tmp/bridge-fix-tests.log。
- 11 项 Python Bridge 测试通过。
- 全项目及 Bridge 专用 TypeScript 检查通过。
- 编译前端、主进程、Worker；构建单独的 Windows x64 修复包。
- 未实际安装修复包，未确认真实消息收发。

## 构建与试用

修复包输出位置：release/AstrWeChat-1.3.1-Setup.exe。

发布产物已统一为标准 release 目录，先前实验包移入本地 tmp 归档。关闭现有软件后手动安装本修复包，连接数据库，再启动 Bridge。若出现“后台请求仍在执行”警告，保留其中请求类型和等待时间；若 Bridge 启动后仍收不到消息，需要沿该请求继续排查，而不是继续增加启动超时时间。

不会更改用户原有配置目录或执行数据库迁移。

## 用户反馈与标准发布

2026-09-19：用户确认新修改可用，要求提交 Git，并恢复标准 release 目录和 AstrWeChat-1.3.1-Setup.exe 文件名。以上历史测试边界保留；本次仅整理发布方式，不回退已验证的功能修复。
