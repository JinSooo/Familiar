# Familiar

macOS 桌面宠物，Electron 主进程承载 TypeScript agent。产品设计见 [docs/design.md](docs/design.md)。

## 开发

使用 Node 26 与 pnpm 12.6：

```sh
pnpm install
pnpm dev
pnpm typecheck
pnpm lint
pnpm build
pnpm format
```

`build` 生成 `out/`，当前不包含分发、签名或打包流程。Electron 固定为 45.0.0。`pnpm-workspace.yaml` 允许 Electron 与 esbuild 的安装脚本。

首次启动只显示宠物和菜单栏图标。单击宠物打开聊天，拖动超过 4px 移动宠物。聊天窗口关闭时隐藏，菜单栏可以再次打开或进入设置。

## 模块边界

- `src/shared/index.ts`：设置 schema、消息和事件、IPC 通道、preload API 的唯一契约。
- `src/main/index.ts`：窗口、托盘、IPC、会话取消和宠物状态。渲染进程不开放 Node 或任意 IPC。
- `src/main/settings.ts`：主进程内部 `getSettings()` 返回完整设置；渲染层只收到 `PublicSettings`。API key 留空保留原值，存盘仅保存 safeStorage 密文。加密不可用时拒绝保存 key。设置写入串行化并原子替换。
- `src/main/agent/`：provider 抽象（OpenAI 兼容 / OpenAI Responses / Anthropic，自定义 baseURL）、AI SDK 7 `ToolLoopAgent` 循环（`core.ts`，可注入模型便于测试）、审批等待（`approvals.ts`）、人设与中文错误转换。
- `src/main/permissions/`：`decideToolCall(call, settings)` 按三档模式、目录规则与硬性禁区返回 allow / ask / deny。
- `src/main/workspace/`：`ensureWorkspace`（建目录与 git 仓库）、`snapshot`（每轮有副作用后提交）、文件与 shell 工具；`run_shell` 在询问 / 自动模式下用 seatbelt 沙箱，只能写工作目录、默认断网。
- `src/preload/index.ts`：白名单桥接与可取消的事件订阅。
- `src/renderer/`：SVG 宠物、聊天与设置视图。替换宠物外形时保持 `data-pet` 命中区域及四个状态 class。

默认配置位于 `~/.familiar/`（旧版的 `~/Library/Application Support/Familiar/` 会在首次启动时自动迁移）。设置和位置分别写入 `settings.json`、`window-state.json`。工作目录默认展开为 `~/Familiar` 的绝对路径。

可用 `FAMILIAR_USER_DATA="$PWD/.smoke-user-data" pnpm dev` 将冒烟启动数据放在仓库内，测试结束后删除该目录。正常使用无需设置此变量。需要用 UI 自动化工具操控开发版时，加 `FAMILIAR_SHOW_DOCK=1` 让应用显示 Dock 图标（默认隐藏，自动化工具找不到它）。

全屏 Spaces 之上可见、透明区域点击穿透、跨屏拖动以及钥匙串读写，需要在 macOS 真机验收；源码中的窗口配置不能替代这些实测。
