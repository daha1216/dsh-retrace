<div align="center">

# 🧭 dsh-retrace

**撤回 · 编辑重发 · 重新生成**，加上**写安全**的会话与产物版本化 —— DeepSeek Harness 的会话时光机。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH Compatibility](https://img.shields.io/badge/DSH-0.1.5%2B%20compatible-brightgreen.svg)](#)
[![Single Source](https://img.shields.io/badge/Fork-daha1216%2Fdsh--retrace-blueviolet.svg)](https://github.com/daha1216/dsh-retrace)

**简体中文** · [English](./README.en.md)

</div>

> **本仓库是 [yamingmou/dsh-retrace](https://github.com/yamingmou/dsh-retrace) 的生产级兼容修复 Fork**：
> 核心针对 **DeepSeek Harness 0.1.5-rc.2+ 及更高版本（含 alpha.2 插件服务注册机制）** 进行了深度适配与修复：
> - 🛠️ **修复插件服务注册**：适配 DSH 新版插件运行时上下文与服务注册通道，解决启动时组件挂载失败问题；
> - 🔁 **修复连续/重复撤回（repeated recall）**：解决原版连续回退多轮消息时状态卡死或日志状态不同步的缺陷；
> - ✍️ **内置健壮的 `dsh-writer`**：确保会话回溯写入合法闭环，永不污染 append-only 事件日志，不破坏 `/compact`。

---

## ⚡ 快速安装与更新

> 安装后需**重启 DSH Web Host 并刷新网页**使插件生效。

### 官方 CLI 安装（推荐）

```sh
# Web 端 Profile 安装
dsh plugin --profile web add github:daha1216/dsh-retrace

# 桌面端 Profile 安装
dsh plugin --profile desktop add github:daha1216/dsh-retrace
```

*若环境变量中无全局 `dsh` 命令，在前面添加 `npx --yes -p @deepseek-ai/dsh` 即可。*

### 一键更新

```sh
dsh plugin --profile web add github:daha1216/dsh-retrace
```

---

## 💡 为什么需要 dsh-retrace？

在 DeepSeek Harness 原生架构中，会话以 **append-only（只追加）事件日志** 格式持久化。
通常的「删除单条消息」不仅会导致日志损坏，更重要的是：**代码与产物文件已经被 Agent 修改，光撤掉对话无法回退文件**。

dsh-retrace 将**对话流**与**磁盘文件产物**进行联合版本化追踪，并提供物理级写安全契约保证：
1. **整轮撤回（Recall）**：移除整轮交互（用户提问、思考、工具调用行、助手回复全部收回），同时将原提问回显至输入框，支持立即重提。
2. **编辑重发（Edit & resend）**：随时就地修改历史提问并重新触发分支生成，自带原提问折叠对比。
3. **重新生成（Regenerate）**：一键撤回上一次助手回答，保持提问不变重新调用模型作答。
4. **会话与产物版本时光机**：新增「版本」Tab，记录历次撤回与修改，支持**仅回退会话 / 仅回退产物 / 两者同时回退**（Git 优先 + 内容寻址快照兜底）。

---

## ✨ 核心特性一览

| 操作 | 触发入口 | 执行效果 |
| --- | --- | --- |
| **↩ 撤回** | 悬停任意助手回复，或用户消息下方的操作按钮 | **移除整轮对话**（该轮用户输入、Agent 思考、工具行及最终输出全部撤出上下文与视图），提问原文**回填输入框**，附带轻量回退提示。 |
| **✎ 编辑重发** | 用户消息下方的编辑图标 | 回退当前轮次，允许修改提问内容后重新发送，保留折叠的「原提问」对比卡片。 |
| **↻ 重新生成** | 悬停任意助手回复的刷新图标 | 撤回最近一次模型回复并就地重发原 Prompt，让智能体重新作答。 |
| **🕘 版本时间线** | 会话顶部的「版本」页签 | 直观查看会话演进图谱、文件变更快照，一键跳转到历史指定节点。 |

---

## 🛡️ 生产级写安全保证

- 🛡️ **写前契约校验**：每次回退均经过三层严格检查，正在运行的 Agent 自动通过原生通道终止，防止并发读写撕裂。
- 🧱 **保护 `/compact`**：回退完全遵循 DSH 规范事件流，不会残留孤立事件或产生无效跨步引用，**上下文压缩引擎始终正常运作**。
- 🎨 **深度协同 [dsh-better-display](https://github.com/daha1216/dsh-better-display)**：本插件产生的回溯标记（`recall-marker`）已完美接入 `dsh-better-display` 阅读视图，在极简阅读流中只展示精简提示行，自动隐去非必要交互噪点。

---

## 📄 许可证

本项目基于 [MIT](LICENSE) 开源许可。
原作者项目：[yamingmou/dsh-retrace](https://github.com/yamingmou/dsh-retrace)。
