# AstrWeChat

<p align="center">
  <img src="1.1.0/icon.png" alt="AstrWeChat" width="128" height="128">
</p>

<p align="center">
  给 AstrBot 的本地微信消息连接器
</p>

<p align="center">
  <a href="https://github.com/CMKH1337/Astrwechat/releases/latest"><img src="https://img.shields.io/github/v/release/CMKH1337/Astrwechat?label=Release" alt="Release"></a>
  <a href="https://github.com/CMKH1337/Astrwechat/releases"><img src="https://img.shields.io/github/downloads/CMKH1337/Astrwechat/total?label=Downloads" alt="Downloads"></a>
  <img src="https://img.shields.io/badge/Windows-10%2B-0078D6?logo=windows" alt="Windows 10+">
  <img src="https://img.shields.io/badge/OneBot-v11-7C3AED" alt="OneBot v11">
</p>

AstrWeChat 用于读取本机微信数据、提供本地 HTTP API 和新消息推送，并通过 OneBot v11 Bridge 将微信消息接入 AstrBot。AstrBot 生成回复后，Bridge 可以借助 Windows UI Automation 将消息发送回微信。

所有微信数据均在本机处理。请妥善保管数据库密钥、Access Token 和 Bridge 配置，不要将包含个人配置的文件公开上传。

> [!IMPORTANT]
> AstrWeChat 不是微信官方产品，也不是 AstrBot 官方组件。一切请在保证数据安全的情况下运行。

## 特别鸣谢

感谢以下仓库提供的技术支持：

