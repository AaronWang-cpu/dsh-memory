# dsh-memory

**给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的持久记忆，纯文本、可手改。**

[![CI](https://github.com/AaronWang-cpu/dsh-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/AaronWang-cpu/dsh-memory/actions/workflows/ci.yml)

[English](README.md) | 中文

会话一结束，agent 就把你忘光了。`dsh-memory` 给它一个记事本——一个你能读、能改、能删、能备份的 JSONL 文件。

说一次就够：

```
你   › 我一直用 pnpm，别用 npm。还有，以后用中文回答我。
Agent › 已记住。(memory 4f2a91c8)
```

明天开一个全新会话：

```
你   › 这个项目装依赖该用什么？
Agent › pnpm。
```

没有工具调用，不用再解释一遍，也不会出现"正如您之前提到的"——事实从第一个 token 起就在提示里。

---

## 为什么不用 `AGENTS.md`？

`AGENTS.md` 是**项目**约定：静态、共享、提交进仓库、由维护者手写。
记忆是**你**的东西：由 agent 在干活时写下、放在仓库之外、对每个项目都生效。

| | `AGENTS.md` | `dsh-memory` |
|---|---|---|
| 谁写 | 人，手工 | agent，干活时 |
| 范围 | 单个仓库 | 你，全局 |
| 放在哪 | 仓库里（会提交） | `~/.dsh/memory/`（私有） |
| 怎么增长 | 有人去改 | 自动，且自动去重 |
| 预算 | 能放下多少算多少 | 按字节封顶，新的优先 |

两者互补：编码规范写进 `AGENTS.md`，**你本人**写进 memory。

## 安装

```bash
dsh plugin --profile desktop add github:AaronWang-cpu/dsh-memory
```

然后重启 DSH。就这样——没有配置项要填，没有 API Key，不联网，没有后台进程。

<details>
<summary>从本地目录安装</summary>

```bash
dsh plugin --profile desktop add /absolute/path/to/dsh-memory
```

或者手工写进 `~/.dsh/profiles/desktop/package.json`：

```json
{
  "dependencies": { "dsh-memory": "github:AaronWang-cpu/dsh-memory" },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-memory"
      ]
    }
  }
}
```

</details>

## 使用

不用学，正常说话就行。

| 你说 | 会发生什么 |
|---|---|
| "我一直用 pnpm。" | 存成长期偏好 |
| "以后的提交信息都用中文" | 存下来 |
| "预发库是只读的，别往里面写。" | 存成约束，不用再教一次 |
| "我一般偏好什么？" | agent 检索记忆 |
| "把关于 pnpm 的那条忘掉。" | 列出、找到、删除 |

存不存由 agent 判断；工具的说明里明确要求它跳过临时任务状态、以及本来就能从文件里读到的东西。

## 工作原理

两套机制，一个存储：

1. **`memory` 工具** —— 一个工具四个动作（`save`、`search`、`list`、`forget`）。`save` 会折叠空白并做大小写无关去重，所以同一件事说第二遍是**更新**，不会堆出一堆近似副本。
2. **提示词片段** —— 通过 `ctx.systemPrompt.section()` 注册，order `10150`，排在 Web surface 之后、persona suffix 之前。它的 `text` 是**函数**，每次装配都会重新求值：一个会话里存的事实，下一步就在所有会话里可见，不用重启。

片段按字节封顶（`maxBytes`，默认 4096），新的优先；超出时会注明省略了多少条；预算紧到放不下标题时会降级成短标题，而不是让整个功能静默消失。

## 存储

```
~/.dsh/memory/memory.jsonl
```

一行一个 JSON 对象：

```json
{"id":"4f2a91c8","content":"Prefers pnpm over npm.","tags":["preference","tooling"],"createdAt":"2026-11-09T08:12:44.101Z","updatedAt":"2026-11-09T08:12:44.101Z"}
```

- **是你的。** 就是个文本文件：`cat`、`grep`、`git`、手改、删行都行。
- **改坏不会崩。** 格式错误的那一行会被跳过，不会因为一个手误让插件失效。
- **原子写入。** 先写临时文件再改名，写到一半崩掉也不会截断原文件。
- **纯本地。** 不上传任何东西。没有账号、没有埋点、整份代码里没有一行网络请求。

## 配置

可选，默认值就是大多数人想要的。写进 profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-memory
  name: 'dsh-memory'
  config:
    dir: 'C:/Users/me/.dsh/memory'   # 默认 <DSH home>/memory
    maxBytes: 4096                   # 提示词片段预算
    maxEntries: 500                  # 超出后淘汰最旧的
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `dir` | `<DSH home>/memory` | 存储目录；设置了 `DSH_HOME` 时以它为准。 |
| `maxBytes` | `4096` | 注入片段的字节预算。 |
| `maxEntries` | `500` | 条目上限，超出淘汰最旧的。 |

## 局限

这个版本**不做**什么，说清楚：

- **只有一份全局存储。** 记忆对所有工作区生效，按项目隔离还没做。
- **子串检索。** 没有向量、没有排序，`search` 就是大小写无关的子串匹配。几百条短事实够用，且零成本。
- **不自动提炼。** 由 agent 显式保存，没有回合结束后偷偷烧 token 的摘要器。
- **没有界面。** 没有设置页、没有面板——只有一个工具和一个提示词片段。
- **会占提示词。** 4 KB 大约 1 K token，每次请求都在。介意就把 `maxBytes` 调小。

## 要求

- DeepSeek Harness `0.2.x`（针对 `0.2.2-rc.1` 开发和验证）
- Node `>= 20`
- 零依赖，只 import Node 标准库

## 开发

```bash
node test/smoke.mjs
```

按加载器的方式用桩上下文挂载插件，然后在临时存储上驱动工具和提示词片段：35 项检查，覆盖去重、预算裁剪、淘汰、坏行容错和参数校验。不需要测试框架，也不需要安装依赖。

## 许可

MIT，见 [LICENSE](LICENSE)。
