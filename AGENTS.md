# dsh-retrace agent 工作手册

本仓库没有 src/，**lib/ 就是源码本体**；改视觉样式是「双文件同步」：

| 文件 | 角色 |
| --- | --- |
| `lib/client.js` | 可读源（createElement 组件 + CSS 模板串），全文约 2330 行；CSS 模板串约 1124 行起（行号随版本漂移，一律用符号锚定定位） |
| `lib/client.bundle.js` | **实际运行入口**（package.json `exports["./client"]` 指向它；`window.__ModuleLoader__.load` 包装，内联了 client.js 的全部内容，不 import 它） |

只改 client.js 等于没改；两个文件都要动，改完各自 `node --check`。

## 1. 构建链约束

- `package.json` 里的 `build` / `check` 脚本引用 `scripts/*.mjs`，**该目录不在仓库里（私有工具链），跑不了也别试图修复**。
- 无 node_modules，`test`（vitest）同样不可用；**不要 pnpm install**（会生成 node_modules，仓库没有 .gitignore 之外的保护，勿提交）。
- 检查手段：`node --check` 两文件（语法）+ `node scripts/e2e-layout.cjs`（布局 E2E，仓库自带；playwright 与 dsh web 环境路径见脚本头注释，可用 `DSH_WEB_URL` / `DSH_WEB_LOG` / `DSH_WEBKIT_PATH` 覆盖）。

## 2. 视觉样式地图

- **全局 CSS**：``const CSS = `...` `` 模板串（用符号锚定：搜 ``const CSS = ` `` 或 `.dsh-rt-user-row{`，client.js 约 1124 行起、约 115 行后以单独一行反引号结束；行号会漂移，别写死）。`STYLE_ID = 'dsh-retrace-css'`（约 1123 行），由 `ensureStyle()` 注入；运行时注入的标签是 **`<style data-plugin-css="dsh-retrace-css">`，没有 `id` 属性**，探测部署是否生效用 `document.querySelector('style[data-plugin-css="dsh-retrace-css"]')`（**不要用 `#dsh-retrace-css`**）。所有 `.dsh-rt-*` 类：ghost chips（`-ghost`/`-ghost-danger`/`-ghost-armed`，对话页与阅读页注入器共用，单行文字钮、danger hover 红、armed 常红）、胶囊 chips（`-chip`/`-chip-danger`，时间线/轨迹/预览等对话框仍在用）、用户操作行（`-user-row`/`-user-actions`）、编辑器（`-editor`/`-textarea`/`-editor-buttons`/`-editor-send`/`-editor-cancel`）、报错（`-error`）、时间线/分叉 tab、marker 等。**同一字符串在 bundle 里还有一份，必须同步改**。
- **组件**（createElement 写法，两文件平行镜像）：`UserActionsRow`（约 891 行，注册到 `conversation.chat.node` 的 `user-actions` slot，对话页）里的编辑/撤回 ghost chips 与两步确认；另注册 `retrace-reference` / `recall-marker` 等 node slot 与 `conversation.chat.assistant-actions`（`AssistantActions`），以及 timeline/版本/分叉视图。
- **布局对齐器**（符号锚定 `chatActionAnchor` / `chatAnchorTransform` / `alignChatActionRows` / `isLayoutRelevant` / `installChatActionAligner`）：chips 内联进「时间·复制」行的几何引擎（0.4.36 方案 + 0.4.37 编辑态清位移）；observer 只对相关 mutation 调度重测（见 `isLayoutRelevant` 注释）。
- 设计 token 用 dsh web 主题的 `--dsw-alias-*`（label-primary/secondary/tertiary、interactive-bg-hover(-solid)、state-error-primary、border-l1/l2/l3、bg-base/elevated/module-platform），不要写死色值。

## 3. 历史边界：dsh-better-display（已卸载）

better-display 已于 2026-09-14 从 web profile 卸载（用户不要独立阅读 tab），其阅读页随插件一起消失。**0.4.38 起本仓库的阅读页 DOM 注入器已整体删除**（`readerChatInfo` / `mountReaderChipRow` / `scanReaderClusters` / `[data-reader-anchor]` 锚点契约不复存在）——撤回操作 UI 现在只有对话页一个宿主。

- `.dsh-rt-*` 全套类只服务对话页组件（`UserActionsRow` 的 chips/编辑器、`ReferenceRow` 引用块、marker、时间线/分叉视图）。
- 若将来重新引入「阅读/渲染」宿主，chips 挂载请走官方槽位或重建注入器；已删实现可在 git 历史（≤0.4.37）里查。

## 4. 部署闭环（注意 profile 钉了 commit）

**当前版本**：v0.4.38。profile（`C:/Users/daha/.dsh/profiles/web/package.json`）里钉的是
`"dsh-retrace": "github:daha1216/dsh-retrace#<commit>"`（hash 随部署更新，以 profile 实况为准）。

**改完视觉样式后的最小验证闭环**（每步都别跳，缺一步就可能在旧代码上白验）：

```sh
# 1) 双文件同步改完，各自过语法
node --check lib/client.js && node --check lib/client.bundle.js
# 2) 布局 E2E（需要本机 dsh web 跑着；脚本把本地 bundle splice 进页面模块，不动线上）
#    断言：chips 内联且右缘贴列缘 / 编辑器不遮时间·复制行（0.4.37 回归项）/ 取消后回 park
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
- 撤回是重操作：E2E 请在一次性测试会话里做，完事删除会话。
