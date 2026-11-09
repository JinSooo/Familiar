# Familiar（灵宠）

住在 macOS 桌面上的宠物，也是一个会自己做事的 agent：陪你聊天、记住你、知道你在忙什么，在合适的时候主动开口，经你同意替你操作别的应用。

> 个人学习项目，只支持 macOS，没有发布安装包，需要从源码构建。

## 它能做什么

- **随手聊**：点一下宠物弹出输入胶囊，聊长了展开成聊天面板或大窗口。回复里的代码、公式、Mermaid 图和图表直接渲染。
- **记住你**：从对话里提炼你的身份、习惯和在做的事，存成 Markdown 文件，你可以直接看和改。推断出来的先进「待确认」，你点头才算数。
- **知道你在忙什么**：打开「电脑活动」后，在本机记录前台应用、窗口标题和网址，整理成每天的时间线。不截图、不录音；密码框和隐私窗口不读，敏感内容采集时就丢掉；原始记录加密保存 48 小时。默认关闭。
- **主动开口**：卡在一个问题上太久、连续工作没休息、提醒到期时，宠物头上冒个气泡。有免打扰时段和打扰次数上限，会看你最近的反应调整。
- **帮你办事**：读写工作目录里的文件，在沙箱里跑命令，上网查资料，设提醒和待办。支持 MCP 服务器和技能（SKILL.md，与 Claude Code、Codex 同格式）。
- **替你操作应用**：通过辅助功能在后台操作单个应用，不切前台、不动你的鼠标键盘。确实要接管鼠标时先问你，按 Esc 随时停。
- **知识库**：收录你指定的文件夹、PDF（连图片里的字）和存下来的网页，回答时附上原文出处。
- **换宠物**：内置四只，兼容 ChatGPT 宠物格式、可以一键导入，也可以让 Codex 或 Claude Code 照着说明画一只新的。

## 隐私

- 所有数据都在 `~/.familiar/`，大多是能直接打开的 Markdown 文件；API Key 存在钥匙串里。
- 没有自己的服务器，也没有统计上报。对话和整理后的电脑活动只发给你配置的模型；某个应用可以设成「只留本机」。
- 三档权限：询问（每次写入和执行都问）、自动（默认，命令在沙箱里跑）、完全访问。

## 模型

OpenAI、Anthropic、DeepSeek、Kimi、Gemini 选好只填 Key；其他服务和中转站填 OpenAI 或 Anthropic 兼容的接口地址；也可以直接用 ChatGPT 账号登录。知识库和记忆的语义检索可以用本机模型（Qwen3-Embedding-0.6B，在设置里下载），不配置时只用全文检索。

## 从源码构建

需要 macOS、Node 26、pnpm、Bun、Rust 工具链、Xcode 和 uv。

```sh
pnpm install
pnpm agent:build   # 生成 agent sidecar，见 src-tauri/README.md
pnpm llama:build   # 本机向量用的 llama-server，第一次约 10 分钟
pnpm build         # 产物在 src-tauri/target/release/bundle/macos/Familiar.app
```

`pnpm build` 用钥匙串里的 Apple Development 证书签名。没有证书时用 `APPLE_SIGNING_IDENTITY=- pnpm build` 做临时签名，但每次重新构建后，辅助功能权限都要在系统设置里重新勾选。

第一次打开只有宠物和菜单栏图标：先给宠物起个名字，再按提示去设置里连上模型。单击宠物打开聊天，拖动移动它，右键看更多操作。

## 开发

```sh
pnpm dev
pnpm typecheck
pnpm lint
pnpm test
pnpm eval          # 记忆和主动发言评测，会用配置好的后台模型发真实请求
pnpm release notes.md  # 发版到 GitHub Releases，需要更新密钥，见 docs/design.md §10
```

- `src-tauri/`：窗口、托盘、点击穿透、全局快捷键，启动并守护 agent。只做系统集成，不放业务逻辑。
- `agent/`：设置、会话、agent 循环、权限、工具与沙箱、git 快照、对话记录、记忆、感知、主动发言、知识库、MCP 与技能。业务状态的唯一来源。
- `sensor/`：Swift 写的采集和操作程序（电脑活动、PDF 识字、Computer Use）。
- `src/renderer/`：宠物、胶囊、气泡、聊天面板、大窗口、设置页。
- `src/shared/`：共用的协议类型和 IPC 通道名。

`~/.familiar/` 顶层是配置（模型碰不到），`workspace/` 可读写，`memory/` `conversations/` `knowledge/` `skills/` 对模型只读。

用 `FAMILIAR_DATA_DIR="$PWD/.smoke-user-data" pnpm dev` 可以把测试数据和自己的数据分开，测完删掉该目录。用 UI 自动化工具操控开发版时，加 `FAMILIAR_SHOW_DOCK=1` 显示 Dock 图标。

全屏 Spaces 之上可见、透明区域点击穿透、跨屏拖动和钥匙串读写，要在 macOS 真机上验收，源码里的配置不能替代实测。

设计和取舍见 [docs/design.md](docs/design.md)，进程划分和消息流见 [docs/architecture.md](docs/architecture.md)。

## 许可证

[MIT](LICENSE)
