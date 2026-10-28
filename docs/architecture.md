# Familiar 架构（Tauri + TS 进程）

> 2026-10-26 由 Electron 迁移而来，旧实现保留在 git 标签 `electron-prototype`。协议类型见 `src/shared/protocol.ts`。

## 三个部分

| 部分 | 位置            | 语言                   | 负责                                                                                                                                                                                                                                                                                                               |
| ---- | --------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 壳   | `src-tauri/`    | Rust                   | 四个窗口（宠物覆盖层 `pet`、聊天面板 `chat`、设置 `settings`、大窗口 `main`，打开 `main` 时切成 Dock 可见的普通应用）、NSPanel（置顶、全屏可见、全 Spaces）、点击穿透、拖动与位置持久化、托盘菜单与 ⌘, 菜单、全局快捷键（按下后转给 agent）、`familiar-pet://` 资源协议、外部链接、启动并守护 agent 进程、消息转发 |
| 大脑 | `agent/`        | TypeScript（Bun 运行） | 设置（`settings.json` + 钥匙串）、会话、agent 循环（AI SDK 7）、三种协议与中转参数、重试、权限判定、工具与沙箱、git 快照、对话记录（`~/Familiar/conversations/*.md`）、记忆（`~/Familiar/memory/`，`agent/src/memory/`）、宠物库（列出 / 从 ChatGPT 导入）、宠物状态机与气泡计时、决定什么时候展开面板             |
| 界面 | `src/renderer/` | React + Vite           | 宠物精灵动画、胶囊、气泡、聊天面板（Markdown / 公式 / 代码）、设置页；通过 `src/renderer/api.ts` 实现 `FamiliarAPI`                                                                                                                                                                                                |

原则：**Rust 只做窗口和系统集成，不放业务逻辑**；业务状态的唯一来源是 agent 进程。

## 消息流

```
webview ──invoke familiar_invoke(channel,args)──▶ Rust ──{kind:request}──▶ agent
webview ◀──Tauri event <channel>────────────────── Rust ◀──{kind:emit}───── agent
                                                   Rust ◀──{kind:ui}─────── agent   (显示/隐藏面板、改宠物窗口尺寸、重建托盘)
                                                   Rust ──{kind:signal}───▶ agent   (面板可见/聚焦、应用激活、拖动进度)
webview ──invoke pet_hit / pet_drag_start──▶ Rust  (窗口本地操作，不经过 agent)
```

- Rust ↔ agent：stdin/stdout 上逐行 JSON；agent 的日志只写 stderr。
- 渠道名沿用 `src/shared/index.ts` 的 `IPC` 常量（如 `settings:get`、`agent:run`、`session:changed`）。

## 原 Electron 主进程功能的新归属

| 功能                           | 归属        | 做法                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 宠物窗口透明 / 置顶 / 全屏可见 | Rust        | tauri-nspanel：`ScreenSaver` 层级、`can_join_all_spaces + full_screen_auxiliary + stationary`、`nonactivating_panel`                                                                                                                                                                                                              |
| 点击穿透                       | Rust + 界面 | Rust 每 16ms 用 AppKit 坐标（`NSEvent.mouseLocation` 与 panel `frame`，不要用 Tauri 的 `cursor_position`，多显示器下坐标不一致）判断鼠标是否在覆盖层窗口内；在窗口内时向 `pet` 窗口发 `pet:cursor {x,y,ignoring}`（坐标变化或每 200ms 补发一次），界面按像素 alpha 与 DOM 判断，只要与 `ignoring` 不一致就 `pet_hit(inside)` 纠正 |
| 拖动                           | 界面 + Rust | 界面在按下后移动超过 4px 时调用 `pet_drag_start`；Rust 记下鼠标相对窗口的偏移，在轮询里按鼠标位置移动面板（`startDragging` 需要原始按下事件，不可用），向 agent 发 `pet-drag` 信号，松开后持久化位置                                                                                                                              |
| 面板位置                       | Rust        | 收到 `show-chat` 时把面板放在宠物左侧并钳制在屏幕内；聊天窗口转成可成为 key 的 NSPanel 并 `show_and_make_key`（无边框 NSWindow 拿不到键盘焦点，会吞掉第一下点击）                                                                                                                                                                 |
| API Key 加密                   | agent       | macOS 钥匙串（`security -i` 从 stdin 读命令，密钥不出现在进程参数里）                                                                                                                                                                                                                                                             |
| 系统代理                       | agent       | 读取 `scutil --proxy`，在 Bun `fetch` 的 `proxy` 选项里使用                                                                                                                                                                                                                                                                       |
| 强调色                         | agent       | `defaults read -g AppleAccentColor` 映射为颜色；收到 `app-activated` 时刷新                                                                                                                                                                                                                                                       |
| 空闲检测（睡觉）               | agent       | 定时读取 `ioreg -c IOHIDSystem` 的 `HIDIdleTime`                                                                                                                                                                                                                                                                                  |
| 移到废纸篓                     | agent       | `osascript` 调 Finder 删除（可恢复）                                                                                                                                                                                                                                                                                              |
| 外部链接                       | 界面        | `@tauri-apps/plugin-opener`，只放行 http/https/mailto                                                                                                                                                                                                                                                                             |

## 运行与打包

- 开发：`pnpm dev` → `tauri dev`（Vite 开发服务器 + Rust 壳；壳用 `bun agent/src/main.ts` 启动 agent）。
- 打包：`bun build --compile` 把 agent 编成 `src-tauri/binaries/familiar-agent-<target>`，作为 `externalBin` 放进 `.app`。
- 配置目录 `~/.familiar/`（2026-10-28 前是 `~/Library/Application Support/Familiar/`，壳首次启动时把 Familiar 自己的文件搬过来，Electron 时期留下的缓存不动）；API Key 存钥匙串。模型的工具和沙箱都不能读写这个目录，只有其中的 `skills/` 可读。
