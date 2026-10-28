<div align="center">

# 🧭 dsh-retrace

**撤回 · 编辑重发 · 重新生成**，加上**写安全**的会话版本化 —— DeepSeek Harness 的
**Agent 业务层（生产级保证）** 实现。

[![Version](https://img.shields.io/badge/version-0.4.79-blue)](https://github.com/daha1216/dsh-retrace/commits/main)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/daha1216/dsh-retrace/blob/main/LICENSE)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4A90D9)](https://github.com/topics/dsh-plugin)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](https://github.com/daha1216/dsh-retrace/pulls)

**简体中文** · [English](./README.md)

</div>

> 本仓库是 [yamingmou/dsh-retrace](https://github.com/yamingmou/dsh-retrace) 的个人兼容修复
> Fork（维护者 daha1216），当前版本 **0.4.79**。0.4.50–0.4.70 的数据安全、体验与深色模式修复见下方
> 「更新记录」；安装请从本 Fork 的 GitHub 直装（详见安装章节）。

**撤回 / 编辑重发 / 重新生成** —— 每个会话都该有的三个操作。但回退不只是「撤掉一条
消息」：DeepSeek Harness 把对话存在 append-only 事件日志里，撤回只回退上下文，改过的
**产物文件不会自动还原**。dsh-retrace 把对话**和它的产物**一起版本化，并且保证
**每次回退都合法、不弄脏日志、不破坏 /compact**。

> 🛡️ **写安全** · 🔍 **深层体检** · 🔄 **检测→修复→守护** —— 详见下方「生产级保证」。

---

## ⚡ 一分钟安装

> 需要带 `dsh` CLI 的 DeepSeek Harness；装完**重启 DSH** 生效（运行中的应用不会热加载）。

```sh
# 推荐：从本 Fork 的 GitHub 直装（含 0.4.50–0.4.79 修复）
dsh plugin --profile desktop add github:daha1216/dsh-retrace   # DSH 桌面版
# 或 Web 部署：dsh plugin --profile web add github:daha1216/dsh-retrace
# 或从 ZIP 解压后：dsh plugin --profile desktop add ~/plugins/dsh-retrace
```

> 本 Fork 未以独立包名发布到 npm —— `add dsh-retrace` 会装到上游版本，**不含**这里的修复。
> 若环境变量中没有全局 `dsh`，命令前加 `npx --yes -p @deepseek-ai/dsh`。

重启后，悬停任意助手回复 → **↩ / ↻**；任意用户消息 → **✎**。详细步骤见
[📦 安装](#-安装)。

---

## 🛡️ 生产级保证（0.4.54 全部已上线）

| | 能力 | 说明 |
|---|---|---|
| 🛡️ | **写安全** | 每次回退过三层写前契约校验；运行中的 agent 自动停止（官方 `cancel`/`whenIdle`）；轮次间 marker 用临时 step 包裹 —— **回退永不弄脏日志，/compact 永不失效** |
| 🔍 | **深层体检** | 配套 `dsh-log-contract` 30+ 条契约规则（token-meter 配对 / 跨 step 引用 / 物理序 / inbox 重放），用真实损坏会话当测试集 —— 能找出让 /compact 永久失效的那类问题 |
| 🔄 | **检测→修复→守护** | 看门狗（**默认关闭**，设 `DSH_RETRACE_WATCHDOG=1` 开启）在并发写入第一时间快照日志；离线 `fix` 原地中和问题 marker、裁剪跨 step 引用；写前校验在坏事件落盘前拦住 |

---

## ✨ 功能

| 操作 | 入口 | 效果 |
| --- | --- | --- |
| **↩ 撤回** | 悬停任意助手回复；或用户消息下方的操作行 | **移除整轮对话**（该条输入及其对应的输出、工具行一并消失），从模型上下文与对话视图中同步清除，并把输入原文**回显到输入框**方便立即修改后重发；一条短暂提示标记回退点，你继续输入后自动消失。 |
| **✎ 编辑重发** | 用户消息下方的操作行 | 回退该条输入及其回复并重发修改后的文本。默认**只替换被编辑那一轮**（更早的历史保持可见）；可在设置中开启「从新对话开始」让对话从新消息重新开始（此时此前的消息不再进入上下文，视图中也默认保持可见、仅显示标记提示）。新消息下方有一个折叠的「原提问」对照，点击展开、可配置关闭。 |
| **↻ 重新生成** | 悬停任意助手回复 | 回退并隐藏该回复及其后内容，重新发送原提问，让智能体重新作答。 |

**版本化与回退（0.4.54 已上线）** —— 每次回退都会被记录为一个**版本**：

| | 能力 | 说明 |
|---|---|---|
| 🕘 | **时间线** | 「版本」Tab（与官方「对话/轨迹」平级）：每个版本的类型/时间/消息数/文件变更徽标，经 `session/projection` 推送帧实时更新（零轮询），大列表窗口化 |
| ↩️ | **产物回退** | 仅对话 / 仅产物 / 两者，先干跑预览再执行；边界已提交时用 git，否则用内容寻址快照；回退本身是新版本（`restore`），可以再回退 |
| 🧭 | **跳转对话** | 从时间线一键跳转到对应位置（自动翻页加载更早历史 + 锚点高亮） |
| 🧹 | **存储有界** | 快照只保留最近 N 个版本（默认 50，可在设置里 1–1000 调整）；后台扫掠串行回收被截断版本，10 分钟内新写入的对象不参与回收，进程重启也不会误删其它会话的快照 |

**为什么与众不同**（交互层差异——上面的保证是存储层）：

- 🎯 **整轮撤回** —— 一键移除输入 *和* 它的输出（含工具行），而不只是单条气泡。
- 🖥️ **Web + Desktop 双端** —— 同一插件覆盖 DeepSeek Harness 两种界面。
- 🧠 **视图 ⇄ 上下文同步** —— 对话视图永远反映智能体真正看到的内容。
- ⚡ **30 秒上手** —— 动态插件形式无需重建即可在当前会话试用。

---

## 📦 安装

### 1. Profile bundle（推荐）

包声明了 `dsh.bundle` 清单，可通过官方插件路径安装到任意 profile：

```sh
dsh plugin --profile <name> add github:daha1216/dsh-retrace
```

> 注意：`add dsh-retrace`（不带 GitHub 前缀）会从 npm 装到**上游版本**，不包含本 Fork
> 的 0.4.50–0.4.79 修复。请始终用上面的 GitHub 形式安装。

> ⚠️ **安装后需要重启。** 安装会写入新文件并重新生成 profile 组合，但运行中的应用
> **不会**热加载 bundle —— 请**退出并重新打开 DSH Desktop**（独立 Web 部署则重启
> `dsh` 进程）来加载插件。卸载：`dsh plugin --profile <name> remove
> dsh-retrace`（卸载后同样需要重启）。

### 2. 手动安装（不依赖 `dsh` CLI）

用纯文件编辑 + `pnpm` 装进同一个 profile —— 也就是 `dsh plugin add` 帮你做的那些步骤：

> **从 GitHub 下载了 ZIP？** 解压到固定位置（如 `~/plugins/dsh-retrace`），
> 然后执行 `dsh plugin --profile desktop add ~/plugins/dsh-retrace`；或按下面步骤，
> 把依赖行指向该文件夹：`"dsh-retrace": "file:~/plugins/dsh-retrace"`。

1. 打开 profile 清单（默认位置：DSH Desktop 为 `~/.dsh/profiles/desktop`，
   独立 Web 为 `~/.dsh/profiles/web`），同时加入依赖**和** bundle 层条目：

   ```json
   {
     "dependencies": {
       "dsh-retrace": "github:daha1216/dsh-retrace"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "dsh-retrace"
         ]
       }
     }
   }
   ```

   （保留 profile 原有条目，只需新增 `dsh-retrace` 这两处。）

2. 在 profile 目录里安装：

   ```sh
   cd ~/.dsh/profiles/<name> && pnpm install
   ```

3. 重启 DSH Desktop / `dsh` 进程（见上文）。

本地开发时，可以把依赖指向本地检出目录而不是注册表：
`"dsh-retrace": "file:/路径/to/dsh-retrace"` —— 或者交给 `dsh`：
`dsh plugin --profile <name> add /路径/to/dsh-retrace`。

### 3. 组合文件（cordis.yml，经典方式）

本 Fork 未发布到 npm registry，所以不能 `npm i dsh-retrace`。若你已有 `dsh` CLI
装好的 profile（见方式 1），组合文件里加一行普通插件条目即可：

```yaml
- name: 'dsh-retrace'
```

Client 半区会依据包内 `dsh.client` 元数据被自动打包进 Web 客户端（组合变化时会自动
重建客户端模块）；Host 半区为浏览器 UI 注册同源 HTTP 路由 `/api/plugins/retrace/*`。

### 4. 动态插件入口（已在 0.4.66 移除）

0.4.66 之前包内附带 `lib/dynamic-host.js` / `lib/dynamic-client.js` 两个自包含入口，供「插件编辑
界面里新建动态插件」使用。它们停在 0.4.43，不包含此后所有安全修复（单次点击撤回、无请求闸、
无票据校验），继续分发等于提供一个已知不安全的旁路。

这两个文件与对应的 `exports` 条目已在 0.4.66 删除。请用上面的 bundle 形式安装；如果你确实需要
动态入口，应当先补一个把 `lib/index.js` + `lib/client.js` 变换成无 import 单文件的生成器，并用
同一套隔离测试验证两半行为一致，而不是手工维护生成物。

---

## ⚙️ 设置 → 撤回

| 设置项 | 默认 | 说明 |
| --- | --- | --- |
| **编辑后显示原提问对照** | 开 | 重发消息下方的折叠「原输入」引用，显示**最近一次**被替换的原文（仅作对照，不会进入模型上下文）。 |
| **编辑后从新对话开始** | 关 | 编辑后连此前的消息也一并隐藏，让对话看起来像从新消息重新开始（重发前回退整个表面）。默认关：只替换被编辑那一轮的上下文。 |
| **按标记隐藏被编辑/撤回的消息** | 开 | 开（默认）：撤回/编辑/重新生成按标记隐藏被替换的那一轮消息。关：所有消息保持可见，标记仅显示提示与对照（查看完整历史用）。单个 marker 要隐藏超过 40% 的对话时自动降级为不隐藏（历史永不静默消失）。 |
| **版本与产物快照** | 开 | 开：每次撤回/编辑记录一个版本（消息与触碰文件），提供时间线与产物回退；关：仅回退上下文，不记录版本、不追踪产物（最省资源）。 |
| **启用 git 集成** | 开 | 开：工作区是 git 仓库时用 git 记录与回退（不自动提交、不动你的分支）；非仓库可在时间线里一键启用 —— 只新增缺失的 `.gitignore`、一个空基线提交和插件自有 ref `refs/dsh/versions`，删掉该 ref 即可还原插件前的 git 状态。关：一律用内置快照（存于 `~/.dsh/dsh-retrace`），不触碰工作区 git 状态。 |
| **版本保留上限** | 50 | 文件快照只保留最近 N 个版本（1–1000），超出自动清理最旧的；时间线记录（最多 200 条）与审计痕迹始终保留。 |

---

## 🔄 更新记录（0.4.50 → 0.4.79）

- **0.4.79** —— 对抗式审计加固：请求闸门现在同时校验 socket 对端（伪造 `Host` 头不再能打开仅限环回的只读路由），剥离调用方自带的 span，5xx 内部信息脱敏，会话 ID / 产物 sha / 模型推导路径全部校验并限长，快照读取加上限；undo 与 restore 重新校验工作区 realpath 与文件版本，git 回退对「窗口内新建 / 脏工作树捕获」的文件回退到内容快照；折叠 marker 补上缺失的「展开」控件，`git/init` 写入操作日志，损坏的 `capture-epoch.json` 改从文件 mtime 恢复而不是前移 epoch（前移会让所有已有快照失效）。
- **0.4.78** —— 合并了两份外部贡献的修复，并补齐 `DSH_HOME` 的路径处理：`regenerate` 在窗口化日志下改用 `eventAt` 取行（原来按裸下标取到相邻行，会把别人的文本当 prompt 重发）；`capture-epoch.json` 改为原子写、截断的 marker 用正则抢救而不是把 epoch 前移（前移会让所有已有快照静默失效）；中断守卫改为按 turn 号记账（「崩溃→恢复→再崩溃」原来一条都不报），并改读宿主的 `snapshotEvents()`（原来读 `session.events`，在真实会话上恒为空）；会话文件查找改为跟随 `DSH_HOME`。
- **0.4.77** —— 旧短码前缀改为「会话一加载就清理」，不再只依赖启动时的一次扫描，启动之后才打开的会话也能覆盖。
- **0.4.76** —— 启动之后才打开的会话也会被清理旧短码前缀：插件的每次请求都会上报它触碰的会话，清理对每个会话只跑一次。
- **0.4.75** —— 标题清理的正则改成大小写不敏感：短码是 `dd833FF000` 这种大小写混合，原来只匹配小写，实际摘不掉。
- **0.4.74** —— 短码回到只做展示：任何操作都不再改写会话标题；旧版本加过 `[短码]` 前缀的标题会在启动时摘掉前缀，还原成你自己写的名字。
- **0.4.73** —— 撤销提示不再夸大自己的能力：如果这次回退同时改动了对话，提示会说明对话部分无法撤销，按钮也改成「撤销产物回退」。
- **0.4.72** —— 回退产物现在留一次撤销：写入前先捕获被覆盖的字节，时间线顶部出现「撤销回退」，
  30 分钟内可用一次，用完即焚。同时把「撤回」的真实语义写进 chips 的提示与二次确认（隐藏这条消息
  及其之后的全部内容），时间线行改用相对时间，版本号与精确时刻收进 tooltip。
- **0.4.71** —— 每条引用单独记录自己的捕获时刻。内容去重会复用很久以前存下的相同字节，
  以前这种情况会让新边界被当成「无法证明属于该边界」而在回退时被拒；现在只看该引用
  自己的捕获时刻。0.4.71 之前写入的行没有这个字段，回退到原来的边界时刻列，所以那些
  先于捕获纪元（epoch）的旧引用仍然标为 racy。
- **0.4.70** —— 产物库在启动时自愈：既丢了引用、磁盘上也没有对象的元数据行
  （0.4.50 之前那版 GC 的残留，在发现问题的机器上有 608 行）会通过 storageDomain
  删除，内存表与 JSON 文件保持一致；0.4.58 之前的 legacy 引用一律不改写，只用
  `legacy-frozen.json` 侧车文件记录一次「为什么它们不能被归属」。不需要手动跑 CLI，
  也不需要停机窗口。
- **0.4.69** —— 边界捕获只记录插件启动之后产生的边界。投影在会话加载时会把整段历史
  重放一遍，重放中的每个边界以前都会触发一次快照，把**当前**工作区的内容当作那个边界
  的字节存进去。现在重放历史直接跳过，迟到捕获标记为 racy，而首次运行 0.4.69 之前
  记录的所有快照在回退时一律按 racy 拒绝（`capture-epoch.json` 记录分界），不删除。
- **0.4.68** —— `retrace store migrate` 把 legacy 时代显式冻结。0.4.58 之前的引用没有
  会话 id，对应的 `versiongit` 行也没有，任何「按时间/路径猜归属」都会把 A 会话的快照
  算到 B 会话头上；这个命令只把这件事写进 `legacy-frozen.json`，并删掉「对象已经不在」
  的零引用行。它绝不重写引用、绝不删 blob。请在宿主停止时运行——运行中的进程把 domain
  文件持有在内存里。
- **0.4.67** —— 边界快照与自动清理重新打开。每个版本边界会抓取该边界触碰过的文件
  （单文件上限 4 MB，按内容去重）并记录 git HEAD/dirty，时间线因此能看到到底改了什么。
  释放引用、删除无引用对象的清理也恢复运行，保留 0.4.59 的 10 分钟宽限期与在途快照保护。
  产物回退仍关闭——它是唯一会写用户文件的路径，应当先在真实捕获历史上验证。
- **0.4.66** —— 移除动态插件入口。`lib/dynamic-client.js` 与 `lib/dynamic-host.js` 停在 0.4.43，
  走那条路的用户会得到单次点击撤回、没有请求闸、没有回退票据的旧行为。文件与 `exports` 条目
  一并删除，请用 bundle 形式安装。
- **0.4.65** —— 产物库可以离线盘点和清理。`retrace store inventory` 把每个对象
  分成在用、legacy（0.4.58 前写入、没有会话前缀的引用）、悬空、孤儿四类；
  `retrace store gc` 默认只预演，要 `--apply --yes` 才删除，且只删「没有任何引用」
  的对象——legacy 引用指向的对象一律保留，因为归属无法恢复。该命令不需要宿主，
  也不依赖会话日志库。
- **0.4.64** —— bundle 重新可生成。`node scripts/build-client.mjs` 用确定性变换从
  `client.js` 重建 `lib/client.bundle.js`（react 走 require、内联 `badge.js`、映射导出），
  两个文件不会再各改一份而漏同步；`node scripts/check-syntax.mjs` 一次跑完语法、
  版本号一致性与 bundle 同步检查，package.json 的 `build` / `check` 也指向真实存在的脚本。
- **0.4.63** —— 回退弹层现在真的是「弹层」：带 `role="dialog"` 与 `aria-modal`，
  打开时焦点落到「取消」、关闭后还给原元素，Escape 可取消（回退执行中除外）。
  撤回回显的图片绑定到发起它的那份草稿：回显文本已经发出去时不再挂载，避免
  附件跑到下一条消息上。
- **0.4.62** —— 隐藏计划重新变回线性。以前每个撤回标记都要重扫一遍节点表才能算出
  它遮蔽了哪些行，2000 行 / 200 个标记的会话每次快照要 444 400 次节点访问；现在共用
  一份 seq 索引，同样场景降到 6 600 次（实测少 34–67 倍）。跳转到某个版本的锚点时
  改为读取当前宿主的快照结构并用 `loadThrough` 直接定位，不再按 50 行一页地翻——
  旧的 `snapshot.chat.nodes` 取法会让每次跳转都在翻页预算耗尽后静默放弃。
- **0.4.61** —— 插件接口只允许本机界面调用。请求必须来自环回主机（隧道/局域网地址需
  显式设置 `DSH_RETRACE_ALLOW_REMOTE=1`），所有写操作必须带 `x-retrace-client`
  头（其他页面要带自定义头就得先过预检，而预检会被拒绝），`git/init` 需要显式确认
  参数，且在拿不到会话沙箱策略时直接失败而不是降级写入。只读 GET 仍不需要凭据，
  它们不暴露工作区之外的文件内容。
- **0.4.60** —— 回退变成带票据的两步操作。预览会返回一次性 `planId`，绑定会话、
  版本、范围与当前 revision；执行时缺票据直接拒绝（`plan-required`），重复使用被拒
  （`plan-used`），预览之后又出现新边界则判为过期（`plan-stale`）。如果上下文回退需要
  恢复当前会话已不再显示的消息，直接拒绝（`restore-unsupported`），而不是写一个根本
  复现不出目标表面的标记。每次执行都会向 `~/.dsh/dsh-retrace/operations.jsonl` 追加
  一行审计（只记 ID、范围与逐文件状态，绝不记消息正文或文件内容）；产物回退按工作区
  串行，两个会话不会同时改同一批文件。
- **0.4.59** —— 快照写入事务化。同一内容地址的引用写入按 sha 串行（此前两个内容
  相同的文件并发快照会丢掉其中一个引用），引用写入失败时把刚发布的对象删掉而不是留成
  孤儿；清理会等待在途快照，不会再删掉别的会话刚发布的 blob。边界捕获若无法证明属于
  该版本（更新的边界先动过同一路径），会被标记为 racy，回退时拒绝使用，而不是用更新的
  内容覆盖旧状态。
- **0.4.58** —— 产物存储按会话分区。快照引用与 git 事实改为
  `<会话ID>|<版本ID>|<路径>` 键：此前两个会话都走到第 10 轮时会写出同一个键，审计
  实测一个会话的回退能取到另一个会话的字节、git 事实也会互相覆盖。本版之前写入的
  行没有会话 ID，按“无法归属”处理——GC 永不释放、按会话查询永不命中，因为归属
  无法可靠恢复。清理时只释放本次清理会话自己截断掉的版本。新增
  `GET /api/plugins/retrace/storage` 只读报告存储现状（对象数、引用数、遗留行、
  孤儿对象），不做任何删除。
- **0.4.57** —— 宿主契约统一。所有读取方改为走同一层归一
  （`lib/adapter/normalize.js`）：同时认识两代 marker（旧 `data.message.id`、现行顶层
  `data.id`），事件行改用能识别 `baseSeq` 的查找而不是 `events[seq]`，并把宿主自己的
  surface fold 作为唯一判据。由此修掉：本版写出的撤回/折叠/回退 marker 现在能被插件
  自己的读取方识别（此前 marker 格式变更后写出的折叠，`unfold` 全部看不见，回退也会
  拒绝自己的 marker）；日志是窗口（分叉或压缩后）的会话在计算区间时不再取错事件行；
  `waterLevel` 与轮次/区间边界辅助共用同一套信封处理。启动时会探测运行中的宿主是否
  提供 `Session.prototype.snapshotEvents`，契约不明则进入只读模式（写操作返回
  `capability-disabled`，HTTP 503），并通过 `GET /api/plugins/retrace/capabilities` 如实
  上报，而不是猜测兼容。
- **0.4.56** —— 安全止损：产物回退与自动 GC 默认关闭。审计确认边界期快照、快照回写与
  自动清理在当前宿主契约下无法证明安全，因此本版把它们做成宿主侧能力门控
  （`lib/capabilities.js`）。0.4.67 打开了两个只读的：`artifactCapture`（边界快照与 git 事实，
  不写工作区）和 `artifactGc`（只删没有任何引用的对象）；`contextRestore` 与
  `artifactRestore` 仍关。被关的操作
  统一返回 `capability-disabled`（HTTP 503），客户端时间线因此不再展示产物回退按钮；
  `GET /api/plugins/retrace/capabilities` 暴露当前门控，运维可用
  `DSH_RETRACE_CAPABILITIES='{"artifactGc":true}'` 单项打开。同时修掉三个客户端问题：
  浏览时间线/分叉图不再写入会话标题（此前会把人工标题改写成短码前缀），预览未加载完成
  时确认按钮禁用、工作区脏只拦产物类回退而不拦纯对话回退，回退部分失败或持久化告警时
  弹层保持打开并列出失败文件。
- **0.4.55** —— 深色模式视觉修复。多个令牌语义用错或根本不存在，导致深色下撤回编辑器、
  标记胶囊、引用块与设置页开关失真：`--dsw-alias-bg-elevated`、`--dsw-alias-fill-l2`、
  `--dsw-alias-state-warning-primary`、`--dsw-alias-state-info-primary`、
  `--dsw-alias-state-success-bg`、`--dsw-font-mono` 均未在 DSH 定义，已分别换为
  `--dsw-alias-bg-layer-3` / `--dsw-alias-interactive-bg-hover` /
  `--dsw-alias-state-warn-primary` / `--dsw-alias-state-business-primary` /
  `--dsw-alias-state-success-tertiary` / `--ds-font-family-code`；橙色「发送」按钮的
  白字在橙底上对比度仅 2.26:1，改为深色字 `#20160b`（7.86:1），复用它样式的错误确认按钮
  单独恢复前景色；设置页开关按宿主令牌配对重写（未选中 `border-l3` + `switch-thumb`，
  选中 `button-primary-fill` + `label-primary-foreground`），深色下旋钮对比度由约 2:1
  提升到 18:1；多处 `rgba(0,0,0,…)` 硬编码阴影改 `--dsw-shadow-lv1` / `--dsw-shadow-lv2`。
  橙色系配色是插件自身的设计语言，保持不变。
- **0.4.54** —— `git init` 现在把调用会话的沙箱策略传给文件写入，修复 `workspace-write`
  模式下写 `.gitignore` 被拒（`file access denied`）。
- **0.4.53** —— 修复 `git init` 把字符串路径当成 fs target 传入导致的 TypeError；
  `.gitignore` 的 create-if-absent 路径加固。
- **0.4.52** —— 设置改为合并写并跨标签页同步；HTTP 错误返回真实状态码
  （400/403/404/409/413/503）；清理死代码路径。
- **0.4.51** —— span 失败区分 `log-unavailable` / `target-shadowed`；flush 失败以警告
  上报而不是静默吞掉；会话日志按 size+mtime 缓存，不再每次操作重复全量解压；客户端
  hook 改为索引查找（消除逐行 O(N²)）；切换会话不再串台。
- **0.4.50** —— 修复跨会话 GC 误删其它会话快照；快照与 GC 串行化并加 10 分钟宽限；
  `retentionLimit` 真正生效；产物回退改用版本边界的 HEAD，工作区有未提交改动时拒绝
  覆盖；支持 `session.vN.jsonl.zstd` 日志文件名；插件 HTTP 路由同源校验 + 仅接受
  JSON + 反射 CORS；短码/标题/水位操作补齐 HTTP 路由；共享每会话锁；`ensureIdle`
  15 秒超时；助手撤回两步确认、草稿保护、IME 守卫等体验修复。

---

## 🧠 工作原理

```
 持久化日志（只追加）                          模型上下文与视图
 ┌────────────────────────────────┐      ┌────────────────────┐
 │  … 目标消息                    │      │  … 目标消息        │
 │      ↓ 阴影区间                │      │       ↓ 回退       │
 │  [目标 … 最后一个表面节点]     │ ──▶  │  (空 replace       │
 │      ↳ 追加一条替换型          │      │   = 上下文截断)    │
 │        assistant/message（空） │                           agent.followup(新提示)
 │      ↳ 可选「原提问」对照      │                           → 下一轮基于回退后的历史重建请求
 └────────────────────────────────┘      └────────────────────┘
```

1. **Host 核心**（`lib/host-core.js`，零运行时依赖）：在会话的活跃表面中定位目标
   消息，计算阴影区间 `[消息 … 最后一个表面节点]`，追加一条**空内容**的替换型
   `assistant/message` —— 空助手消息是合法表面节点，但派生不出任何模型消息，
   因此 LLM 上下文直接回退。
2. **编辑 / 重新生成**：额外调用 `agent.followup(...)` 发送（新的）提示文本，
   智能体的下一轮请求基于回退后的 `session.deriveMessages()` 构建。
3. **Client**（`lib/client.js`）注册：
   - 每条用户消息下的 `user-actions` 对话节点（编辑/撤回行 + 内联编辑器）；
     撤回后把原文回显到输入框，
   - `recall-marker` 节点渲染器：提示行 + 注入 CSS 把被阴影化的消息行从对话流中
     隐藏（视图与模型上下文保持同步），并可显示「原提问」对照块，
   - `conversation.chat.assistant-actions` 中的 `retrace` 入口
     （撤回/重新生成），
   - 设置 → 撤回 中的偏好开关与版本保留上限。

4. **HTTP 半区**（`lib/http.js`）：浏览器只走同源 `/api/plugins/retrace/*` —— 跨源请求
   返回 403，POST 仅接受 `application/json`，错误按 400/403/404/409/413/503 返回；会话
   日志解析支持 `session.vN.jsonl.zstd` 这类新文件名。

> 这里有两个不同层面：**持久化日志**（只追加；旧事件从不被改写或删除）与
> **模型可见表面**（由追加的替换事件回退）。因此旧事件作为审计痕迹留在记录中——
> 但它们会被**同步地从模型上下文和可见对话中清除**，界面始终反映智能体真正看到的内容。
> 因为插件只追加合法、带类型的会话事件，持久化、投影与记录保持一致。

---

## ⚠️ 要求与限制

- 只有**用户消息**可以编辑；撤回同时适用于用户与助手消息。工具结果会随区间一并
  被阴影化，但不能单独作为撤回目标。
- 智能体必须**空闲**：回复流式输出时会先自动停止并等待（上限 15 秒，
  `agent-stop-timeout`）；若无法停止则返回 `agent-busy`。
- 撤回/编辑作用于**活跃模型表面**：已被压缩或此前已撤回的消息会被拒绝
  （`target-shadowed`）；会话日志不可读、内存事件稀疏时返回 `log-unavailable`。
- 回复停止有 15 秒上限：超时返回 `agent-stop-timeout`，请等回复结束后重试。
- **产物回退要求工作区干净**：有未提交改动时返回 `working-tree-dirty`，请先提交或丢弃，
  避免 `git checkout` 覆盖你未保存的修改。
- 重新生成只重发原提示的**文本**部分；携带图片的提示会退化为仅文本重发。

---

## 🗺️ 路线图

**当前已具备（0.4.79）：**

- 撤回 / 编辑重发 / 重新生成——每次回退都过**三层写前校验**与安全编辑路径（自动停 agent、临时 step 包裹 marker），**不会损坏日志、不会破坏 /compact**。
- 单会话**版本时间线** + **产物回退**（git/快照按边界事实择一、干跑预览、跳转对话、dirty 工作区拒绝覆盖）。
- 对话视图内的**分叉图** + **会话谱系**。
- **看门狗**（默认关闭，`DSH_RETRACE_WATCHDOG=1` 开启）——并发写入第一时间快照日志。
- 配套 **`dsh-log-contract`**：30+ 条离线契约规则 + 原地修复（`fix --neutralize` / `--clip-crossstep`），能处理会让 /compact 永久失败的会话。

**未来计划**：agent 业务层规划（运行时守护、中断治理、生态开放接口）随上游推进；本 README 只描述本仓库已上线的能力。

---

## 🛠️ 开发

本仓库只发布源码，**不包含**私有构建工具链：

```
lib/host-core.js       # 传输无关的 Host 逻辑
lib/index.js           # 发布版 Host：服务装配 + HTTP 路由
lib/client.js          # Client 源码（可读，React）
lib/client.bundle.js   # 运行时入口（自注册 loader），与 client.js 同步维护
lib/http.js            # HTTP 半区（同源、仅 JSON、状态码化错误）
lib/versioning.js      # 快照、GC、git 事实记录
lib/rollback.js        # 对话/产物回退执行器
lib/artifact-store.js  # 内容寻址存储（~/.dsh/dsh-retrace/objects）
lib/git-adapter.js     # git status / checkout / init（走 subprocess seam）
lib/adapter/           # DSH 会话日志适配器 + marker 写入器
scripts/e2e-layout.cjs # 布局 E2E（需外部安装 playwright）
cordis.patch.yml       # dsh.bundle profile patch 层
```

- `scripts/build-client.mjs`、`scripts/check-syntax.mjs` 与 `test/` **在**本仓库中，
  直接用 `node` 运行（没有 `node_modules`，勿执行 `pnpm install` / `pnpm build`）；
  CI workflow 不在本仓库。
- 修改客户端必须同时改 `lib/client.js` 与 `lib/client.bundle.js`，两者都要通过
  `node --check`。
- 语法检查：`node scripts/check-syntax.mjs`（全部 `lib/**/*.js` 逐个 `node --check`，不再有例外）。

欢迎提交 PR 与 issue —— 见[问题追踪](https://github.com/daha1216/dsh-retrace/issues)。

---

## 📚 生态

收录于 [dsh-plugin topic](https://github.com/topics/dsh-plugin)。

**Agent 业务层（生产级保证）** 的一部分——框架无关的业务层定义由上游维护，dsh-retrace
是它在 DeepSeek Harness 上的实现。配套组件：

- [**dsh-log-contract**](https://github.com/yamingmou/dsh-log-contract) —— 业务层的
  「医生」：30+ 条离线契约规则 + 原地修复（`fix --neutralize` / `--clip-crossstep`）。
  作为依赖自动安装，也独立发布供直接使用。

> **直接从 GitHub 安装**（无需 npm registry —— 适合把本仓库链接丢给 AI，或想装最新提交）：
>
> ```sh
> dsh plugin --profile desktop add github:daha1216/dsh-retrace
> # 或直接用 pnpm 装进 profile：
> cd ~/.dsh/profiles/desktop && pnpm add github:daha1216/dsh-retrace
> ```
>
> 然后照常重启 DSH Desktop。`dsh-log-contract` 依赖会自动带上。

DeepSeek Harness 插件生态的精选总览见
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
（第三方收录，使用前请自行确认可用性）。

---

## 👥 团队

由 [OfferKuai](https://www.offerkuai.com) 团队开发——一款 AI 求职助手，使命是
「用户要的是结果，而不是反复的对话」。创始人：Zhaofeng（Yaming）。本插件以开源
形式发布，回馈 DeepSeek Harness 社区。

本仓库为 [daha1216](https://github.com/daha1216) 维护的兼容修复 Fork：上游能力照旧，
额外包含 0.4.50–0.4.55 的数据安全、体验与深色模式修复（见「更新记录」）。

## 📄 License

MIT

---

## 🧭 会话日志考古（retrace CLI）

DSH 会话日志持久化了每次工具调用的完整输入输出——数据资产与审计资产。
`retrace` CLI 提供只读考古能力（复用 dsh-log-contract 的契约与提取）：

```sh
retrace index <session>                        # 工具调用索引（A1）
retrace query <session> --cmd "seed-scale"     # 按命令正则查输出（A1）
retrace extract <session> --pattern "seed-scale" --out ./found   # 导出输出（A2）
retrace file-history <session> <path>          # 文件 write/edit 历史版本（A3）
retrace file-diff <session> <path> 0 5         # 两版本行级 diff（A3）
retrace lineage <session>                      # 会话 parent 链谱系（A4）
```

<session> 为完整日志路径或 sessionId（自动在 ~/.dsh/sessions 查找）。全部只读。

**分叉图里的会话谱系（A4, UI）**：Fork map 视图头部展示当前会话的
`parentSession` 接续链（当前会话 → 父 → 根,`←` 方向）。数据来自
`GET /api/plugins/retrace/lineage?sessionId=`（只读 header 遍历,带环保护）,
与 CLI `retrace lineage` 同一语义。这样「这个会话是从哪个会话接着干/分叉出来的」
在界面上一眼可见——也是分叉图拓扑的元数据源。
