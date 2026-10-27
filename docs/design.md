# Familiar（灵宠）设计文档

> 仓库代号：`all-in-pet`　产品名：Familiar（中文名：灵宠）
> 状态：设计已确认，尚未开始实现　日期：2026-10-25

## 1. 定位

Familiar 是一只住在 macOS 桌面上的宠物，同时也是一个自主运行的 bot。宠物是它的外表；内部有一个 agent，它会记住你、观察你在电脑上做什么、在合适的时候主动找你，并且能在授权范围内替你办事。

- **学习优先**：产品是学习的载体。第一阶段只有作者本人使用，不考虑分发、签名上架、多用户和商业化。
- **只做 macOS**：不考虑跨平台。
- **"all-in" 学习大纲**：
  1. Agent harness：agent loop、工具调用、上下文管理
  2. 记忆：写入、检索、遗忘
  3. 知识库 / RAG
  4. 感知：Computer History
  5. 主动性：调度、触发、打扰预算
  6. 具身表现：宠物窗口、动画、状态
  7. 评测
  8. 本地模型 / 微调（放到最后）
- **借用现成方案**：能用现成库的地方就用现成库，原理通过其他途径学。只有产品的核心（记忆、调度、感知整理）需要自己写，因为没有现成方案同时满足下面所有要求。

## 2. 命名

| 项 | 取值 |
|---|---|
| 仓库 / 学习项目代号 | `all-in-pet` |
| 产品名 | Familiar（英文 familiar 兼有"巫师的伴生灵兽"和"熟悉"两层意思） |
| 中文名 | 灵宠 |
| 宠物名 | 属于人格、不属于皮肤；首次启动时由用户起名，可以随时修改。P0 先用 Familiar 占位 |
| 工作目录 | `~/Familiar/` |
| 应用数据目录 | `~/Library/Application Support/Familiar/` |

## 3. 架构

> 2026-10-26 从 Electron 迁移到 Tauri + TS 进程，详细分工与协议见 `docs/architecture.md`；Electron 版保留在 git 标签 `electron-prototype`。

```
┌──────────── Tauri 壳（Rust，src-tauri/）────────────┐
│ 宠物覆盖层 NSPanel · 聊天面板 NSPanel · 设置窗口       │
│ 点击穿透（AppKit 坐标轮询）· 拖动 · 托盘 / 菜单         │
│ familiar-pet:// 资源协议 · 启动并守护 agent 进程       │
└──────▲ Tauri invoke / event ──────▲ stdio NDJSON ─────┘
       │                             │
 界面（React，src/renderer/）   大脑（TS，Bun，agent/）
 宠物动画 · 胶囊 · 气泡          Agent loop：Vercel AI SDK 7
 聊天面板 · 设置页               Provider 抽象 · 重试 · 权限 · 工具 · 沙箱
                                会话 · 宠物状态机 · 设置（钥匙串）
                                记忆 / 调度 / 知识库 / Computer History（P1 起）
```

- **壳**：Tauri v2（Rust）。只负责窗口和系统集成，不放业务逻辑。宠物窗口用 tauri-nspanel 转成 NSPanel（ScreenSaver 层级、全屏与所有 Spaces 可见）；点击穿透靠 Rust 用 AppKit 坐标轮询鼠标、界面按像素判断后切换。
- **大脑**：独立的 TS 进程，开发时 `bun agent/src/main.ts`，打包时 `bun build --compile` 成单文件放进 `.app`。业务状态的唯一来源。
- **agent loop**：Vercel AI SDK 7，作为库在大脑进程内运行。
- **自己写的部分**：记忆、调度、Computer History 整理、provider 抽象。将来遇到中转站兼容问题，可以在 provider 抽象层里换成 pi-ai。
- **工程**：pnpm + Vite + Tauri CLI，TypeScript strict；Rust 依赖 tauri 2.12、tauri-nspanel 2.1、plugin-opener、plugin-shell。
- **为什么换掉 Electron**：只做 Mac，Electron 的跨平台和单一语言优势用不上，却带来约 300MB 包体和一系列窗口绕路。Tauri 实验验证了三个最大风险（打包后透明不变白、全屏可见、点击穿透）都可行，包体约 12MB（不含约 60MB 的大脑进程）。

## 4. 模型接入

