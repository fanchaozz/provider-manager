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

## 最近变更

版本变更记录看 [CHANGELOG.md](./CHANGELOG.md)。

## 快速开始

| 想做什么 | 操作 |
|---|---|
| 打开仪表盘 | `/providers` |
| 列出 provider + 它们的 model | `/providers ls`（过滤：`/providers ls kdapi`） |
| 新增 provider | 仪表盘 Providers 面板按 `n`，或 `/providers add [<id>]` |
| 新增 / 删除 model | **通过 sync**（仪表盘 Models 面板按 `y`），或 **手动新增**（按 `n`，sync 拉不到时使用模板） |
| 编辑 provider / model | 仪表盘选中后按 `Enter`（表单里 Enter 进入字段 edit、确认） |
| 删除 | 仪表盘按 `d`（确认对话框） |
| 从 provider 的 API 拉取新 model 列表 | 仪表盘按 `y`，或 `/providers sync [<pid>]` |
| 探测 auth + 可达性 + 1-token 测试调用 | 仪表盘 `t`（当前 model）或 `T`（provider 内全部） |
| 从最近 `.bak` 恢复 | `/providers reset` |
| 打印命令帮助 | `/providers help` |
| 关闭仪表盘 | `q` 或 `Esc` |

`sync` 命令是给全新 provider 填充 model 列表最快的方式：拉取远端 model 列表，显示 checklist，把选中的写回。sync 不到时（离线上游 / 私有部署 / 不支持 `/models`）可以**手动新增**：仪表盘 Model 面板按 `n`，使用 `~/.pi/agent/provider-manager.json#defaultModel` 模板（`compat.supportsDeveloperRole:false` 也保留不丢）。

---

## 仪表盘

`/providers` 打开两栏 TUI：

- **左栏** —— provider（id + auth 状态 + model 数；0 model 时 ⚠ 提示）
- **右栏** —— 选中 provider 的 model（id + `[R]` reasoning / `[I]` image 标记 + ctx / max；R / I 实际值，未启用是 `-`）
- **详情面板** —— 选中行分组：Identity / Endpoint / Auth / Capabilities / Limits / Thinking levels / Cost
- **底栏** —— 按面板调整的按键提示（按 `?` 看完整 help）

### 按键绑定

| 键 | 行为 |
|---|---|
| `↑↓` / `j k` | 在当前面板上下移动 |
| `g` / `G` | 跳到顶 / 底 |
| `←` / `→` | 切换 Providers ↔ Models 面板 |
| `n` | **Providers 面板**：新增 provider。**Models 面板**：手动新增 model（sync 不到时；走 `defaultModel` 模板） |
| `Enter` | 选中行进入 edit 表单（Provider 或 Model） |
| `d` | 删除（带确认对话框） |
| `y` | 同步（拉取选中 provider 的远端 model 列表） |
| `t` / `T` | **仅 Models 面板**：探测当前 model / provider 内全部 model |
| `?` | 切换帮助覆盖层（按面板显示特有键） |
| `q` / `Esc` | 关闭仪表盘 |

底部提示按面板动态调整（provider 面板显示 `n`、model 面板显示 `t` / `T`），不会出现在不该出现的面板里。

---

## 同步流程

`sync` 是批量加 model 的最快方式。它会拉取选中 provider 的远端 model 列表并显示 checklist。sync 拉不到时（离线上游 / 私有部署 / 不支持 `/models`）可以用 **手动新增**（仪表盘 Model 面板 `n`）。

**checklist 展示该 provider 的所有 model**（existing + remote new 都有）：

- 已有 model 标 `<id>  (existing)`，默认勾选。取消勾选 = 删除。
- 远端新 model 只标 `<id>`，默认不勾选。勾选 = 添加。

