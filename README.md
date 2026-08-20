# AstrWeChat

AstrWeChat 是一个面向 AstrBot 的微信连接器，用于将微信消息接入 AstrBot，并将 AstrBot 生成的回复发送回微信。

本项目基于 WeFlow 的微信本地数据库读取能力，并结合 Akasha-WeChat 的 OneBot v11 对接思路，为 AstrBot 提供微信消息接入能力。项目重点是消息接收、事件转发和消息回传，不以保留原 WeFlow 的完整分析与导出功能为目标。

## 功能概览

- 读取本机微信数据库中的聊天数据
- 自动获取或手动配置微信数据库密钥
- 通过本地 HTTP API 提供消息服务
- 通过 SSE 接收新消息推送
- 将微信消息转换为 OneBot v11 事件
- 支持向 OneBot v11 服务端发送消息
- 支持通过 Windows UI Automation 将消息发送回微信
- 提供桌面端配置界面
- 管理 AstrWeChat 的启动、停止、暂停、恢复和运行日志

## 消息流程

```text
微信
  |
  v
WeFlow 数据读取与消息推送
  |
  v
AstrWeChat
  |
  v
OneBot v11 / 反向 WebSocket
  |
  v
AstrBot 或其他机器人框架
```

机器人产生的回复可以通过 Bridge 返回微信，具体发送方式取决于 OneBot 配置和 Windows UI Automation 环境。

## 环境要求

- Windows 10 或更高版本
- Node.js 20 或更高版本
- Python 3.10 或更高版本
- 已安装并正常运行的微信客户端
- 能够访问微信本地数据目录
- 如需回传消息，需要启用 Windows UI Automation 所需的权限和环境

## 快速开始

### 一键启动

在项目根目录运行：

```bat
start-weflow-slim.bat
```

启动脚本会检查 Node.js、npm 和 Python 环境，并安装项目及 AstrWeChat 所需的依赖。

### 手动启动

```powershell
npm install
python -m pip install -r bridge/requirements.txt
npm run electron:dev
```

应用启动后，在界面中依次配置微信数据库、HTTP API 和 Bridge 参数。

## AstrWeChat 配置

AstrWeChat 配置文件位于 `bridge/config.json`，主要配置包括：

| 配置项 | 说明 |
| --- | --- |
| `weflow_base_url` | WeFlow 本地 HTTP 服务地址 |
| `weflow_sse_path` | 新消息 SSE 推送地址 |
| `onebot_ws_url` | OneBot v11 反向 WebSocket 地址 |
| `onebot_access_token` | OneBot 服务端访问令牌，可为空 |
| `uia_enabled` | 是否启用 UI Automation 回传 |
| `uia_wechat_path` | 微信程序路径或窗口识别配置 |
| `message_prefix` | 发送给微信的消息前缀 |

实际可用配置以当前 `bridge/config.json` 和应用界面为准。

## HTTP API

默认本地服务地址为：

```text
http://127.0.0.1:5031
```

接口详情见 [docs/HTTP-API.md](docs/HTTP-API.md)。AstrWeChat 使用 WeFlow 的消息推送接口接收新消息，再转换为 OneBot v11 事件。

## 项目结构

```text
bridge/       AstrWeChat 的 Python 核心和 OneBot v11 对接代码
electron/     Electron 主进程、数据库和 HTTP 服务
src/slim/     Bridge 专用桌面界面
resources/    原生运行库、密钥工具和数据库组件
docs/         HTTP API 及相关说明
```

## 构建与检查

```powershell
npm run typecheck
npm run build
```

## 特别致谢

本项目不是从零开始编写，而是基于以下两个开源仓库的代码和设计思路进行整合、裁剪与修改：

- 特别感谢 [hicccc77/WeFlow: WeFlow - 一个本地的微信聊天记录导出和年度报告应用](https://github.com/hicccc77/WeFlow)。感谢您做出的贡献。
- 特别感谢 [alingalingling/Akasha-WeChat: 稳定高效的让ai接入微信个人号——支持最新版本微信/onebotv11协议/反向websocket/可识别图片/可发送表情包/灵活对接LLM模型与项目](https://github.com/alingalingling/Akasha-WeChat)。本项目使用了其中与微信机器人接入、OneBot v11、反向 WebSocket 和消息发送相关的代码与思路。（作者人太好了）

同时感谢项目中使用到的其他开源组件及技术资料。相关许可证和第三方归属信息请以项目中的许可证文件及各依赖项目声明为准。
