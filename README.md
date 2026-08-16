# Interview Lab

Windows 实时语音面试辅助测试工具。它捕获默认系统输出音频，将 `PCM16 / mono / 16kHz` 小帧发送到可配置的 WebSocket ASR；用户按全局快捷键结束当前问题片段，并调用可配置的文本 LLM 流式生成中文第一人称回答。

## 已实现

- WASAPI 默认播放设备回环采集；原始音频仅在内存中传输，不写入磁盘。
- 通用 WebSocket ASR 设置：初始化 JSON、二进制或 Base64 音频帧、结束消息、增量/最终/错误事件与 JSONPath 映射。
- 参考 Agent 的文本 LLM Profile：`Base URL`、`API Key`、模型、`Responses API` 或 `Chat Completions`、自定义路径和 Header。
- PDF、DOCX、TXT、Markdown 简历/JD 导入；确认后的事实摘要和岗位摘要才会用于回答。
- 主控制台、可拖动置顶悬浮窗、可配置全局快捷键和本地文本会话记录。

## 前提

- Windows 10/11。
- Node.js 22+。
- Rust/Cargo。本项目开发机已使用 `E:\dev-tools\rust`；新的 PowerShell 会话需要设置：

```powershell
$env:RUSTUP_HOME = 'E:\dev-tools\rust\rustup'
$env:CARGO_HOME = 'E:\dev-tools\rust\cargo'
$env:PATH = 'E:\dev-tools\rust\cargo\bin;' + $env:PATH
```

## 启动

```powershell
npm install
npm run tauri dev
```

首次使用时：

1. 在“服务配置”填写 ASR WebSocket 协议字段和文本模型 Profile。
2. 在“候选人材料”导入或粘贴一份简历、一份 JD，生成并确认摘要。
3. 在“会话控制”点击“开始会话”。
4. 播放受控测试音频；ASR 增量文本将显示在控制台。
5. 按 `Ctrl+Shift+Space`（可配置）结束当前问题并生成回答。

## ASR 配置说明

前端 WebSocket 实现支持两种音频封装：直接发送二进制 PCM，或在 JSON 模板中用 `{{base64}}` 替换 Base64 音频；`WebSocket URL`、初始化、音频和结束模板均可使用 `{{apiKey}}`。事件解析使用点分路径，例如事件类型路径为 `header.name`、文本路径为 `payload.result.text`。

当前 ASR 的认证 Header、复杂签名与非标准二进制协议需要依据服务商文档配置或进一步补充原生适配器；浏览器 WebSocket 不能自定义握手 Header。

## 验证

```powershell
npm run build
npm run tauri build -- --no-bundle
```

`--no-bundle` 只生成 EXE；生成 MSI 还需要 WiX 工具链下载完成。
