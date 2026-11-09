# Familiar

一只住在 macOS 桌面上的宠物，内部是一个 agent：陪你聊天、记住你、看你在电脑上做什么，在合适的时候主动开口，经你同意替你操作别的应用。

这是个人学习项目，目前只有作者自己在用，只支持 macOS，没有发布安装包。

技术上是 Tauri 壳（Rust）加一个用 Bun 运行的 TypeScript agent 进程。产品设计见 [docs/design.md](docs/design.md)，进程划分与消息流见 [docs/architecture.md](docs/architecture.md)。

## 开发

需要 Node 26、pnpm、Bun、Rust 工具链和 Xcode；本机向量的 `llama-server` 用 uv 临时调 cmake 编译（`pnpm llama:build`，第一次约 10 分钟，之后跳过）：

```sh
pnpm install
pnpm agent:build   # 首次 tauri dev 前生成 sidecar，见 src-tauri/README.md
pnpm llama:build   # 本机向量用的 llama-server
pnpm dev
pnpm typecheck
pnpm lint
pnpm test
pnpm eval          # 记忆评测，会用配置好的后台模型发真实请求
pnpm build
```

`pnpm build` 用钥匙串里的 Apple Development 证书签名。没有证书时用 `APPLE_SIGNING_IDENTITY=- pnpm build` 做临时签名，但每次重新构建后，辅助功能权限都要在系统设置里重新勾选。

首次启动只显示宠物和菜单栏图标。单击宠物打开聊天，拖动超过 4px 移动宠物。

## 目录

- `src-tauri/`：窗口、托盘、点击穿透、全局快捷键，启动并守护 agent。只做系统集成，不放业务逻辑。
- `agent/`：设置、会话、agent 循环、权限、工具与沙箱、git 快照、对话记录、记忆、MCP 与 skills。业务状态的唯一来源。
- `src/renderer/`：宠物、胶囊、气泡、聊天面板、大窗口、设置页。
- `src/shared/`：三者共用的协议类型和 IPC 通道名。

数据都在 `~/.familiar/`：顶层是配置（模型碰不到），`workspace/` 可读写，`memory/` `conversations/` `knowledge/` `skills/` 对模型只读。旧的 `~/Library/Application Support/Familiar/` 和 `~/Familiar` 会在首次启动时自动迁入。API Key 存钥匙串。

可用 `FAMILIAR_DATA_DIR="$PWD/.smoke-user-data" pnpm dev` 把冒烟测试数据放进仓库，测完删掉该目录。用 UI 自动化工具操控开发版时，加 `FAMILIAR_SHOW_DOCK=1` 显示 Dock 图标（默认隐藏，自动化工具找不到它）。

全屏 Spaces 之上可见、透明区域点击穿透、跨屏拖动以及钥匙串读写，需要在 macOS 真机验收；源码里的窗口配置不能替代这些实测。

## 许可证

[MIT](LICENSE)