- 统一用"协议 + base_url + API key"接入：
  - 协议：OpenAI 兼容（Chat Completions / Responses）或 Anthropic Messages。
  - base_url：可以填官方地址，也可以填第三方中转站。
  - 用户在设置里自选模型。
- 订阅登录不放进核心：
  - **ChatGPT 订阅**：官方允许个人本地项目使用"Sign in with ChatGPT"，作为后期可选通道（P7 及以后）。
  - **Claude 订阅**：不接。Anthropic 不允许第三方产品提供 claude.ai 登录，且有用户因此被封号的报道。
- 主动性判定这类高频、低价值的调用，可以单独配置一个更便宜的小模型。
- **中转参数**（P0.5）：认证方式（仅 Anthropic 协议：`x-api-key` 或 `Authorization: Bearer`）。自定义请求头和额外请求参数（JSON，浅合并进请求体）大脑仍支持，2026-10-27 起设置页暂不提供入口。
- **网络**：大脑进程读取系统代理设置（`scutil --proxy`）并用于 Bun 的 `fetch`，不另设代理项。

## 5. 权限

| 模式 | 工作目录 | 其他目录 | 联网 | shell |
|---|---|---|---|---|
| 询问 | 每次写入或执行都问 | 按单目录规则 | 问 | 沙箱 + 问 |
| **自动（默认）** | 全部放行 | 按单目录规则（允许 / 询问 / 拒绝） | 问 | seatbelt 沙箱，只能写工作目录 |
| 完全访问 | 全部放行 | 全部放行 | 放行 | 不加沙箱 |

任何模式下都成立的规则：

- **硬性禁区永远拒绝**：钥匙串、`~/.ssh`、浏览器的密码库。
- **工作目录 git 快照永远开启**：每次 agent 操作后自动提交一次，删错了能回滚。
- **实现方式**：通过 AI SDK 的 `toolApproval` 函数，把每次工具调用映射到上表。

## 6. 记忆

- **存储**：
  - Markdown 文件存在 `~/Familiar/memory/`，是唯一的真实数据，用户可以直接读和改，git 快照提供版本历史。
  - SQLite 的 FTS5 和 sqlite-vec 只是检索索引，可以随时从 Markdown 重建。
- **分类**：画像（你是谁、偏好）、时间线（每天发生了什么）、主题（项目、在研究的东西）、习惯（反复出现的流程）。
- **写入**：
  - 用户明确说"记住……"，立即写入。
  - 每次对话结束和每次 Computer History 摘要之后，跑一遍"反思"，抽取出候选记忆。
  - 推断出来的偏好先进"待确认"区，带置信度；用户确认，或同样的情况被反复观察到，才转正。"待确认"区就是面板里的"它对我的判断"，用户可以纠正。
- **遗忘**：
  - 时间线逐级压缩：按天记录，满一周合成周记，满一个月合成月记。
  - 偏好被推翻时，用新的标记替换旧的，不直接删除，保留历史。
  - 用户可以删除任意一条。
  - 敏感信息永远不写入。

## 7. Computer History（感知）

参考 ChatGPT Computer History 现行方案，并补上它的两个短板：记忆不加密、没有采集前的敏感信息过滤。

- **采集**：
  - 只采辅助功能事件和文本：前台应用、窗口标题、浏览器 URL 和页面标题、空闲状态、可读到的文本上下文。
  - 不截图，不申请屏幕录制权限，不碰摄像头和麦克风。
  - 只在有变化时采集（切换应用、点击、停止输入），不做定时采样。
- **默认关闭，白名单开启**：先开浏览器、IDE、终端；浏览器隐私模式一律排除。
- **两层存储**：
  - 原始事件：在本地加密缓冲，最多保留 48 小时，密钥放在钥匙串里。
  - 长期记忆：定时摘要成时间线和候选记忆。
  - 两层可以分别删除。
- **敏感信息过滤**：采集时就丢弃密码框、卡号这类内容。
- **出机说明**：摘要用的是用户选的模型，所以过滤后的文本会离开本机。设置里要写明这一点；某个应用可以标记成"只采集，不上传摘要"。
- **控制面板**（先于感知功能上线）：
  - 一键暂停。
  - 应用和网站的白名单 / 排除名单。
  - 清除最近 10 分钟、1 小时、1 天或全部记录。
  - 查看和删除记忆。
