# dsh-retrace agent 工作手册

本仓库没有 src/，**lib/ 就是源码本体**；改视觉样式是「双文件同步」：

| 文件 | 角色 |
| --- | --- |
| `lib/client.js` | 可读源（createElement 组件 + CSS 模板串），约 900–1400 行段 |
| `lib/client.bundle.js` | **实际运行入口**（package.json `exports["./client"]` 指向它；`window.__ModuleLoader__.load` 包装，内联了 client.js 的全部内容，不 import 它） |

只改 client.js 等于没改；两个文件都要动，改完各自 `node --check`。

## 1. 构建链约束

- `package.json` 里的 `build` / `check` 脚本引用 `scripts/*.mjs`，**该目录不在仓库里（私有工具链），跑不了也别试图修复**。
- 无 node_modules，`test`（vitest）同样不可用；**不要 pnpm install**（会生成 node_modules，仓库没有 .gitignore 之外的保护，勿提交）。
- 唯一检查手段：`node --check lib/client.js && node --check lib/client.bundle.js`，加真实 E2E。

## 2. 视觉样式地图

- **全局 CSS**：`const CSS = '...'` 模板串（搜 `.dsh-rt-user-row{` 定位，client.js ~1103 行起），运行时注入 `<style data-plugin-css="dsh-retrace-css">`。所有 `.dsh-rt-*` 类：ghost chips（`-ghost`/`-ghost-danger`/`-ghost-armed`，对话页与阅读页注入器共用，单行文字钮、danger hover 红、armed 常红）、胶囊 chips（`-chip`/`-chip-danger`，时间线/轨迹/预览等对话框仍在用）、用户操作行（`-user-row`/`-user-actions`）、编辑器（`-editor`/`-textarea`/`-editor-buttons`/`-editor-send`/`-editor-cancel`）、报错（`-error`）、时间线/分叉 tab、marker 等。**同一字符串在 bundle 里还有一份，必须同步改**。
- **组件**（createElement 写法，两文件平行镜像）：`UserActionsRow`（`conversation.chat.node` 的 `user-actions` slot，对话页）里的编辑/撤回 ghost chips 与两步确认；撤回 marker、retrace-reference 原文引用块、assistant-actions、轨迹/版本/分叉视图。
- **阅读页注入器**（client.js ~1958 起，bundle 内有镜像）：`readerChatInfo` / `mountReaderChipRow` / `scanReaderClusters`，全部用原生 DOM API（非 createElement）——改完同样两个文件都要同步。
- 设计 token 用 dsh web 主题的 `--dsw-alias-*`（label-primary/secondary/tertiary、interactive-bg-hover(-solid)、state-error-primary、border-l1/l2/l3、bg-base/elevated/module-platform），不要写死色值。

## 3. 与 dsh-better-display 的边界（重要）

**本仓库独占全部撤回操作 UI**（对话页 + 阅读页）；better-display 只做纯展示（v0.1.4+，不含任何操作 UI）。

- **对话页**：官方 `conversation.chat.node` slot 的 `user-actions` → `UserActionsRow`，chips 用 `.dsh-rt-ghost` 单行 ghost 风；撤回两步确认（`RECALL_CONFIRM_MS=3000`，useRef 计时器 + unmount 清理）。
- **阅读页**：better-display 不渲染 chat.node 槽位，改由本仓库的 DOM 注入器补 chips。
  - 数据源：`readerChatInfo` 从 sessions store 取当前会话 nodes，建 `actionsBySeq`（seq→user-actions）/ `shadowedSeqs`（recall-marker）索引。
  - 挂载：`mountReaderChipRow` 把 ghost chips 挂进 `button[aria-label="复制消息"]` 所在行，编辑器/报错挂消息簇末尾；挂载标记 `data-dsh-rt-reader="1"`；回填输入框用 textarea 原生 value setter + `input` 事件。
  - 扫描：`scanReaderClusters` 用 MutationObserver（rAF 去抖）+ 1.5s interval；消息被 shadow 后自动摘除（cleanup 存于 `span._dshRtCleanup`）。
- **锚点契约（不要单方面改）**：注入器只认 better-display 的稳定标记 `[data-reader-anchor][data-reader-key]` 定位用户消息簇，**不碰其内部 class**。better-display 侧必须保留这两个属性（它自己的 motion/滚动定位也依赖 `data-reader-anchor`）；改锚点前先与 better-display 侧对齐。
- better-display 里旧的 `.retraceChip`/`.retraceChipDanger`/`.retraceChipArmed`/`.retraceRowBreak` 以及 `RetraceActions.tsx`/`callRetraceOp` 已在 v0.1.4 删除，不要在那边找回。本仓库的 `.dsh-rt-editor`/`.dsh-rt-textarea`/`.dsh-rt-error` 等类现在对话页与阅读页注入器共用，改这些类两边都会变。

## 4. 部署闭环（注意 profile 钉了 commit）

```sh
# 1) bump package.json version；node --check 两个 lib 文件
# 2) commit + push origin main
# 3) profile 里是 "dsh-retrace": "github:daha1216/dsh-retrace#101df7f" ——
#    钉死的 spec 用 update 不会前进，必须重新 add 指到新 commit：
powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/daha/.dsh/stop-dsh-web.ps1
cd C:/Users/daha/.dsh && HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 dsh plugin --profile web add github:daha1216/dsh-retrace#<新hash>
powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/daha/.dsh/launch-deepseek-harness.ps1 -NoOpen
# 4) 刷新浏览器页面（插件 bundle 走 rev 缓存），在「对话」tab 和「阅读」tab 分别验证 chips 视觉（阅读页 chips 由本仓库注入器挂载）
```

- E2E 习惯：role 定位器在本应用常超时，用 `tab.playwright.evaluate()` + `dispatchEvent(new MouseEvent("click",{bubbles:true}))`；输入框用 React 原生 value setter + `input` 事件。
- 撤回是重操作：E2E 请在一次性测试会话里做，完事删除会话。
