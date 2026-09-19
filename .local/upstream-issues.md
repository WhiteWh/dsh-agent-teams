# Upstream open issues and pull requests

Source: https://api.github.com/repos/NanmiCoder/dsh-agent-teams/issues?state=open&per_page=100&sort=created&direction=desc
Fetched: 2026-09-19T13:19:52.073Z
Count: 62

Fetch the body of one item with:
`node -e "fetch('https://api.github.com/repos/NanmiCoder/dsh-agent-teams/issues/<n>').then(r=>r.text()).then(t=>console.log(t))"`

| # | kind | created | comments | title |
| --- | --- | --- | --- | --- |
| 187 | issue | 2026-09-18 | 0 | 请兼容deepseek harness v0.1.6-alpha.2版本 |
| 186 | PR | 2026-09-18 | 0 | feat: declare Harness 0.1.5-rc.2 support with live acceptance evidence |
| 185 | issue | 2026-09-18 | 0 | 请支持DSH 0.1.5-rc.2 |
| 184 | issue | 2026-09-18 | 0 | 配置是不是可以放到web上 |
| 183 | issue | 2026-09-17 | 0 | [Bug] Repair rounds derived from findings on default-excluded paths (secrets/, .env.*) are unsatisfiable: derived inScope contains what the completion gate classifies out_of_scope |
| 182 | PR | 2026-09-17 | 0 | fix: sanitize tool-call syntax in team, member, and task fields |
| 181 | issue | 2026-09-17 | 0 | 是否可以是陪一下sidebar呢？ |
| 179 | PR | 2026-09-16 | 0 | fix: expect 14 captain team tools in the progressive-entry fixture |
| 177 | PR | 2026-09-16 | 0 | fix: name the two colliding lists when a contract contradicts itself (#173) |
| 176 | issue | 2026-09-16 | 0 | [Bug] Forking the captain session orphans the team: captain identity is pinned to the creating session id |
| 175 | issue | 2026-09-16 | 0 | [Bug] repair rounds are not wired to the findings they fix: false "failed without a follow-up repair", and auto-repair fires for reviews but not verifications |
| 174 | issue | 2026-09-16 | 0 | [Bug] auto-generated acceptance/In-scope for repair rounds is frozen at finding-generation time and silently goes stale (6 cases in one run) |
| 171 | PR | 2026-09-16 | 1 | fix: record why a member dispatch was rejected |
| 169 | PR | 2026-09-15 | 0 | fix: stop writing a bespoke message source kind for AgentTeams activations (#160) |
| 165 | issue | 2026-09-14 | 0 | feat: 建议补一份 dsh-plugin.json（dsh-std 声明清单，Community Admission v0.15） |
| 162 | issue | 2026-09-13 | 1 | subagent复用率过高，导致上下文窗口膨胀 |
| 161 | issue | 2026-09-12 | 1 | [Bug] "deliverable" can be true for bytes no review ever saw — a passing review is not bound to the revision it judged |
| 160 | issue | 2026-09-12 | 2 | [Bug] source.kind `agent-teams-command` 未在 DSH 0.1.5 的迁移白名单内，导致用过 /agent-teams 的历史会话升级后全部无法打开 |
| 159 | issue | 2026-09-12 | 1 | 子代理之间交流会囤积数十条，导致接收者一直收到已经过期的消息，然后重复修复同一问题，导致死锁 |
| 158 | issue | 2026-09-12 | 0 | 主的无法中断成员 |
| 157 | issue | 2026-09-12 | 0 | [dsh-plugin.org \| dsh-plugin-hub] plugin install failed: nanmicoder/dsh-agent-teams |
| 154 | issue | 2026-09-11 | 0 | captain-idle-wakeup CI flake: teardown flush loop races member session retirement |
| 151 | issue | 2026-09-10 | 1 | 死循环了，还好余额没充多少…… |
| 149 | PR | 2026-09-07 | 0 | Codex/release v0.1.16 |
| 147 | PR | 2026-09-07 | 1 | feat: add Parallel Emission opt-in across protocol surfaces |
| 144 | PR | 2026-09-07 | 0 | feat(scheduler): add maxConcurrentWorkers global dispatch cap (refs #97) |
| 141 | PR | 2026-09-07 | 0 | fix: align module export name with package name (@nanmicoder/dsh-agent-teams) |
| 140 | PR | 2026-09-07 | 0 | test: 会话事件写入侧防护回归测试 (refs #8) |
| 137 | issue | 2026-09-06 | 0 | issue |
| 136 | issue | 2026-09-06 | 0 | 在DSH Desktop 2.0.4升级后，不能使用 |
| 132 | issue | 2026-09-05 | 5 | Harness 0.1.2-rc.1 (public npm) fails to boot: ctx.subagents.registerContinuableSetup is not a function — no installable version works (0.1.15/0.1.14 verified, 0.1.13 source has same call) |
| 128 | issue | 2026-09-04 | 2 | 0.1.15 breaks Deepseek-Harness-Desktop (embedded dsh 0.1.1-rc.1): pending uiConversation; auto-upgrade via package ranges makes it worse |
| 126 | issue | 2026-09-04 | 2 | 建议：npm上不要把对应dsh alpha版本的设置为latest |
| 123 | issue | 2026-09-03 | 4 | [bug] 不兼容宿主 dsh 0.1.2-alpha.5：boot 阶段 `ctx.subagents.registerContinuableSetup is not a function`，导致整个 dsh web 插件树加载失败 |
| 121 | issue | 2026-09-03 | 1 | [feat] 可以把图标加个替换的功能，让客户自由替换不同角色对应的图标吗 |
| 120 | issue | 2026-09-03 | 6 | 0.1.15 在 dsh 0.1.2-alpha.5 下无法加载：ctx.subagents.registerContinuableSetup 已不存在 |
| 118 | PR | 2026-09-02 | 0 | client: Kimi-minimal activity panel and identity marks |
| 117 | issue | 2026-09-02 | 3 | Describe the bug 使用多Agent团队任务后，Node进程内存只涨不跌，多次任务后触发OOM崩溃。 |
| 114 | issue | 2026-09-01 | 3 | Feature Request: Prevent long-running AgentTeams members from accumulating excessive context |
| 113 | issue | 2026-09-01 | 6 | can't load |
| 111 | issue | 2026-08-31 | 1 | An error message prevented deepseek-harness-desktop from starting. |
| 107 | issue | 2026-08-31 | 11 | DSH 从 0.1.1-rc.2 更新到了 0.1.2-alpha.1，插件无法使用 |
| 103 | issue | 2026-08-30 | 3 | [Bug] Scheduler regenerates attemptId for idle member owning open task, causing stale attempt errors |
| 101 | issue | 2026-08-29 | 1 | Feature Request: Optional dsh-better-sidebar Integration for the Activity Panel |
| 97 | issue | 2026-08-29 | 1 | 希望增加：全局并发限制 (maxConcurrentWorkers) 并支持限流后自动恢复 |
| 96 | issue | 2026-08-28 | 3 | 太烧token，能做成Agent 预设吗？ |
| 80 | PR | 2026-08-25 | 3 | feat: add team history controls |
| 76 | issue | 2026-08-25 | 4 | 子代理在额度耗尽时缺少降级 / 兜底机制，导致协作进度断裂 |
| 71 | issue | 2026-08-23 | 1 | issue3-斜杠命令分发.md |
| 70 | issue | 2026-08-23 | 1 | issue2-消息附件.md |
| 67 | PR | 2026-08-23 | 1 | feat: add configurable custom avatars |
| 62 | issue | 2026-08-21 | 4 | Sparse per-task probes and optional Parallel Emission |
| 59 | issue | 2026-08-21 | 1 | Feature proposal: reusable per-member tool policies (allow/deny) |
| 58 | issue | 2026-08-21 | 3 | Feature: Add pluggable visual status indicators for all agents |
| 54 | issue | 2026-08-20 | 1 | 插件模块导出的 name（`agent-teams`）与包名（`@nanmicoder/dsh-agent-teams`）不一致 |
| 48 | PR | 2026-08-18 | 0 |  通过消除 status 轮询和启用并行工具调用减少 token 浪费 |
| 38 | PR | 2026-08-17 | 0 | feat: embed AgentTeams activity panel in Better Sidebar tab |
| 37 | PR | 2026-08-16 | 0 | feat: add focus mode to reduce human interruption |
| 32 | PR | 2026-08-16 | 0 | fix: add prepare script so github: installs build lib/ |
| 31 | PR | 2026-08-16 | 0 | fix: preserve preset persona for team members |
| 21 | PR | 2026-08-14 | 1 | fix: add session-log migration tool for pre-0.1.0 logs (Fixes #19) |
| 19 | issue | 2026-08-14 | 2 | [反馈] agent-teams/* 事件导致历史会话重启后无法加载：确认 0.1.0 已修复，但存量会话建议提供迁移工具 |