- **安全**：采集来的内容一律当作不可信输入，防止提示注入。
- **签名**：从 P2 起，开发期也用固定的自签证书签名。ad-hoc 签名每次重新构建都会变，辅助功能授权会悄悄失效，系统设置里却仍显示已勾选。

## 8. 主动性

- **触发源**：
  1. 事件：在同一个问题上卡了很久、连续工作太久没休息、离开后回来、每天第一次打开电脑。
  2. 记忆：跟进用户之前说过的事。
  3. 提醒到期。
  4. 心跳：定时检查一次有没有值得说的事。
- **判定流程**：先用便宜的规则筛选，有候选事件时才用小模型判断值不值得打扰，不在每次心跳时都调用模型。
- **打扰预算**（默认值，可在设置里改）：
  - 每天最多 5 次，两次之间至少隔 45 分钟。
  - 免打扰时段、全屏、会议中保持静默。会议判断用前台应用（Zoom、Teams、飞书会议）、麦克风是否被占用；日历是可选信号。
  - 用户点"忽略"或"别烦我"会让它自动收敛，回复会提高权重。
  - 以后用评测数据来调这些参数。
- **透明度**：每次主动发言都附带"为什么现在说"的依据。
- **情绪和困扰**：只从行为信号和聊天文本判断，推断结果放进"它对我的判断"，可以纠正。
- **提醒**：只用自己维护的调度，不写系统的提醒事项和日历。
- **日历**：做成设置项，默认关闭；打开后也只读，永远不写。

## 9. 宠物

### 状态模型

| 维度 | 取值 | 作用 |
|---|---|---|
| 在做什么 | 待机、倾听、思考、干活、说话、需要你、睡觉 | 决定播放哪段动画 |
| 心情 | 开心、担心、困、好奇、平静 | 影响表情和气泡语气；面板里能看到为什么是这个心情 |
| 感知指示（必须有） | 采集中、暂停、只听聊天 | 一眼看出它有没有在看你，比如暂停时戴眼罩 |
| 精力 | 随作息时间变化 | 深夜犯困、催你睡觉；影响主动频率 |
| 亲密度 | 随互动次数增长 | 影响称呼、语气和主动程度 |
| 身体交互 | 被拖动、被摸头、被戳、沿屏幕边缘走、坐在窗口顶上、贴边藏起并从边缘探头 | 只在壳里本地处理，不经过大脑 |

显示优先级："需要你"最高，其次是进行中的对话或任务，最后是空闲时的心情表现。宠物旁边配一个活动托盘，列出正在跑的任务和待处理的提醒。ChatGPT Pets 只作参考，不照抄。

精力和亲密度先做简单版：精力看作息时间，亲密度看互动次数，后面再细化。

贴边藏起（2026-10-27 记下，暂不做）：把宠物拖到屏幕边缘时缩进去、只露一点，鼠标靠近或有事时探出来；"根据用户当前状态自己藏 / 自己扒出来"依赖 P3 的完整状态模型和感知，探头动作要在 P6 补进图集。手动藏起可以在 P3 前单独做。

动作快慢（P0.5）：设置里分慢 / 正常 / 快（帧率 ×0.6 / ×1 / ×1.5），作用于宠物自己的动画；被拖动时的跑动动画跟手，不受影响。

### 皮肤

- 皮肤只管外观；人设、记忆和关系与皮肤无关，换皮不会失忆。
- **格式直接兼容 ChatGPT 宠物**（P0.5 定）：`pet.json` + `spritesheet`，v1 为 1536×1872（9 行），v2 为 1536×2288（多出 16 个视线方向）；每格 192×208，8 列。可从 `~/.codex/pets` 导入。
- **扩展动作**：ChatGPT 图集缺的动作放进同目录的 `familiar.json` + 扩展图集，不改原图集。Xiaohei Q 已补齐 listening、talking、sleeping、petted、poked、worried 六行（由 Codex 用 imagegen 生成）。
- **默认皮肤**：Xiaohei Q（作者自己在 ChatGPT 里生成的形象，自用；对外分发前需另做内置皮肤）。
- **动作映射**：待机→idle；拖动→running-left/right；单击、每天初见→waving；被摸头→petted；思考/干活→running（看书）；说话→talking；需要你→waiting；回复完成未读→review；出错→failed；睡觉→sleeping；担心→worried。感知指示不画进图集，用叠加的小圆点。
- 人设写在一个可编辑的人设文件里；相处中的演化写进记忆，不改人设文件本身。

