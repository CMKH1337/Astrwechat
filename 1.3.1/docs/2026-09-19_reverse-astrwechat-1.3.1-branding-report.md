# AstrWeChat 1.3.1：EXE 自有命名适配实验报告

日期：2026-09-19。状态：已构建 Windows x64 测试安装包；尚未完成真实账号数据库端到端验收。

## 结论

已在全新隔离进程中复现：原始 DLL 下，WeFlow.exe / electron.exe 初始化成功，AstrWeChat.exe 初始化返回 -1006，原生日志为 SecurityStatus:2。适配后，AstrWeChat.exe 的原生主线程、普通 Worker、正式构建 Worker 均能初始化，InitProtection 和 wcdb_init 的原生探针返回值均为 0。无关名称 Unrelated.exe 仍然失败，说明没有简单地跳过整个校验。

这里的对照使用相同 Electron 运行时的重命名副本。实际打包 DLL 和 ASAR 中的正式 Worker 也通过此对照；真正打包的 EXE 带 requireAdministrator，普通进程直接启动被 Windows 以 EACCES 拒绝，随后请求正常 UAC 隔离探针验证，但 UAC 操作被用户取消，已停止提权测试，没有绕过权限限制。该权限问题不能计为 WCDB 初始化失败，真实打包 EXE 的运行测试也不能计为通过。

本次不是解除任意文件名限制，仅支持 AstrWeChat[.exe] 这一自有名称。真实聊天数据库、安装升级流程、桥接消息收发尚未验收。

## 范围

见 `branding-1.3.1-scope.md`。变更仅在 1.3.1 副本。1.3.0、原有安装版以及仓库 resources 下的原始 DLL 未改动。为兼容现有配置，用户数据目录仍保留 weflow；这不是一次全仓库内部命名或数据目录迁移。

## Evidence → Finding → Path

| Evidence | 来源与复现 | 结论 |
|---|---|---|
| E1 | `branding-1.3.1-evidence/host-name-comparison.txt`，使用 pefile 2024.8.26 / Capstone 5.0.9 对原始 DLL 只读反汇编 | 宿主名称转小写后，比较长度和常量；不匹配时写入安全状态 2 |
| E2 | `branding-1.3.1-evidence/baseline-full.json`；在 1.3.1 执行 `node scripts/wcdb-branding-probe.cjs` | 原始 DLL 下，AstrWeChat.exe 在三个上下文均初始化失败；WeFlow.exe 成功 |
| E3 | `branding-1.3.1-evidence/packaged-dll-worker.json`；按下方复现步骤运行 | 打包后的适配 DLL 与正式 ASAR Worker 在 AstrWeChat 名称下初始化成功，无关名称继续被拒绝 |
| E4 | `node --test scripts/verify-package.test.cjs scripts/wcdb-host-branding.test.cjs` | 15 项测试通过，包含错误 DLL 哈希拒绝、幂等性、原始资源不变、afterPack 集成、错误架构拒绝 |
| E5 | `tsc --noEmit`、Vite 构建、electron-builder x64 NSIS 构建、verify-package | 编译和打包成功，实际主程序为 AstrWeChat.exe，产品版本 1.3.1 |
| E6 | 统计范围、Bridge 连接、消息数据库诊断三组现有 Node 测试 | 61 项通过；这些是单元/模拟测试，不代表真实账号验收 |

F1：高置信已确认此次改名触发 -1006 的原因是宿主名称校验，不是数据库密钥被改名影响。位置：原生比较函数 VA 0x18006D520。状态：已复现并在隔离环境验证修复。

F2：适配与具体 x64 DLL 版本绑定；更换 DLL 或使用 ARM64 不得沿用偏移。状态：构建脚本已加入哈希检查和架构阻断。

P1，callflow：程序实际文件名 → 原生名称标准化 → 名称常量比较 → SecurityStatus → wcdb_init → WcdbCore.initialize → 正式 WCDB Worker。原有返回码处理保持不变。

## 实现方式

原生源码当前不可用，因此采用可复现、限定哈希的构建期二进制适配，而不是声称已经修改并重编译了原生源码。

仅复用现有 `ciphertalk[.exe]` 名称比较槽位，将其替换为等长 `astrwechat[.exe]`。相应的原名称槽位不再保留；WeFlow 和 electron 的其他比较分支保持不变。

| 文件偏移 | 原比较常量 | 新比较常量 |
|---|---|---|
| 0x6CB36 | cipherta | astrwech |
| 0x6CB50 | lk.e | at.e |
| 0x6CB8C | lk | at |

