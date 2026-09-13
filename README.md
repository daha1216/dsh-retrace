# 🧭 dsh-retrace

> DeepSeek Harness 会话时光机（基于 [yamingmou/dsh-retrace](https://github.com/yamingmou/dsh-retrace) 的兼容修复 Fork）。

支持消息撤回（Recall）、编辑重发（Edit & resend）与重新生成（Regenerate），并将对话历史与磁盘产物文件同步版本化。全面适配 DSH 0.1.5+ 插件服务注册机制。

---

## 📦 安装与更新

```sh
# Web 端安装 / 更新
dsh plugin --profile web add github:daha1216/dsh-retrace

# 桌面端安装 / 更新
dsh plugin --profile desktop add github:daha1216/dsh-retrace
```

> 安装或更新后请重启 DSH 并刷新页面。若环境变量中无全局 `dsh`，前面加上 `npx --yes -p @deepseek-ai/dsh`。

---

## ✨ 核心特性

- **整轮撤回（Recall）**：一键撤回当前轮次（含提问、工具调用与回复），提问原文自动回显到输入框。
- **编辑重发（Edit & resend）**：随时就地修改历史提问并重新作答，附带折叠的原提问对照。
- **重新生成（Regenerate）**：保留原提问不变，一键撤回上次回复并让智能体重新作答。
- **会话与产物版本化**：支持独立或同步回滚对话上下文与文件产物，写安全机制保障 `/compact` 永不失效。
- **DSH 0.1.5+ 深度适配**：修复新版插件服务注册机制与连续撤回卡死问题，运行稳定不丢状态。

---

## 📄 许可证

[MIT](LICENSE)