- [hicccc77/WeFlow](https://github.com/hicccc77/WeFlow)：微信本地数据读取、WCDB 及相关桌面能力。
- [alingalingling/Akasha-WeChat](https://github.com/alingalingling/Akasha-WeChat)：微信机器人接入、OneBot v11、反向 WebSocket 和消息发送相关思路与实现。

## 版本

| 版本 | 文件 | 使用方式 |
| --- | --- | --- |
| Windows 安装版 | `AstrWeChat-1.0.0--windows-amd64-Setup.exe` | 运行安装程序，根据提示完成安装 |
| Windows 免安装版 | `AstrWeChat-1.0.0-Portable.zip` | 解压到独立目录，运行 `WeFlow.exe` |

> [!NOTE]
> 免安装版中的主程序文件名为 `WeFlow.exe`。这是 WCDB 原生组件的兼容要求，不代表软件品牌发生变化；程序界面和产品名称仍为 AstrWeChat。

## 主要功能

- 自动检测微信数据目录和微信 ID
- 自动获取或手动填写微信数据库解密密钥
- 获取图片密钥，支持内存扫描 AES
- 读取本机微信会话、消息、联系人和群成员数据
- 提供本地 HTTP API，默认监听 `127.0.0.1:5031`
- 通过 SSE 主动推送新消息
- 将微信消息转换为 OneBot v11 事件
- 通过反向 WebSocket 连接 AstrBot
- 通过 Windows UI Automation 发送文本、图片等回复到微信
- Bridge 状态、运行日志和配置管理
- 开机启动、静默启动、通知和日志设置
- 一键重置数据库、HTTP API、Bridge 和本地应用配置

## 工作流程

### 常规消息
```text
微信客户端收到消息
    │
    ▼
微信本地数据库
    │
    ▼
AstrWeChat HTTP API + SSE
    │
    ▼
OneBot v11 Bridge
    │
    ▼
AstrBot
    │
    └── 回复 ──► Windows UI Automation ──► 微信客户端
```

### 图片消息
```text
微信客户端收到图片
    │
    ▼
微信写入本地消息数据库与图片缓存
    │
    ▼
AstrWeChat / WCDB 检测到新消息
    │
    ▼
MessagePushService 识别图片消息
content = [图片]
    │
    ▼
AstrWeChat HTTP API + SSE 推送 message.new
    │
    ▼
OneBot v11 Bridge 接收图片事件
    │
    ├── 群聊 mention 模式且未 @ 机器人
    │       │
    │       ▼
    │   暂存图片，等待后续关联的 @ 指令
    │
    ▼
按 serverId / localId / 时间定位原始媒体消息
    │
    ▼
请求媒体接口并获取 mediaUrl
    │
    ▼
AstrWeChat 解密 / 导出图片缓存
    │
    ▼
Bridge 下载图片到本地
    │
    ▼
编码为 OneBot image 段
base64://...
    │
    ▼
图片占位文本 + 图片段加入消息缓冲
    │
    ▼
OneBot v11 Bridge 推送给 AstrBot
    │
    ▼
AstrBot 接收图片并生成回复
    │
    └── 回复 ──► Windows UI Automation ──► 微信客户端
```

## 使用要求

### 使用桌面程序

- Windows 10 或更高版本
- 已安装并登录微信客户端
- Python 3.10 或更高版本

安装版和免安装版都已经包含 Electron、WCDB 和桌面程序所需的原生运行文件，不需要额外安装 Node.js。

### 运行源码

- Windows 10 或更高版本
- Node.js 20 或更高版本
- npm
- Python 3.10 或更高版本（Bridge 所需）

## 快速开始

### 1. 连接微信数据库

打开左侧的 **连接** 页面：

1. 点击“自动检测”，查找微信数据目录和微信 ID。
2. 确认微信客户端处于未登录状态，点击“自动获取”等待提示后登录微信客户端获取密钥。
3. 图片消息功能需解密图片，可使用“自动获取图片密钥”或“内存扫描 AES”。
4. 检查数据目录、密钥和微信 ID，然后点击“连接数据库”。

如果自动检测失败，也可以手动填写微信账户目录和密钥。

### 2. 启动 HTTP API

打开 **API 服务** 页面：

1. 启用 API。
2. 根据需要启用主动推送。
3. 设置监听 Host、端口和 Access Token。
4. 点击保存并启动。

默认地址：

```text
http://127.0.0.1:5031
```

### 3. 配置 Bridge

Bridge 负责将 AstrWeChat 的消息转成 OneBot v11 事件，并通过反向 WebSocket 连接 AstrBot。

默认配置：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| AstrWeChat 地址 | `http://127.0.0.1:5031` | 本地 HTTP API 地址 |
| Access Token | 空 | 应与 API 服务页面设置一致 |
| AstrBot WS | `ws://127.0.0.1:11229/ws` | AstrBot OneBot v11 反向 WebSocket 地址 |
| Bot 微信 ID | 空 | 机器人使用的微信账号 ID |
| 机器人昵称 | 空 | 群聊中用于识别机器人的昵称，每行一个 |
| 群聊模式 | `mention` | 默认仅响应提及机器人的消息 |
| 消息缓冲 | `0` 秒 | 合并连续消息时使用 |
| 附件目录 | 空 | AstrBot 附件保存目录，可按需填写 |

安装或检查 Bridge 依赖：

```powershell
python -m pip install -r bridge/requirements.txt
```

配置完成后，在 Bridge 页面点击启动，并确认：

- [INFO] ✅ 已连接到 WeFlow 推送
- [INFO] ✅ 已连接到 Astrbot

## 从源码运行

克隆仓库：

```powershell
git clone https://github.com/CMKH1337/Astrwechat.git
cd Astrwechat
```

安装 Node.js 依赖：

```powershell
npm install
```

安装 Bridge 依赖：

```powershell
python -m pip install -r bridge/requirements.txt
```

启动开发环境：

```powershell
npm run electron:dev
```

也可以在 Windows 中运行：

```text
start.bat
```

该脚本会检查 Node.js、npm 和 Python，并安装缺失依赖后启动程序。

## 构建

类型检查：

```powershell
npm run typecheck
```

构建桌面程序和安装包：

```powershell
npm run build
```

检查 WCDB 原生运行环境：

```powershell
npm run wcdb:probe
```

构建产物默认位于：

```text
release/
```

## 项目结构

```text
bridge/          Python Bridge、OneBot v11 对接和微信消息发送
electron/        Electron 主进程、WCDB、HTTP API 和原生服务
src/slim/        AstrWeChat 桌面配置界面
shared/          前后端共享配置
resources/       WCDB、密钥工具、图片解密和运行库
public/          图标与前端静态资源
docs/            HTTP API 和使用文档
scripts/         构建、启动和诊断脚本
```

## 常见问题

### 安装版提示 WCDB 初始化失败

请确认使用的是最新 Release。安装版内部必须通过 `WeFlow.exe` 启动，以满足 WCDB 原生组件的兼容要求。不要将该文件手动改名为 `AstrWeChat.exe`。

可以在源码目录运行以下命令诊断：

```powershell
npm run wcdb:probe
```

正常结果应显示主进程、普通 Worker 和正式构建 Worker 均可初始化 WCDB。

### PowerShell 无法运行 npm

如果系统禁止运行 `npm.ps1`，请使用：

```powershell
npm.cmd install
npm.cmd run build
```

或者在 CMD 中运行相同的 npm 命令。

### Bridge 无法启动

检查：

1. 是否安装了 Python 3.10+。
2. 是否安装了 `bridge/requirements.txt` 中的依赖。
3. AstrWeChat HTTP API 是否已经启动。
4. Access Token 是否一致。
5. AstrBot 的 OneBot v11 WebSocket 地址是否正确。

### 免安装版应该运行哪个文件

解压后运行：

```text
WeFlow.exe
```

请保留解压后的完整目录结构，不要只复制 EXE 文件。

## 数据与安全

- 数据库密钥、Access Token 和微信 ID 属于敏感信息，请勿公开分享。
- `bridge/config.json` 是本地运行配置，不应提交到公共仓库。
- 默认服务只监听 `127.0.0.1`。如需监听局域网地址，请设置强 Access Token 并自行配置防火墙。
- 一键重置会停止相关服务并清除本地配置，请在操作前确认不再需要这些信息。

感谢以上项目作者及所有相关开源组件的贡献者。
