# 1.3.0 安装包精简与检查

## 使用方式

继续双击本目录的 `build-installer.bat` 即可。入口不变，构建会依次执行打包规则测试、编译、产物检查和安装包生成。生成前若已有同名安装包，完成时会显示新旧体积及减少比例。

命令行：

```powershell
npm run build-installer -- -NoPause
npm run test:packaging
npm run verify:package
```

最后一个命令默认检查 `release/win-unpacked`。也可传入其他 Windows 程序目录和架构：

```powershell
node scripts/verify-package.cjs "D:\build\win-unpacked" x64
```

## 精简规则

- React、ECharts、Lucide、路由和表情等前端依赖放入 `devDependencies`。Vite 编译后的页面照常随 `dist` 打包，不再把这些库的完整源码、其他发行格式及源码映射重复带入安装包。构建时必须安装开发依赖，不能使用 `npm ci --omit=dev`。
- 移除当前精简版没有调用的 Excel 导出、HTML 截图、分词、Markdown、虚拟列表、语音识别和 Zustand 等遗留依赖，并同步锁文件。
- Windows 只保留简体中文、繁体中文、美式英文的 Electron 语言资源。安装器原有中英文设置不变；macOS/Linux 的语言设置不变。
- 排除所有源码映射文件和未使用的年度报告字体。源资源仍留在仓库中，没有删除。
- 排除 bridge 本机配置、日志、Python 缓存和运行数据，避免夹带凭据或运行时文件。
- 保留 FFmpeg、Silk、Koffi、WCDB、WeLive、图片解码 WASM 和 VC++ 运行库。不手工删除 Electron 的 DLL、许可文件或 WeLive 内部的 WCDB 副本，也不采用按需联网下载替代现有离线能力。
- 继续使用默认压缩等级，主要通过减少实际打包内容来缩小体积。

## 防止回退

`after-pack.cjs` 在 Windows 打包后、生成安装器前调用 `verify-package.cjs`。缺少关键运行资源，或发现前端依赖重复打包、源码映射、多余语言、年度报告字体、本机 bridge 配置时，构建直接失败，不会继续生成安装器。

`verify-package.test.cjs` 使用临时模拟安装目录测试成功路径和上述失败路径，并检查依赖分类与锁文件一致性。这是文件结构检查，不代替真实微信连接、收发消息、图片和语音处理的端到端测试。

以后恢复 Excel、语音识别或年度报告功能时，应同时恢复对应依赖/资源并更新检查规则。不要只绕过打包检查。
