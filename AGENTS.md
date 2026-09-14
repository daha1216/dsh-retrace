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

- **全局 CSS**：`const CSS = '...'` 模板串（搜 `.dsh-rt-user-row{` 定位，client.js ~1103 行起），运行时注入 `<style data-plugin-css="dsh-retrace-css">`。所有 `.dsh-rt-*` 类：chips（`-chip`/`-chip-danger`）、用户操作行（`-user-row`/`-user-actions`）、编辑器（`-editor`/`-textarea`/`-editor-buttons`/`-editor-send`/`-editor-cancel`）、报错（`-error`）、时间线/分叉 tab、marker 等。**同一字符串在 bundle 里还有一份，必须同步改**。
- **组件**（createElement 写法，两文件平行镜像）：编辑/撤回 chips ~874/947（bundle ~695/759）、撤回 marker、retrace-reference 原文引用块、assistant-actions、轨迹/版本/分叉视图。
- 设计 token 用 dsh web 主题的 `--dsw-alias-*`（label-primary/secondary/tertiary、interactive-bg-hover(-solid)、state-error-primary、border-l1/l2/l3、bg-base/elevated/module-platform），不要写死色值。

## 3. 与 dsh-better-display 的边界（重要）

- **阅读 tab**（better-display 渲染）里的 编辑/撤回 按钮用的是 better-display 自己的 `.retraceChip` ghost 类，**改本仓库的 `.dsh-rt-chip` 只影响对话 tab**。
- 但阅读 tab 的**编辑器和报错**复用本仓库的全局类 `.dsh-rt-editor` / `.dsh-rt-error` —— 改这两个类两边都会变。
- 想两个视图风格统一（比如对话页胶囊改成阅读页的 ghost 风），要么同时改两个仓库，要么改完本仓库后去 better-display 对齐。

## 4. 部署闭环（注意 profile 钉了 commit）

```sh
# 1) bump package.json version；node --check 两个 lib 文件
# 2) commit + push origin main
# 3) profile 里是 "dsh-retrace": "github:daha1216/dsh-retrace#b9b6b6a" ——
#    钉死的 spec 用 update 不会前进，必须重新 add 指到新 commit：
powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/daha/.dsh/stop-dsh-web.ps1
cd C:/Users/daha/.dsh && HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 dsh plugin --profile web add github:daha1216/dsh-retrace#<新hash>
powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/daha/.dsh/launch-deepseek-harness.ps1 -NoOpen
# 4) 刷新浏览器页面（插件 bundle 走 rev 缓存），在「对话」tab 验证 chips 视觉
```

- E2E 习惯：role 定位器在本应用常超时，用 `tab.playwright.evaluate()` + `dispatchEvent(new MouseEvent("click",{bubbles:true}))`；输入框用 React 原生 value setter + `input` 事件。
- 撤回是重操作：E2E 请在一次性测试会话里做，完事删除会话。