### 界面（P0.5 定稿，稿子在 `docs/ui/`）

- **视觉方向**：原生 macOS 27 风为底（系统字体、系统强调色、跟随深浅色），玻璃带一点暖色；小黑的草绿只用在属于它的元素上（感知点、气泡尾点）。界面安静，个性来自宠物本身。
- **交互结构**：单击宠物 → 迷你输入胶囊；短回复挂在宠物头顶的气泡里；长回复或需要审批时才展开聊天面板。参考 ChatGPT 的 Mini。胶囊一次只跑一轮：发出后输入框换成状态行（在想 / 正在用某个工具 / 正在回复，点它展开面板）加停止键，结束后回到输入框并聚焦；失败时把刚才那句放回输入框，方便重发。
- **个性细节**：小黑主动说话的气泡带猫耳；展开面板思考时，小黑捧书扒在面板上沿。
- **尺寸**：宠物默认约 140pt，胶囊高 48pt，气泡和胶囊字号 15；设置窗口保持系统设置的原生尺寸。
- **材质**：用 Tauri 的 window effects（popover / sidebar 材质，即系统 NSVisualEffectView）；暂不用依赖私有接口的 Liquid Glass。

## 10. 交互入口

- 宠物本体：气泡、点击、拖动。
- 点击宠物弹出迷你输入胶囊，对话长了再展开成聊天面板（见 §9 界面）。
- 对话记录：每个对话一个 Markdown 文件，存在 `~/Familiar/conversations/`（可直接阅读；机器需要的时间、工具、错误写在 HTML 注释里）。启动时接着最近的对话；聊天面板标题栏的「历史」进入列表，可搜索、打开继续、删除（移到废纸篓）；设置「隐私」页可打开文件夹或清空。
- 续聊：重新打开胶囊时，上方有一行上下文条（「上次聊到…」点开面板，或「新对话」）。最后一条消息超过 2 小时后再从胶囊开口，会自动开新对话，旧的进历史，上下文条提供「继续上次」。
- 其他入口：右键宠物（打开对话 / 新对话 / 历史对话 / 设置），托盘菜单同样有这几项。暂不设全局快捷键。
- 收起：默认「点击别处时自动收起」——点到其他应用后聊天面板和胶囊一起收起，只留宠物；等待审批或输入框有草稿时保持。面板里 Esc 一步收起（在历史列表里先回到对话）。设置「宠物」页可改成「保持显示」。
- 不接 IM 通道，不做手机端。
- 语音（输入、播报、唤醒词）放在后段。

## 11. 知识库

- 与记忆分离：记忆是关于用户的，大部分由它自己写；知识库是关于文档的，由用户提供。
- 收录范围：
  - 用户明确添加的文件夹（如 Obsidian 库、项目文档）：只读索引，监听文件变化自动更新。
  - 工作目录下的 `~/Familiar/knowledge/`。
  - 用户在聊天里让它"存下来"的网页。
- 格式：md、txt、pdf、代码。
- 与记忆共用同一个 SQLite 数据库，但分表存储。

## 12. 评测与推进

- **评测**：用 promptfoo，从 P1 开始建最小评测集。"待确认"区里被用户纠正的判断，以及主动发言收到的反馈，都是评测数据。
- **推进方式**：按层推进，每层做扎实再往上叠。每个阶段做完，正常用一段时间再进入下一阶段。

| 阶段 | 内容 |
|---|---|
| P0 骨架 | 壳（现为 Tauri）、宠物窗口（占位形象，可拖可点）、聊天面板、模型设置（协议 / 地址 / key）、AI SDK agent loop、工作目录、三档权限、git 快照、沙箱 |
| P0.5 体验打磨 | 皮肤系统（兼容 ChatGPT 宠物）与动作状态机、补齐扩展动作、中转参数、UI 按定稿重做（胶囊 / 气泡 / 面板 / 设置窗口） |
| P1 记忆 | 写入、反思、待确认区、遗忘、索引、记忆查看面板；最小评测集 |
| P2 感知 | 数据控制面板 → Swift 采集程序、白名单、加密缓冲、敏感信息过滤、摘要生成时间线；固定自签证书 |
| P3 主动性 | 调度器、触发规则、打扰预算、完整状态模型、提醒 |
| P4 知识库 | 文件夹索引、`knowledge/`、网页保存、检索 |
| P5 评测 | 完善评测体系，用它调整主动行为的参数 |
| P6 皮肤 | 皮肤规格落地、内置形象精修、人设与命名引导 |
| P7 及以后 | Computer Use、语音、ChatGPT 订阅通道、本地模型（大纲第 8 项）、AI 生成宠物形象 |