没有改函数入口、条件跳转、成功返回值或数据库读写函数。原 DLL 没有 Authenticode 证书目录。本次不声称已验证原生组件所有其他功能。

原始 DLL SHA-256：`6397760da70de8062829fbe6a2ec01cf0616d6f2b334e6fe54873898f38f7ad7`

适配 DLL SHA-256：`2630fe8140957384bdae19721fbff8c0ac7874cf1a72a23f1537555dbffe8ed7`

## 工程改动

- `package.json`：仅 Windows 的 executableName 设为 AstrWeChat，接入 beforePack 和测试命令；其他平台原有命名不随意改动。
- `electron/main.ts`：Windows x64 的 app 名称为 AstrWeChat，保留既有用户数据目录。
- `scripts/wcdb-host-branding.cjs`：校验完整输入哈希与三个常量，复制内存缓冲区后适配，校验完整输出哈希；未知版本直接拒绝。
- `scripts/before-pack.cjs`：阻止尚未验证的 Windows 非 x64 架构产出错误包。
- `scripts/after-pack.cjs`：只适配输出目录中的 DLL，不改 resources 中的原始文件。
- `scripts/verify-package.cjs`：检查 AstrWeChat.exe 存在，且输出 DLL 哈希正确。
- 两组打包/适配测试：校验最小字节变化、原资源不变、错误库拒绝和 afterPack 集成。
- `scripts/wcdb-branding-probe.cjs`：临时配置、每个上下文独立进程、12 项矩阵断言；正式 Worker 原样记录响应，不伪造原生返回码。
- `installer.nsh`：更新说明；快捷方式继续使用构建器的真实主程序文件名变量。

## 初次实验产物（历史记录）

这些路径和哈希记录初次实验，不是最终安装包。标准产物现为 `release/AstrWeChat-1.3.1-Setup.exe` 和 `release/win-unpacked/AstrWeChat.exe`；先前实验输出已移入 tmp 归档。

相对本版本目录：

- 测试安装包：`release/branding-1.3.1/AstrWeChat-1.3.1-Setup.exe`
- 未安装程序：`release/branding-1.3.1/win-unpacked/AstrWeChat.exe`
- 安装包大小：121129055 字节。
- 安装包 SHA-256：`155cee0d45d7ffbb89bde3e866fa72c80edfa3da8b850f4387e522dcff6282e4`

没有自动安装；旧的 release 根目录产物是复制来的历史文件，不是本次测试包。

## 复现

在 1.3.1 目录的 PowerShell 中执行：

```powershell
node --test scripts/verify-package.test.cjs scripts/wcdb-host-branding.test.cjs
node node_modules/typescript/bin/tsc --noEmit
node scripts/run-electron.cjs --build-only
node node_modules/electron-builder/out/cli/cli.js --win nsis --x64 --publish never --config.electronDist=node_modules/electron/dist

$base = (Resolve-Path 'release/win-unpacked').Path
$env:WCDB_PROBE_DLL_DIR = Join-Path $base 'resources/resources/wcdb/win32/x64'
$env:WCDB_PROBE_WORKER_PATH = Join-Path $base 'resources/app.asar/dist-electron/wcdbWorker.js'
$env:WCDB_PROBE_LABEL = 'packaged-dll-worker'
node scripts/wcdb-branding-probe.cjs
Remove-Item Env:WCDB_PROBE_DLL_DIR,Env:WCDB_PROBE_WORKER_PATH,Env:WCDB_PROBE_LABEL
```

探针默认验证原始 DLL 行为，拒绝未知 DLL 哈希。传入打包 DLL 路径后则验证新行为。测试不会打开账号数据库。

## 时间线与后续边界

- 2026-09-19：完成原始 DLL 的四名称 × 三上下文对照，定位名称判断。
- 2026-09-19：只在临时 DLL 副本替换三处等长常量，验证 AstrWeChat 初始化成功。
- 2026-09-19：将适配接入 Windows x64 构建钩子，完成类型检查、15 项打包/适配测试和 61 项既有回归。
- 2026-09-19：生成独立测试安装包，验证包内 DLL 和 ASAR Worker；真实 EXE 普通启动受管理员清单约束，UAC 验证请求被用户取消，真实打包 EXE 运行测试未完成。

后续应在用户确认后验收实际安装/升级与真实数据库连接、会话读取、消息读取和桥接；本轮不因初始化通过就把这些功能标记为已通过。长期维护优先采用可从源码构建、明确支持自有宿主名称的原生接口版本，避免依赖某一二进制哈希。
