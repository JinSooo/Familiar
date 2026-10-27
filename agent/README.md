# Familiar agent

运行：FAMILIAR_DATA_DIR=<数据目录> FAMILIAR_RESOURCES_DIR=<资源根> bun agent/src/main.ts。
资源根下必须有 pets/xiaohei-q；打包壳应始终显式传入两个绝对路径。
FAMILIAR_KEYCHAIN_SERVICE 可覆盖钥匙串服务名，默认 com.allinpet.familiar；
账户固定为 model-api-key。旧 encryptedApiKey 被忽略，需要重新填写 API Key。

## 文件

- src/main.ts：逐行协议、请求分发、会话/宠物状态、定时器、窗口动作。
- src/system.ts：钥匙串、系统代理、强调色、空闲时间、环境路径。
- src/settings.ts、src/session.ts：设置持久化和会话归约。
- src/agent/{index,core,provider,fetch,approvals,persona,errors}.ts：模型、流式循环、权限审批、重试、中转参数。
- src/permissions/{index,paths}.ts、src/workspace/{index,sandbox}.ts：权限、工具、沙箱和工作区快照。
- src/pets/index.ts、src/pet-logic.ts：宠物库、PNG/WebP 尺寸、图集校验和状态优先级。
- src/memory/：记忆。store（Markdown 读写、待确认、替换）、sensitive（敏感信息过滤）、search（FTS5 trigram 索引，`<数据目录>/memory-index.sqlite`，文件一变就整体重建）、reflect（反思）、timeline（周记/月记压缩）、jobs（后台调度，台账 `<数据目录>/reflected.json`）、feedback（用户对推测的确认/纠正/否定，`<数据目录>/evals/memory-feedback.jsonl`）、index（remember / forget / recall 工具）。
- eval/：promptfoo 评测集，`pnpm eval` 运行；反思用例会用设置里的后台模型发真实请求。
- tsconfig.json：agent 独立类型检查。

## 请求与 UI 动作

所有请求都有 response；agent:run 等到运行收尾才回复。未知渠道返回 ok:false。

| 渠道                                     | UI 动作 / 结果                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| settings:get / settings:save             | 脱敏设置；save 发 pet-size、tray，刷新皮肤与会话                                  |
| session:get / session:new                | 读取/重置会话；new 中止当前运行                                                   |
| agent:run                                | 流式事件；长回复或审批触发 show-chat                                              |
| agent:stop / agent:approval              | 中止/处理审批                                                                     |
| chat:toggle                              | pet 打开 show-chat；chat 发 hide-chat 并开胶囊；tray 按可见状态切换               |
| settings:open                            | show-settings                                                                     |
| overlay:capsule                          | 胶囊状态 emit 到 pet                                                              |
| pet:skin / pets:list / pets:import       | 皮肤/列表；列表刷新发 tray；导入另发 pet-size                                     |
| pets:select / pet:size-set               | 更新设置，发 pet-size、tray、皮肤和大小                                           |
| pet:finished / pet:typing                | 更新失败/输入状态                                                                 |
| window:ready                             | 向发送窗口推强调色、会话；pet 另收状态、胶囊、皮肤、大小和每日 wave；chat 收 view |
| memory:list / confirm / correct / delete | 只接受 settings；改动后提交 git 快照并广播 memory:changed                         |
| memory:reflect                           | 立即整理（不等 30 分钟），结果随 memory:changed 的 reflect 字段送达               |
| memory:reveal                            | 在 Finder 打开记忆目录                                                            |
| app:quit                                 | quit                                                                              |

session:changed、agent:event 发 all；宠物状态/手势/大小/皮肤/拖动和胶囊发 pet；
chat:view 发 chat。app-activated 广播 appearance:changed。
chat-window 信号是聊天可见/聚焦状态的来源；pet-drag move/end 发 right/left/none。

## 验证记录

已实际执行通过：

- bunx --no-install tsc --noEmit -p agent
- pnpm exec eslint agent（agent 目录零错误）。首次 pnpm lint -- agent 通过；
  最终并行构建生成 dist/ 与 src-tauri/target/ 后，全局 lint 扫到这些产物报错；
  pnpm lint --ignore-pattern 'dist/**' --ignore-pattern 'src-tauri/target/**' 通过。
- bun build --compile agent/src/main.ts --outfile /tmp/familiar-agent-test
- 源码和编译产物均启动，通过各 36 条消息的协议冒烟：
  settings:save/get（空 key、无明文返回或磁盘字段）、window:ready、chat:toggle、
  agent:run/stop、session:get、未知渠道、坏 JSON 后继续、拖动结束；
  session:changed / agent:event / pet:state 与 show-chat / pet-size / tray，
  stdin 关闭退出。
- 临时脚本、二进制和数据目录已清理。

未通过环境验证的项目：

- 带真实 API Key 的 settings:save 尝试失败，返回“无法写入钥匙串 API Key”。
  测试使用唯一服务名，并在 finally 尝试删除条目；没有触碰正式服务。
- 本地 OpenAI SSE mock 尝试在随机端口和固定端口监听，均在 Bun.serve 失败；
  Python socket.bind 确认沙箱返回 EPERM（Operation not permitted）。
  因此未验证 apiKeySet=true、真实网络成功回复、中转请求参数的端到端链路。
  需在允许本地监听与钥匙串访问的 macOS 环境补跑源码和编译产物的完整成功路径。
- 系统代理真实转发、Finder 废纸篓、十分钟系统空闲及真实窗口体验仍需集成验收。

## 集成注意

Rust 负责窗口、胶囊交互所需的聚焦/点击穿透、位置持久化、单实例、应用菜单和资源服务；
agent 不操作窗口。请持续传 chat-window 信号，执行所有 UI 动作，并正确转发 target。
done 在气泡计时结束后仍保留，直到聊天显示/聚焦或新回合/会话重置。

资源 URL 使用 familiar-pet://localhost/<id>/<file>（包括扩展图集），Rust 解析路径时须剥离 id；
共享协议注释仍描述旧 host 形式，本任务按要求未改契约文件。
旧 Electron 拖动末尾点击连击由壳/界面接管；现有 pet-drag 信号只有方向，没有“未移动点击”
信息，因此 agent 保留每日 wave，胶囊通过 overlay:capsule 控制。若需恢复原三击 poked，
集成者须在界面处理或另行扩展契约。系统强调色在 ready 和 app-activated 时刷新。

工作区 Git 快照沿用旧业务行为，仅对所配置工作目录创建快照；本项目未提交。
