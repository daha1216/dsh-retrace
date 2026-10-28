# dsh-retrace agent 工作手册

本仓库没有 src/，**lib/ 就是源码本体**；改视觉样式是「双文件同步」：

| 文件 | 角色 |
| --- | --- |
| `lib/client.js` | 可读源（createElement 组件 + CSS 模板串），全文约 3100 行；CSS 模板串从 ``const CSS = ` `` 到单独一行反引号（约 1600 行起，行号随版本漂移，一律用符号锚定定位） |
| `lib/client.bundle.js` | **实际运行入口**（package.json `exports["./client"]` 指向它；`window.__ModuleLoader__.load` 包装，内联了 client.js 的全部内容，不 import 它） |

只改 client.js 等于没改；两个文件都要动，改完各自 `node --check`。

**读取 marker / 事件的唯一入口是 `lib/adapter/normalize.js`**（0.4.57 起）：它同时认识旧
`data.message.id` 与现行顶层 `data.id`，用 `eventAt(events, seq)` 处理窗口化日志（宿主按
`log[seq - baseSeq]` 索引，`events[seq]` 只对 baseSeq=0 成立），并导出现在宿主自己的
`foldSurface`。新增读取方一律走它，不要自己 `event.data.message?.id` 或 `events[seq]`。

**产物存储的键一律带会话 ID**（0.4.58 起）：引用是 `<sessionId>|<versionId>|<path>`，
git 事实键是 `<sessionId>|<versionId>`，构造函数 `refFor()` / `versionKey()` 在
`lib/artifact-store.js`。版本号是会话内序号，脱离会话就不唯一；没有会话 ID 的旧行
（`parseRef().legacy`）一律视为不可归属——GC 不释放、按会话查询不命中，不要给它们
猜归属。

**请求边界**（0.4.61 起；0.4.79 加严）：插件路由不受宿主鉴权保护，因此自带三道闸——套接字对端
与 `Host` 头都必须是环回地址（只伪造 `Host` 不再放行；隧道/局域网需 `DSH_RETRACE_ALLOW_REMOTE=1`
显式开启），写请求必须带
`x-retrace-client: web`（错误码 `host-not-allowed` / `client-header-required`，均 403），
`git/init` 需要 `confirm: true` 且沙箱策略解析失败时以 `sandbox-policy-unavailable`
失败关闭。只读 GET 不要求凭据，改动前先确认它不暴露工作区之外的内容。

**回退票据与审计**（0.4.60 起）：`POST /rollback/preview` 返回一次性 `planId`，
`POST /rollback` 必须带它；错误码 `plan-required` / `plan-expired` / `plan-used` /
`plan-mismatch` / `plan-stale` / `restore-unsupported` 一律映射 HTTP 409。每次执行
追加一行到 `<storeRoot>/operations.jsonl`，只含 ID、范围与逐文件状态。

**快照写入的三条不变量**（0.4.59 起；0.4.79 调整第②条）：①同一 sha 的引用读改写走
`withSha()` 串行链，否则同内容并发快照会丢引用；②引用写入失败时**不再同步删对象**——
错误发生时可能已有别的并发快照先写入成功同一 sha 的引用，删掉会丢活数据；对象留给
`sweepGc` 的宽限期（`GC_GRACE_MS`）按“无引用且够老”回收；③sweep
先 `settleSnapshots()` 等在途快照，再算 keep。边界捕获若在读取期间被更新的边界动过同一
路径，引用会进 `racy` 数组，回退侧必须用 `snapshotState()`（不是 `resolveSnapshot()`）
判断并拒绝，理由码 `snapshot-racy`。

## 1. 构建链约束

- **0.4.64 起 `client.bundle.js` 可以生成**：`node scripts/build-client.mjs` 用确定性变换（react 用 require、badge.js 内联、去 `export ` 前缀、末尾 `module.exports`）从 `client.js` 产出 bundle，`--check` 模式只比对不写盘。生成物与源的行为等价性靠「同一变换 + `--check` + 双文件符号镜像」保证：改完必须两份都 `node --check`，再跑 `node scripts/check-syntax.mjs`（它会比对 bundle 与源是否同步）。
- `node scripts/check-syntax.mjs` 一次跑完：全部 `lib/**/*.js` 的 `node --check`（无例外）、package.json 与 README/AGENTS 的版本号一致性、bundle 是否与源同步。**改完客户端先跑它**。
- 0.4.66 删除了 `lib/dynamic-client.js` / `lib/dynamic-host.js` 及其 `exports` 条目：它们停在 0.4.43，缺此后所有安全修复，属于已知不安全的旁路。要恢复动态入口，必须先写生成器 + 双半区等价测试。
- 无 node_modules，`vitest` 不可用；**不要 pnpm install**（会生成 node_modules，勿提交）。
- 布局 E2E：`node scripts/e2e-layout.cjs`（仓库自带；playwright 与 dsh web 环境路径见脚本头注释，可用 `DSH_WEB_URL` / `DSH_WEB_LOG` / `DSH_WEBKIT_PATH` 覆盖）。

## 2. 视觉样式地图

- **全局 CSS**：``const CSS = `...` `` 模板串（用符号锚定：搜 ``const CSS = ` `` 或 `.dsh-rt-user-row{`，client.js 约 1600 行起、约 200 行后以单独一行反引号结束；行号会漂移，别写死）。`STYLE_ID = 'dsh-retrace-css'`（紧挨在 ``const CSS`` 上一行），由 `ensureStyle()` 注入；运行时注入的标签是 **`<style data-plugin-css="dsh-retrace-css">`，没有 `id` 属性**，探测部署是否生效用 `document.querySelector('style[data-plugin-css="dsh-retrace-css"]')`（**不要用 `#dsh-retrace-css`**）。所有 `.dsh-rt-*` 类：ghost chips（`-ghost`/`-ghost-danger`/`-ghost-armed`，对话页与阅读页注入器共用，单行文字钮、danger hover 红、armed 常红）、胶囊 chips（`-chip`/`-chip-danger`，时间线/轨迹/预览等对话框仍在用）、用户操作行（`-user-row`/`-user-actions`）、编辑器（`-editor`/`-textarea`/`-editor-buttons`/`-editor-send`/`-editor-cancel`）、报错（`-error`）、时间线/分叉 tab、marker 等。**同一字符串在 bundle 里还有一份，必须同步改**。
- **组件**（createElement 写法，两文件平行镜像）：`UserActionsRow`（符号锚定 `function UserActionsRow`，约 1200 行，注册到 `conversation.chat.node` 的 `user-actions` slot，对话页）里的编辑/撤回 ghost chips 与两步确认；另注册 `retrace-reference` / `recall-marker` 等 node slot 与 `conversation.chat.assistant-actions`（`AssistantActions`），以及 timeline/版本/分叉视图。**0.4.39**：①四处 seat 注册（`AssistantActions` / `UserActionsRow` / `ReferenceRow` / `RecallMarkerRow`）统一经 `withSeatPropsGuard` 包装——props 为 null/undefined 或缺 propKey 时渲染 null（修的是「槽位以 null props 重渲染 entry」路径；该路径真实存在，但**不是**「撤回后 chips 永久消失」的根因）；②`UserActionsRow` 编辑态 chips 行常驻不换走，编辑框作为 Fragment 兄弟节点渲染在其下方流内（CSS 折叠规则带 `:not(:has(.dsh-rt-editor))` 逃生口）。**0.4.40（真根因）**：`UserActionsRow` / `RecallMarkerRow` 的 hidden/shadowed、compact 早退原本夹在 hook 序列中间——撤回把已挂载 entry 的 hidden/shadowed 翻转成 true 后，该次渲染少跑一个 `useEffect` → React #300（Rendered fewer hooks than expected）→ 槽位边界 `reportEntryError({abdicate:true})` → 该注册**永久弃权**成 `[data-slot-error]` 死格子，表现为撤回一次后所有用户消息的 chips 永久消失（刷新才恢复）；修复=全部 hook 执行完再早退。**seat 组件内禁止在 hook 之间提前 return（含条件 return null）**。
- **布局对齐器**（符号锚定 `chatActionAnchor` / `chatAnchorTransform` / `alignChatActionRows` / `isLayoutRelevant` / `installChatActionAligner`）：chips 内联进「时间·复制」行的几何引擎（0.4.36 方案 + 0.4.37 编辑态清位移）；observer 只对相关 mutation 调度重测（见 `isLayoutRelevant` 注释）。
- **设置分区（0.4.45 起）**：`RetraceSettings` 注册在 `settings.section` 座位（id `retrace-settings`、order 86、label `settings.tab`=「撤回」），
  不再挤在 通用 里；`SettingSwitch` 行组件 + `.dsh-rt-set-*` 类族（分组卡片/开关/步进器）。versioning 关闭时 git 与保留数联动降级（置灰禁用）。
  组件硬规则同上：hook 置顶、无中间早退。旧 `.dsh-rt-option*` 类与 `settings.general.item` 注册已删除。