按 `Enter` 写入结果，按 `Esc` 取消。保存时最终 `models.json` 是 (勾选的 existing) + (勾选的 new) 的并集；远端 new 优先于 local（这样能拉到最新的 `reasoning` / `input` / `ctx` / `maxTokens` / `thinkingLevelMap`）。

**checklist 对齐 pi 的 `/models` 列表交互**（model 多也能顺畅操作）：

- **始终可见的 search 输入框**：顶部 `> ` 提示词 + 输光标，随时键入过滤（不区分大小写，同时匹配 `id` 和 `label`）；Backspace 删字。
- **视口滚动**：默认 8 行可见。item 多于可见行时上下以 `⋮ N more below` / `⋮ N hidden` 提示。
- **钉住首项**：cursor 滚出首页区后，顶部仍钉住 `m000 (top)`。无论怎么滚都能看到首项。
- **wrap-around 导航**：`↑` / `↓` 顶部 / 底部循环选择；`j` / `k` 等价。
- **Space 切换选中**：filter 状态下也作用于过滤后的当前项，不会误动隐藏项。
- **顶部 `selected / total selected`** 状态保持。
- **底部 `(current/total)` 位置指示**（filter 非空时是过滤后位置，空时是总长度）。
- **search-first 约定**：所有可打印字符（a / i / g / G 等）都进 search，不作快捷键。避免与过滤输入冲突。

视口高度可以用 `~/.pi/agent/provider-manager.json` 的 `syncViewportSize` 字段覆盖（5–200，越界走默认 8）。

**新加的 model 字段来自 `~/.pi/agent/provider-manager.json` 的 `defaultModel` 段**（不是代码内置默认）—— 这是 `loadDefaultModelConfig()` 的行为。在 sync 前编辑这个文件可以定制 sync 出来的 model 模板。

**proxy 字段**：provider 编辑表单里可填 `proxy`（形如 `http://127.0.0.1:7890`）。sync 时设到 `HTTPS_PROXY` / `HTTP_PROXY` 环境变量，请求结束后还原。其他并发 fetch 会临时看到同一 proxy（env 是进程全局的，sync 一次只 1 个 fetch）。

**apiKey 字符约束**：sync 拒绝 `code > 255` 的 apiKey（含 `•`、中文、emoji 等，常见于复制粘贴残留）。错误是 actionable：`apiKey contains non-Latin-1 character at position 7 (U+2022). Re-enter the key in the provider form.`

**检测 noise**：默认过滤 `embed*` / `tts` / `whisper` / `dall-e` / `clip` / `moderation` / `image-*` 等 embedding/tts/image-gen 类 model。

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

`addProviderFlow` / `editProviderFlow` / `editModelFlow` / `deleteProviderFlow` / `deleteModelFlow` 都共用一个 TUI 表单（`components.ts:FormEditor`）。**`addModelFlow` 已停用**——model 只能通过 sync 增删。

### 字段类型

| 类型 | 行为 |
|---|---|
| `text` | 自由文本输入 |
| `secret` | 同 `text`，但用 `Enter` 进入 edit 后显示真实值（不显示 masked `••••Xn`），切 field 不写回 masked 覆盖原 key |
| `number` | 自由数字输入，提交时校验 |
| `select` | 选项列表；按 `Enter` 进 edit，`Space` 选中，`↑↓` / `jk` 导航，再 `Enter` 退出 |
| `multiselect` | 类似 `select` 但可多选；`Space` 切换每项 |
| `levelmap` | 7 行（`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`）；`Space` 切换每项；提交时归一化缺失的 key 为 `null` |
| `readonly` | 仅展示，不可编辑 |

### 按键绑定（统一 view / edit 两态模型）

