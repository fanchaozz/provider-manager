# provider-manager

[English](./README_EN.md) | [简体中文](./README.md)

一个 pi 扩展，通过 TUI 仪表盘、`/providers` 斜杠命令和远端同步流程，管理 `~/.pi/agent/models.json` 中的自定义 provider 和 model。

> **范围**：只覆盖 `models.json` —— 本扩展**不**管理内置 provider、**不**切换 model、**不**提供登录 UI。这些请用 pi 内置的 `/model` 和 provider 认证流程。

---

## 安装

```bash
pi install npm:@fanchaozz/provider-manager
```

依赖：`@earendil-works/pi-coding-agent`（pi 自带）。jiti 向上找 `node_modules`，**不需要**在扩展目录内 `npm install`。

安装后，首次加载时会自动创建 `~/.pi/agent/provider-manager.json`（见 [用户配置](#用户配置--provider-managerjson)）。删除该文件即可回退到代码默认。

---

## 快速开始

| 想做什么 | 操作 |
|---|---|
| 打开仪表盘 | `/providers` |
| 列出 provider + 它们的 model | `/providers ls`（过滤：`/providers ls kdapi`） |
| 新增 provider | 仪表盘 Providers 面板按 `n`，或 `/providers add [<id>]` |
| 新增 model | 仪表盘 `Tab` 切到 Models 面板按 `n`，或 `/providers model <pid> add` |
| 编辑 provider / model | 仪表盘按 `e` |
| 删除 | 仪表盘按 `d`（确认对话框） |
| 从 provider 的 API 拉取新 model 列表 | 仪表盘按 `y`，或 `/providers sync [<pid>]` |
| 探测 auth + 可达性 + 1-token 测试调用 | 仪表盘 `t`（当前 model）或 `T`（provider 内全部） |
| 从最近 `.bak` 恢复 | `/providers reset` |
| 打印命令帮助 | `/providers help` |
| 关闭仪表盘 | `q` 或 `Esc` |

`sync` 命令是给全新 provider 填充 model 列表最快的方式：拉取远端 model 列表，显示 checklist，把选中的写回。

---

## 仪表盘

`/providers` 打开两栏 TUI：

- **左栏** —— provider（id + model 数）
- **右栏** —— 选中 provider 的 model（id + `[R]` reasoning / `[I]` image 标记 + ctx / max）
- **详情条** —— 选中行的原始 JSON
- **底栏** —— 当前按键说明

### 按键绑定

| 键 | 行为 |
|---|---|
| `↑↓` / `j k` | 在当前面板上下移动 |
| `g` / `G` | 跳到顶 / 底 |
| `Tab` | 切换 Providers ↔ Models 面板 |
| `n` | 新增：Providers 面板下加 provider，Models 面板下加 model |
| `e` | 编辑选中的 provider / model |
| `d` | 删除（带确认对话框） |
| `y` | 同步（拉取选中 provider 的远端 model 列表） |
| `t` / `T` | 探测当前 model / provider 内全部 model |
| `?` | 切换帮助覆盖层 |
| `q` / `Esc` | 关闭仪表盘 |

provider 列表为空时，在 Models 面板按 `n` 会切到 Providers 面板并提示先创建一个。

---

## 同步流程

`sync` 是批量加 model 最快的方式。它会拉取选中 provider 的远端 model 列表并显示 checklist。

checklist **展示该 provider 的所有 model —— existing + remote new 都有**：

- 已有 model 标 `<id>  (existing)`，默认勾选。取消勾选 = 删除。
- 远端新 model 只标 `<id>`，默认不勾选。勾选 = 添加。

按 `Enter` 写入结果，按 `Esc` 取消。保存时，最终 `models.json` 是（勾选的 existing）+（勾选的 new）的并集；如果某 model 同时被远端和 local 都有并都被勾选，优先用远端定义（这样能拉到最新的 `reasoning` / `input` / `ctx` / `maxTokens` / `thinkingLevelMap` 来自默认 model 配置）。

---

## 用户配置 — `provider-manager.json`

`~/.pi/agent/provider-manager.json` 控制以下场景的默认值：
- 在新增 model 表单回答 "yes" 到 "Use default config?"
- 从远端 API 同步新 model

首次启动自动创建。删掉就回退到代码默认。

### Schema

```jsonc
{
  "_defaultModel": "自由格式注释，运行时忽略",
  "defaultModel": {
    "reasoning": true,
    "input": ["text", "image"],
    "contextWindow": 128000,
    "maxTokens": 16384,
    "thinkingLevelMap": {
      "off": null,
      "minimal": null,
      "low": null,
      "medium": "medium",
      "high": null,
      "xhigh": null,
      "max": null
    }
  }
}
```

### 字段规则

- **`reasoning`** — boolean。`true` 表示该 model 支持扩展思考，`thinkingLevelMap` 才生效。
- **`input`** — 非空数组，内容是 `"text"` 和/或 `"image"`。`"text" | "image"` 表示 model 接受该模态。
- **`contextWindow`** / **`maxTokens`** — 正整数（token 数）。
- **`thinkingLevelMap`** — object。7 个 key（`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`）的任意子集。`string` 值（如 `"medium"`）表示该 thinking level 启用，字符串发给 provider；`null` 表示禁用。缺失的 key 当 `null` 处理。

如果文件缺失、JSON 损坏或校验失败，扩展会静默 fallback 到上面展示的内置默认。

### 为什么 `medium` 是默认勾选的

同步的 model 若 `reasoning: true` 且 `thinkingLevelMap.medium = "medium"`，pi 的 Shift+Tab 思考级别循环会默认落到 `medium`。根据你上游实际支持的级别选 — 不支持的填 `null` 禁用即可。

---

## 表单编辑器（新增/编辑 model/provider）

`addProviderFlow` / `editProviderFlow` / `addModelFlow` / `editModelFlow` / `deleteProviderFlow` / `deleteModelFlow` 都共用一个 TUI 表单（`components.ts:FormEditor`）。

### 字段类型

| 类型 | 行为 |
|---|---|
| `text` | 自由文本输入 |
| `secret` | 自由文本，TUI 渲染时遮罩 |
| `number` | 自由数字输入，提交时校验 |
| `select` | 选项列表；按 `e` 进 edit 模式，`Space` 选中，`↑↓`/`jk` 导航，`Enter` 确认 |
| `multiselect` | 类似 `select` 但可多选；`Space` 切换每项 |
| `levelmap` | 7 行（`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`）；`Space` 切换每项；提交时归一化缺失的 key 为 `null` |
| `readonly` | 仅展示，不可编辑 |

### 按键绑定

| 键 | 行为 |
|---|---|
| `e` / `E` | 进入 edit 模式（仅 `select` / `levelmap` / `multiselect`） |
| `Esc` / `q` | edit 中：退出 edit（commit 当前值）。其他：取消整个表单 |
| `s` | 保存整个表单。仅在 non-typeable 字段生效 — `s` 在 `text` / `secret` / `number` / `json` 里是字符 |
| `Enter` | edit 中（非输入字段）：commit 并退出 edit。typeable 字段：commit + 移到下一字段。readonly 字段：保存表单 |
| `Space` | edit 中（非输入字段）：切换当前选项 |
| `↑↓` / `j k` | 字段间导航；edit 中（非输入字段）：选项间导航 |
| `Backspace` | 删最后一个字符（typeable 字段） |

### 新增 model 流程："Use default config?"

`addModelFlow` 在 name 之后问一次：

- **Yes** — 应用 `DEFAULT_MODEL_CONFIG`（见 [用户配置](#用户配置--provider-managerjson)），跳过剩余问题
- **No** — 逐个问 reasoning / input / ctx / max / thinking-level-map

`Esc` 在任何问题中都能取消整个流程（仪表盘自动恢复）。

---

## 探测 model（`t` / `T`）

`t` 探测当前 model；`T` 探测当前 provider 内全部 model。每个 model 三档检查：

| 检查 | 做什么 | 成本 |
|---|---|---|
| `auth` | 在 `~/.pi/agent/auth.json`（或环境变量）里查 provider 的 API key | 免费 |
| `reachable` | `GET {baseUrl}/models`，10s 超时 | 免费 |
| `generated` | 发 4-token prompt（`"Reply with the single word: ok"`）并检查 `stopReason ∈ {stop, length}` | ~4 token |

硬上限：`maxTokens` 钳到 16；超时 10s（用 `PI_PROVIDER_TEST_TIMEOUT` 环境变量覆盖）。结果缓存在进程内，重启 pi 前有效。

---

## 文件布局

```
~/.pi/agent/
├── models.json              ← 本扩展编辑的文件
├── models.json.bak          ← 每次写前的自动备份
└── extensions/
    └── provider-manager/    ← 本扩展（pi install / git clone 安装）
```

本扩展不触碰 `models.json` 和 `models.json.bak` 之外的文件。要回滚，从 `.bak` 恢复：`/providers reset`，或手动：

```bash
cp ~/.pi/agent/models.json.bak ~/.pi/agent/models.json
```

---

## 故障排查

**`pi install` 报 `E404` 或 "no such package"。** npm registry 没收到这个包名。先 `npm view @fanchaozz/provider-manager` 看是否发布成功；如果成功还报，检查 `npm config get registry` 输出不是 `npm.pkg.github.com`。

**仪表盘打开是空的。** 你的 `models.json` 里没有自定义 provider。本扩展只管 `models.json` — pi 内置 provider（anthropic / openai / google 等）不显示，用 pi 内置的 `/model`。

**Sync 报 `ECONNREFUSED` / `ENOTFOUND`。** 选中 provider 的 `baseUrl` 不通。用 `/providers edit <pid>`（或仪表盘 `e`）改。

**Sync 报 `HTTP 500` / `HTTP 401`。** `baseUrl` 错或 `apiKey` 缺失/错。在 provider 编辑表单里核对。

**设的 thinking level 一保存就消失。** pi 可能不支持该 level — 换别的，或者填 `null` 禁用。

**`provider-manager.json` 里的修改全部失效。** 文件损坏或校验失败（见 [Schema](#schema)）。扩展会静默 fallback 默认。校验：`node -e "JSON.parse(require('fs').readFileSync(process.env.HOME+'/.pi/agent/provider-manager.json','utf8'))"`。

**Sync 加的 model 字段错（不管什么都 `ctx=128000`）。** model 用的是默认，不是文件。文件没被读。检查路径：必须正好是 `~/.pi/agent/provider-manager.json`（不是 `~/.pi/agent/providers.json` 之类）。

**按 `n` / `e` / `d` / `y` 后 Esc 仪表盘消失。** 当前版本不应发生 — 仪表盘会自动恢复。如果发生了，请带 `~/.pi/agent/provider-manager.log` 反馈。

---

## 相关

- pi 内置 `/model` — 切换当前 model
- pi 内置 provider auth（`/login` 或环境变量）— 设 API key
- 备份恢复：`/providers reset` 或 `cp ~/.pi/agent/models.json.bak ~/.pi/agent/models.json`