- 设计 token 用 dsh web 主题的 `--dsw-alias-*`（label-primary/secondary/tertiary、interactive-bg-hover(-solid)、state-error-primary、border-l1/l2/l3、bg-base/elevated/module-platform），不要写死色值。

## 3. 历史边界：dsh-better-display（已卸载）

better-display 已于 2026-09-14 从 web profile 卸载（用户不要独立阅读 tab），其阅读页随插件一起消失。**0.4.38 起本仓库的阅读页 DOM 注入器已整体删除**（`readerChatInfo` / `mountReaderChipRow` / `scanReaderClusters` / `[data-reader-anchor]` 锚点契约不复存在）——撤回操作 UI 现在只有对话页一个宿主。

- `.dsh-rt-*` 全套类只服务对话页组件（`UserActionsRow` 的 chips/编辑器、`ReferenceRow` 引用块、marker、时间线/分叉视图）。
- 若将来重新引入「阅读/渲染」宿主，chips 挂载请走官方槽位或重建注入器；已删实现可在 git 历史（≤0.4.37）里查。

## 4. 部署闭环（注意 profile 钉了 commit）

**当前版本**：v0.4.79。profile（`C:/Users/daha/.dsh/profiles/desktop/package.json`）里钉的是
`"dsh-retrace": "github:daha1216/dsh-retrace#<commit>"`（hash 随部署更新，以 profile 实况为准）。