## 13. 被否决的方案

| 方案 | 否决理由 |
|---|---|
| 自己从零写 agent loop | 用户选择借用现成方案，原理另外学 |
| 把 OpenClaw 整个当后端 | 是重型网关服务，默认拥有全部权限，Claude 订阅已不覆盖它；只作为记忆和心跳设计的参考 |
| 调起 Codex / Claude Code CLI 子进程来用订阅额度 | 架构别扭；Claude 订阅接入有封号风险；改走 API key 加中转站 |
| Mastra 作主框架 | 记忆以 LibSQL 为准，与"Markdown 为准"冲突；官方 Electron 方案要起独立服务，不能嵌进主进程 |
| Electron（P0–P0.5 曾使用） | 只做 Mac 时跨平台与单一语言的优势用不上；包体约 300MB；透明穿透、毛玻璃、原生控件都要绕路。2026-10-26 迁到 Tauri，旧版见标签 `electron-prototype` |
| Swift 原生壳 | 窗口与控件最原生，但界面要用 SwiftUI 全部重写；Tauri 能复用现有 React 界面，实验已验证窗口能力可行 |
| Swift 原生壳 | 窗口体验最好，但要两种语言加一层进程间通信，偏离"学 AI"的重点 |
| screenpipe 作采集层 | 许可证已改为商业许可；只参考它"有变化才采集"的事件驱动设计 |
| 截图加 OCR 的感知方式 | 要申请屏幕录制权限、数据量大、隐私负担重；ChatGPT 也从这条路（Chronicle）退了出来 |

## 14. 已知风险与待验证

- AI SDK 大版本迭代快（一年多从 v5 出到 v7），只支持 ESM，要求 Node 22 及以上。
- 中转站的协议"方言"（reasoning 字段、`max_tokens` 字段名等）可能需要自己写 middleware 适配。
- 点击穿透靠轮询（16ms）加网页判断，鼠标瞬移后立刻点击可能落到下层窗口；真人操作一般不受影响。
- 用 sqlite-vec 时，要确认 Bun 的 `bun:sqlite` 加载扩展的方式（需要 `Database.setCustomSQLite` 指向自带的 SQLite）。
- 各浏览器的 URL 能不能通过 AX 树读到，要实测；读不到的改用 AppleScript。

## 附录：调研来源（2026-10-25）

ChatGPT Pets / Computer History
- https://learn.chatgpt.com/docs/pets.md
- https://learn.chatgpt.com/docs/customization/computer-history.md
- https://www.unite.ai/openais-computer-history-turns-mac-activity-into-chatgpt-memory/
- https://help.openai.com/articles/12293630-chatgpt-pulse
- https://github.com/screenpipe/screenpipe

订阅接入政策
- https://code.claude.com/docs/en/agent-sdk/overview
- https://code.claude.com/docs/en/legal-and-compliance
- https://support.claude.com/en/articles/15036540
- https://learn.chatgpt.com/docs/app-server
- https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt
- https://developers.openai.com/siwc/token-sharing-open-source
- https://cybersecuritynews.com/claude-ends-openclaw-subscriptions/

框架
- https://vercel.com/blog/ai-sdk-7
- https://ai-sdk.dev/v7/docs/agents/tool-approvals
- https://mastra.ai/integrations/frameworks/electron.md
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/ai/README.md

壳
- https://www.electronjs.org/docs/latest/api/structures/base-window-options
- https://releases.electronjs.org/pr/52365
- https://github.com/tauri-apps/tauri/issues/13415
- https://github.com/tauri-apps/tauri/issues/9250
- https://github.com/tauri-apps/tauri/issues/13070
- https://github.com/ahkohd/tauri-nspanel
- https://github.com/ayangweb/BongoCat/blob/master/docs/adr/0003-native-overlay-renderers.md
- https://docs.openclaw.ai/platforms/mac/signing
- https://betterstack.com/community/guides/scaling-nodejs/tauri-vs-electron-vs-deno-vs-electrobun/