| 键 | view 模式 | edit 模式 |
|---|---|---|
| `↑↓` / `j k` | 切字段 | non-typeable：选项内 nav；typeable：no-op（j/k 是字符） |
| `Enter` | 进 edit | commit + 退出 edit（留在原字段） |
| `Esc` / `q` | 取消整个 form | 退出 edit（commit） |
| `s` | 保存整个 form | no-op（typeable 里 s 是字符；non-typeable 忽略） |
| `Space` | non-typeable 快捷进 edit | non-typeable 切换 / 选中 |
| `Backspace` | no-op | typeable 删最后一个字符 |
| 字符 | no-op | typeable 追加到 draft |

**view 模式不接受任何字符输入**（含 `s` / `q` / 数字 / 字母）。需要先按 `Enter` 进 edit 才能改。

**typeable 字段的 `j` / `k` 在 view 模式是 nav**（不当作字符），在 edit 模式是字符。

**secret 字段的两种保护**（避免保存的 key 被 masked 显示覆盖）：
1. 进入 edit 时 `draft` 恢复为真实值（不是 masked `••••Xn`），用户能看见 / 修改真 key
2. commitDraft 在 `draftIsOriginal=true`（用户没改）时不写回，保证原 key 完整

### `addProviderFlow` 与 `editProviderFlow` 结构同形

两个流程都用同一个 FormEditor 模板（含 `id` / `name` / `baseUrl` / `apiKey` / `api` / `authHeader` / `proxy` 字段）。`addProviderFlow` 的 `id` 字段有 `validate`：字符集 `[a-z0-9_-]+` + 不能与已有 provider 重复（`json.providers[s]` 已存在则报 "provider already exists"）。错误留在 FormEditor 自带的 `⚠ ...` 行显示，不弹 notify 打断流程。

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

**Sync 报 `ECONNREFUSED` / `ENOTFOUND`。** 选中 provider 的 `baseUrl` 不通。用仪表盘选中该 provider 后按 `Enter` 进 edit 表单改。

**Sync 报 `HTTP 500` / `HTTP 401`。** `baseUrl` 错或 `apiKey` 缺失/错。在 provider 编辑表单里核对。

**Sync 报 `Cannot convert argument to a ByteString`。** apiKey 含非 Latin-1 字符（`•`、中文、emoji 等，常见于复制粘贴残留）。**重新打开 provider 的 edit 表单，把 apiKey 字段清空再贴一次**真 key。

**Sync 总是 `ctx=128000` / `max=16384`（默认值），看起来没读到 user 配置。** 检查 `~/.pi/agent/provider-manager.json` 是否存在 + 路径正确（必须正好是这个文件名，不是 `providers.json` 等）。校验：`node -e "JSON.parse(require('fs').readFileSync(process.env.HOME+'/.pi/agent/provider-manager.json','utf8'))"`。

**Dashboard 显示的 `apiKey status` 与真状态不一致。** dashboard 不通过 pi runtime 检测 key 是否真有效（避免 OAuth / runtime / env / extension 多路径歧义），只自检 `models.json` 里 `apiKey` 字段是否非空。**真认证测试用 `t` / `T`**。

**保存 secret 字段后 apiKey 变成了 `••••Xn`。** 这是 0.1.x 的老 bug（切 field 时 commitDraft 把 masked 字符串写回原 key）。0.2.0 已修：进入 edit 时 draft 恢复真实值，未改时 commitDraft 跳写。**0.2.0 起，re-enter edit 表单不会改变 key**。如果是老版本升上来：edit 表单里把 apiKey 清空再贴一次真 key。

**设的 thinking level 一保存就消失。** pi 可能不支持该 level — 换别的，或者填 `null` 禁用。

**按 `n` / `Enter` / `d` / `y` 后 Esc 仪表盘消失。** 当前版本不应发生 — 仪表盘会自动恢复。如果发生了，请带 `~/.pi/agent/provider-manager.log` 反馈。

---

## 相关

- pi 内置 `/model` — 切换当前 model
- pi 内置 provider auth（`/login` 或环境变量）— 设 API key
- 备份恢复：`/providers reset` 或 `cp ~/.pi/agent/models.json.bak ~/.pi/agent/models.json`