**改完视觉样式后的最小验证闭环**（每步都别跳，缺一步就可能在旧代码上白验）：

```sh
# 1) 双文件同步改完，各自过语法
node --check lib/client.js && node --check lib/client.bundle.js
# 2) 布局 E2E（需要本机 dsh web 跑着；脚本把本地 bundle splice 进页面模块，不动线上）
#    断言：chips 内联且右缘贴列缘 / 编辑器不遮时间·复制行（0.4.37 回归项）/ 取消后回 park
#    / 真撤回回归（0.4.40：新建一次性会话→真撤回两步→再发新消息仍须有 chips→删会话）
#    / observer 400ms 内自愈（过滤器不误杀相关 mutation）/ armed 两步确认只读验证
#    / 双文件符号镜像一致 / 零控制台错误
node scripts/e2e-layout.cjs
# 3) bump package.json version
# 4) commit + push origin main
# 5) 停服务
powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/daha/.dsh/stop-dsh-web.ps1
# 6) 重新钉 add 到新 hash（spec 钉死，update 不会前进！）
cd C:/Users/daha/.dsh && HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 dsh plugin --profile web add github:daha1216/dsh-retrace#<新hash>
# 7) 重启
powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/daha/.dsh/launch-deepseek-harness.ps1 -NoOpen
```

8. 浏览器**硬刷新**旧标签页（Ctrl+Shift+R）——插件 bundle 走 `rev` 缓存，普通刷新/F5 可能仍拿旧代码。
9. 验证部署真的生效：控制台执行 `document.querySelector('style[data-plugin-css="dsh-retrace-css"]')`，应非 null（**该 style 没有 id**，别用 `#dsh-retrace-css`）。
10. 在「对话」tab 验证 chips/编辑器/报错视觉。

- **为什么用 add 不用 update**：profile 把 spec 钉在 `#<commit>`，`dsh plugin update` 解析的是同一个钉死 commit，不会前进；必须重新 `add` 指到新 hash。
- 拉 GitHub 必须带代理：`HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890`。
- 停服/重启脚本路径：`C:/Users/daha/.dsh/stop-dsh-web.ps1`、`C:/Users/daha/.dsh/launch-deepseek-harness.ps1 -NoOpen`。
- E2E 习惯：role 定位器在本应用常超时，用 `tab.playwright.evaluate()` + `dispatchEvent(new MouseEvent("click",{bubbles:true}))`；输入框用 React 原生 value setter + `input` 事件。
- 撤回是重操作：E2E 请在一次性测试会话里做，完事归档会话（0.1.7 起核心会话菜单无「删除会话」项，脚本已按 `撤回回归测试` 前缀自动归档；磁盘残留随后续停服窗口清理）。
