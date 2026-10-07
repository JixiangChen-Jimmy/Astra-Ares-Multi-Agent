# Astra-Ares Multi-Agent

基于 [Astra-Ares](https://github.com/miuuyy/Astra-Ares) 的独立项目，使用打过原生补丁的 **Codex 0.160.1**。提供两种模式，安装后可以切换，历史记录共用同一个目录。

| 模式               | 行为                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `adaptive`（默认） | Astra-Jev 动态思考强度：初始 medium，最高 high；不启用自动多 agent 路由                              |
| `multi-agent`      | Root 动态调档；核心实现固定 Sol-6.1 high；简单代码／明确执行由 Jev 选择 Sol-6.1 adaptive 或 Luna max |

多 agent 模式下，普通审查为 Astra low，核心审查为 Astra medium，研究为 Sol-6.1 high。子任务开始前选择模型，并等待原生应用确认；中途失败或范围扩大交回 Root 重新分配，不偷偷热换模型。

## 安装和配置

需要 Node.js 22+、npm、多 agent 模式所需的 Python 3，以及你自己的 Codex 模型访问权限和 Jev API key。预编译包实际验证的平台为 Linux x86_64，依赖 glibc 和 OpenSSL 3；其他平台的源码构建要求见[安装说明](docs/installation.md)。

下载并解压原生发布包，进入解压目录：

```sh
npm ci --omit=dev
node bin/ares.mjs setup --binary "$PWD/native/bin/codex" --provider typesafe --mode adaptive
node bin/ares.mjs configure --provider typesafe
npm link
```

输入的是你自己的 TypeSafe Jev key；隐藏输入，不会写进项目。Codex 本身的模型认证独立配置，必要时运行 `astra-ares login`。项目不会提供别人的账户或模型权限。

也可克隆源码后执行 `npm ci`、`npm run setup -- --provider typesafe --mode adaptive`、`npm link`。源码安装需要编译 Rust 原生补丁，耗时显著高于使用兼容的预编译包。详见[构建说明](docs/building.md)。

## 日常使用

只开 Astra 动态调档：

```sh
ares mode adaptive
astra-ares -C /你的项目目录
```

使用多 agent：

```sh
ares mode multi-agent
astra-ares -C /你的项目目录
```

临时切换一次：

```sh
astra-ares --ares-mode multi-agent -C /你的项目目录
```

恢复历史：

```sh
astra-ares -C /你的项目目录 --no-alt-screen resume
```

配置切换影响下次启动，已经运行的进程不会原地改变。两个模式共用历史，不需要分别 export 不同的目录。项目不会默认关闭 Codex 的权限确认；只有你明确需要时才自行添加 `--yolo`。

## Luna 的两种用途

- **Luna low**：可选的语义摘要器，为 Jev 提供压缩后的上下文，不执行任务、不替换主模型历史。
- **Luna max**：多 agent 模式中，执行 Jev 选中的简单代码或明确执行任务。

Jev 的决策最长沿用五次模型生成。模型价格使用带日期的快照作为选择参考，不代表实际账单。超时和失败有有限重试、隔离及短租约保底，日志会区分成功决策与保底。

## 数据和验证边界

Jev 会收到任务、公开进度及工具结果的有限视图；启用摘要时 Luna 也会收到待压缩上下文。压缩不等于匿名化，使用前需确认这些内容允许发给所选服务。仓库及发布包不包含个人 key、聊天历史、私人网关配置或项目数据。

真实模型和原生路由已有集成验证，两个模式另有离线测试；上游 Codex 全工作区测试并非全部通过。断连／网络拒绝后进程清理等已知限制见[验证说明](docs/validation.md)，本项目没有宣称修复这些上游问题。

[English](README.md) · [完整配置](docs/configuration.md) · [排错](docs/troubleshooting.md) · [许可证](LICENSE)
