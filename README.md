# provider-manager

[English](./README_EN.md) | [简体中文](./README.md)

pi 扩展：通过 TUI 仪表盘、`/providers` 斜杠命令和远端同步流程，管理 `~/.pi/agent/models.json` 中的自定义 provider 和 model。

> **范围**：只覆盖 `models.json` —— 本扩展**不**管理内置 provider、**不**切换 model、**不**提供登录 UI。这些请用 pi 内置的 `/model` 和 provider 认证流程。

---

## 安装

本扩展按 pi extension 包发布。源代码在 https://github.com/fanchaozz/provider-manager（public），**目前没发布到 npm**。

### 方式 A：本地路径安装（开发 / 即时使用）

```bash
# 克隆仓库
git clone https://github.com/fanchaozz/provider-manager.git
# 创建符号链接到 pi 扩展目录（Windows 用 mklink /D，macOS / Linux 用 ln -s）
ln -s "$(pwd)/provider-manager" ~/.pi/agent/extensions/provider-manager
# 或：复制到扩展目录
cp -r provider-manager ~/.pi/agent/extensions/
```

或者在 pi 项目里直接 `pi install /path/to/provider-manager`。

### 方式 B：发布到 npm 后（推荐给用户安装）

```bash
cd provider-manager
npm login
npm publish --access public
```

发布后用户可以 `pi install npm:@fanchaozz/provider-manager`。

### 方式 C：从 GitHub Packages 安装（已自动发布）

GitHub Actions 在每次 GitHub Release 时自动 publish 到 `https://npm.pkg.github.com/`（见 `.github/workflows/publish.yml`）。用户配置一次 npm registry，然后 `npm install` / `pi install` 跟普通 npm 包一样：

```bash
# 一次性配置：加 GitHub Packages registry 和带 `read:packages` scope 的 token
echo "@fanchaozz:registry=https://npm.pkg.github.com/" >> ~/.npmrc
echo "//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN" >> ~/.npmrc

# 然后安装：
pi install npm:@fanchaozz/provider-manager
# 或：npm install @fanchaozz/provider-manager
```

依赖：`@earendil-works/pi-coding-agent`（pi 自带）。jiti 向上找 `node_modules`，所以**不需要**在扩展目录内 `npm install`。

安装后，首次加载时会自动创建 `~/.pi/agent/provider-manager.json`（见 [用户配置](#用户配置--provider-managerjson)）。删除该文件即可回退到代码默认。

---

## 文件结构

```
D:/codex/provider-manager/                ← 仓库 / 开发根
├── index.ts          ( 18)  入口：注册命令 + 调 ensureDefaultConfigFile
├── commands.ts       (313)  /providers 命令 + 子命令派发
├── ui.ts             (643)  Dashboard TUI 组件（面板、帮助、键盘处理）
├── forms.ts          (622)  所有业务流 + 默认 model 配置 + 用户级配置加载
├── components.ts     (696)  可复用 TUI 组件：FormEditor、ModelChecklist、按键匹配
├── store.ts          (282)  models.json I/O：读/写/备份/恢复/校验（原子 + 互斥）
├── sync.ts           (253)  远端 model 拉取 + 启发式字段推断 + diff/merge
├── test.ts           (354)  model 可用性探测：auth + reachable + 1-shot generation
├── _test_*.mts              单元测试（用 `node --experimental-strip-types` 跑）
├── README.md                  ← 本文件
├── README_EN.md               英文版
└── node_modules/              dev 依赖（pi-coding-agent 副本）

C:/Users/fcmeng/.pi/agent/extensions/provider-manager/  ← 部署副本（md5 与仓库一致）
```

---

## 命令

所有命令注册在 `/providers` 下（见 `commands.ts`）。

| 子命令 | 行为 | 需要 TUI？ |
|---|---|---|
| `/providers`（无参数） | 打开 TUI 仪表盘 | 是 |
| `/providers ls [filter]` | 列出自定义 provider（id、displayName、model 数、[reasoning][vision] 标记） | 否 |
| `/providers add [<id>]` | 打开新增 provider 表单 | 是 |
| `/providers remove <id>` | 确认后删除 provider | 是 |
| `/providers model <pid> add` | 打开新增 model 表单 | 是 |
| `/providers sync [<pid>]` | 拉取远端 model 列表，显示合并 checklist，写回 | 是 |
| `/providers test` / `test-all` | 探测当前 model / 当前 provider 全部 model | 是 |
| `/providers reset` | 从 `models.json.bak` 恢复（带确认） | 是 |
| `/providers help` | 打印帮助 | 否 |

参数补全：`ls`, `add`, `remove`, `sync`, `test`, `test-all`, `reset`, `help`。

---

## 仪表盘

`/providers` 打开两栏 TUI（`ui.ts:Dashboard`）：

- **左栏** —— provider（id + model 数）
- **右栏** —— 当前选中 provider 的 model（id + [R][I] 标记 + ctx / max）
- **详情条** —— 选中行的原始 JSON
- **底栏** —— 当前按键说明

### 按键绑定

| 键 | 行为 |
|---|---|
| `↑↓` / `j k` | 在当前面板上下移动 |
| `g` / `G` | 跳到顶 / 底 |
| `Tab` | 切换 Providers ↔ Models 面板 |
| `n` | 新增：provider 面板下加 provider，model 面板下加 model |
| `e` | 编辑选中的 provider / model |
| `d` | 删除（带确认） |
| `y` | 同步（拉取选中 provider 的远端 model 列表） |
| `t` / `T` | 探测选中 model / 选中 provider 全部 model |
| `?` | 切换帮助覆盖层 |
| `q` / `Esc` | 关闭仪表盘 |

provider 列表为空时，在 model 面板按 `n` 会切到 provider 面板并提示先创建。

---

## 表单编辑器

`/providers add`、`/providers remove`、`/providers model <pid> add`、编辑（`e`）、同步（`y`）都打开同一个 TUI 表单组件（`components.ts:FormEditor`）。

### 表单字段

| 类型 | 行为 |
|---|---|
| `text` | 自由文本输入 |
| `secret` | 自由文本，渲染时遮罩 |
| `number` | 自由数字输入，提交时校验 |
| `select` | 选项列表；按 `e` 进 edit 模式，`Space` 选中，`↑↓`/`jk` 导航，`Enter` 确认 |
| `multiselect` | 类似 select，但可多选；`Space` 切换每项 |
| `levelmap` | 7 行（`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`）；`Space` 切换每项；提交时归一化缺失的 key 为 `null` |
| `readonly` | 仅展示，不可编辑 |

### 表单按键绑定

| 键 | 行为 |
|---|---|
| `e` / `E` | 进入 edit 模式（仅 `select` / `levelmap` / `multiselect`） |
| `Esc` / `q` | edit 中：退出 edit（commit 当前值）。其他：取消整个表单 |
| `s` | 保存整个表单（commit draft + write）。仅在 non-typeable 字段 — `s` 在 `text`/`secret`/`number`/`json` 里是字符 |
| `Enter` | edit 中（非输入字段）：commit 并退出 edit。typeable 字段：commit + 移到下一字段。readonly 字段：保存表单 |
| `Space` | edit 中（非输入字段）：切换当前选项 |
| `↑↓` / `j k` | 字段间导航；edit 中（非输入字段）：选项间导航 |
| `Backspace` | 删最后一个字符（typeable 字段） |

### "Use default config?"（仅 new model）

`addModelFlow` 在 `name` 之后问一次：

- Yes → 应用 `DEFAULT_MODEL_CONFIG`（见 [用户配置](#用户配置--provider-managerjson)），跳过剩余问题
- No → 逐个问 reasoning、input、ctx、max、thinkingLevelMap

---

## 同步流程

`syncFlow`（在 `forms.ts`）拉取选中 provider 的远端 model 列表并显示 checklist。行为：

- checklist **展示该 provider 的所有 model**（existing + remote new 都有）
  - existing model：label `<id>  (existing)`，hint `uncheck to remove`，**默认勾选**
  - remote new model：label `<id>`，hint `reasoning=… input=… ctx=…`，**默认不勾选**
- 用户取消勾 → 删除；勾 new → 添加
- 按 `Enter` 确认，`Esc` 取消（不改任何东西）
- 保存时，最终 `models.json` 是：
  - 勾选的 existing model
  - 勾选的 new（remote）model
  - remote new 优先于 local（取 `DEFAULT_MODEL_CONFIG` 的最新字段）

如果 0 个 model 被勾选，sync 是 no-op（带 notify）。

---

## 存储层（`store.ts`）

所有 `~/.pi/agent/models.json` 的读/写都通过 `store.ts`。

- **原子写** — 每次 `writeModelsJson(next, opts)`：
  1. `copyFile` 当前 `models.json` → `models.json.bak`（除非 `opts.backup === false`）
  2. `writeFile` 到 `models.json.tmp`
  3. `rename` `models.json.tmp` → `models.json`
  4. `chmod 0o600`（Windows 下是 no-op）
- **写互斥** — 模块级 `writeChain: Promise<void>` 串行化所有写；一个失败不污染链
- **校验** — `validateProvider` / `validateModel` / `validateAll` 检查类型和必填字段
- **路径 override**（给测试用）— `Symbol.for("pi-provider-manager:models-path-override")` 和 `…backup-path-override"`

> **警告**：互斥锁串行化文件 I/O，但**不**覆盖每个 flow 用的"读改写"模式。两个并发 flow 可能丢数据。单用户 CLI 安全；编程调用不安全。

---

## 同步拉取层（`sync.ts`）

`sync.ts` 提供：

- `fetchListing({ baseUrl, apiKey, apiKind, signal, timeoutMs })` — 调 `GET {base}/models`，支持 OpenAI-compat（`{ data: [...] }`）和 Google Generative AI（`{ models: [{ name, ... }] }`）。过滤 noise（`embed`/`tts`/`whisper`/`dall-e`/`clip`/`moderation`/`image-*`）。
- `inferReasoning(id)` / `inferInput(id)` — 基于名字的启发式（`o1`/`reasoning`/`thinking`/`deepseek-r`/等 → `reasoning: true`；`vision`/`gpt-4`/`claude`/`gemini` → `input: ["text","image"]`）
- `inferModel(id, fetched, overrides?)` — 生成 `ModelConfig`；默认 `contextWindow: 128000`、`maxTokens: 16384`、`thinkingLevelMap.medium = "medium"`（其余 `null`）。`overrides.defaults` 来自 `loadDefaultModelConfig`。
- `diffModels(fetched, existing, overrides?)` — 拆 fetched 为 `toAdd`（new）和 `skipped`（noise）

`THINKING_PRESETS` 从 `forms.ts` 导出（5 个选项含 Custom JSON），仅在 `addModelFlow` 用（sync 不再问用户，直接应用默认）。

---

## 测试层（`test.ts`）

仪表盘 `t` / `T` 调 `test.ts` 的 `testModel` / `testProvider`。每个 model 探测有 3 个检查：

| 检查 | 做什么 | 成本 |
|---|---|---|
| `auth` | `ctx.modelRegistry.getProviderAuthStatus(provider)` | 0 |
| `reachable` | `GET {base}/models`（或 Google 端点）10s 超时 | 0 |
| `generated` | `ctx.modelRegistry.complete(model, ctx, { signal, maxTokens: 4 })`，prompt 为 `"Reply with the single word: ok"` | ≤ 4 token |

硬上限：`maxTokens` 钳到 16（不管 caller 传多少）。10s 超时（`PI_PROVIDER_TEST_TIMEOUT` env 可改）。`stopReason === "stop" | "length"` 算成功。

结果缓存在进程内 `Map<"${provider}/${modelId}", TestResult>`。测试用 `getCached` / `clearCache`。

---

## 用户配置 — `provider-manager.json`

每次 pi 启动，`ensureDefaultConfigFile` 同步写一份默认 `provider-manager.json` 到 `~/.pi/agent/provider-manager.json`（如果不存在）。该文件控制 `addModelFlow`（"Use default config? yes" 路径）和 `syncFlow`（新 model 字段）的默认值。

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

### 校验规则

- `reasoning`：必须 boolean
- `input`：必须非空数组，内容是 `"text"` 和/或 `"image"`
- `contextWindow` / `maxTokens`：必须是正有限数
- `thinkingLevelMap`：必须是 object（7 个 key 的任意子集；缺失的 key 当 `null`）

文件缺失、JSON 损坏或校验失败，`loadDefaultModelConfig` 静默 fallback 到代码默认并 `console.warn`。

### 路径 override（给测试用）

`Symbol.for("pi-provider-manager:default-model-path-override")` 重定向 `getDefaultModelConfigPath` 用的路径。

---

## 代码默认（`forms.ts` 的 `DEFAULT_MODEL_CONFIG`）

`provider-manager.json` 缺失或无效时用：

```ts
{
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 128000,
    maxTokens: 16384,
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null }
}
```

---

## 开发

### 跑全部测试

```bash
cd D:/codex/provider-manager
for f in _test_*.mts; do
  echo "=== $f ==="
  node --experimental-strip-types --no-warnings "$f" 2>&1 | tail -3
done
```

`node --experimental-strip-types` 运行时剥 TypeScript 类型；**不**做类型检查。所以 `import type { Foo }` 必须为任何会被擦除但不间接可达的类型声明。

13 个测试文件覆盖：

- `forms.ts` 导出：`addProviderFlow` / `editProviderFlow` / `deleteProviderFlow` / `addModelFlow` / `editModelFlow` / `deleteModelFlow` / `restoreFromBackupFlow` / `syncFlow` / `ensureDefaultConfigFile` / `loadDefaultModelConfig`
- `components.ts`：`FormEditor`（所有按键路径、levelmap、multiselect、`s`/`Esc`/`Enter` 门控）和 `ModelChecklist`
- `ui.ts`：`Dashboard` 按键处理、`runForm` / `runSync` / `runTest`（`__test = true` 静态标志开启单元测试调用）
- `sync.ts`：`fetchListing` / `inferModel` / `diffModels` / `isNoise` / `inferReasoning` / `inferInput` 带 mock `fetch` 和 mock `ctx`
- `store.ts`：读/写/备份/恢复/校验路径
- 端到端 audit（`_test_audit_endtoend.mts`）：25 个跨流断言，含新的合并语义、default-keep 行为、`s` / `Esc` / customSelect 场景、`ensureDefaultConfigFile` 幂等、sync 错误处理

### 路径 override（测试 setup）

```ts
(globalThis as any)[Symbol.for("pi-provider-manager:models-path-override")] = "/tmp/.../models.json";
(globalThis as any)[Symbol.for("pi-provider-manager:backup-path-override")] = "/tmp/.../models.json.bak";
(globalThis as any)[Symbol.for("pi-provider-manager:default-model-path-override")] = "/tmp/.../pm.json";
```

`store.ts` 和 `forms.ts` 认这些 symbol；其他生产代码不认。

### 改完后部署

```bash
cp D:/codex/provider-manager/{forms,components,ui,commands,store,sync,test,index}.ts \
   C:/Users/fcmeng/.pi/agent/extensions/provider-manager/
md5sum D:/codex/provider-manager/{forms,components,ui}.ts \
         C:/Users/fcmeng/.pi/agent/extensions/provider-manager/{forms,components,ui}.ts
```

---

## 关键不变量（保留时请注意）

1. **原子写** — 每次 `writeModelsJson` 做 tmp-write + 原子 rename，`.bak` 先取。**不要破坏这个**。
2. **写互斥** — `writeModelsJson` 之外的任何地方不要 `await writeFile`，否则破坏串行化。
3. **`ensureDefaultConfigFile` 是同步** — `pi -p` 模式进程立即退出，async 会被中断。同步是必要的，不要回退。
4. **dashboard `runForm` / `runSync` 用 try/finally** — Esc 中途取消也保证 dashboard 恢复。
5. **`q` / `s` 在 typeable 字段是字符** — 只在 non-typeable 字段拦截。否则 `apiKey="mysecret"` 输入到 s 触发保存。
6. **levelmap commit 归一化 7 keys** — `commitDraft` 总写 7 个 `PI_LEVELS`（未选的为 `null`）。
7. **sync `done` 直连 checklist 回调** — `onConfirm: (sel) => done(new Set(sel))` / `onCancel: () => done(undefined)`。包成 Promise 让 checklist 触不到会 hang。
8. **`ctx.ui.custom(...).catch` 必须 surface 错误** — `console.error` + `ctx.ui.notify("xxx error", "error")` 让用户区分 Esc 和框架崩溃。

---

## 已知限制 / non-goals

- **不管理内置 provider** — 只读/写 `models.json`
- **不切换 model** — 用户用 pi 内置 `/model`（Ctrl+L）
- **不提供登录 UI** — API key 以明文存 `models.json`（文件 0o600）
- **并发流不安全** — 互斥锁覆盖 I/O 但不覆盖读改写；编程调用不安全
- **无多语言** — 代码混用中英文 `ctx.ui.notify`；上线前选一种
- **`s` / `T` footer 总是显示** — 即使没选 provider
- **dashboard `s` 键** — 只在 form editor 内有意义，不在 dashboard 本身

---

## 各文件 API surface

| 文件 | 导出 | 用途 |
|---|---|---|
| `index.ts` | `default function (pi: ExtensionAPI)` | 入口 |
| `commands.ts` | `registerCommands(pi)` | 注册 `/providers` 及其子命令 |
| `ui.ts` | `Dashboard`（类）、`openDashboard(ctx)` | TUI 仪表盘 |
| `forms.ts` | `addProviderFlow`、`editProviderFlow`、`deleteProviderFlow`、`addModelFlow`、`editModelFlow`、`deleteModelFlow`、`restoreFromBackupFlow`、`syncFlow`；`DEFAULT_MODEL_CONFIG`、`getDefaultModelConfigPath`、`ensureDefaultConfigFile`、`loadDefaultModelConfig` | 业务流 + 配置 |
| `components.ts` | `matchesKey`、`FormEditor`、`ModelChecklist`、`PI_LEVELS`、`FormField`、`FormFieldType` | TUI 积木 |
| `store.ts` | `getModelsJsonPath`、`getBackupPath`、`readModelsJson`、`writeModelsJson`、`restoreBackup`、`backupExists`、`validateProvider`、`validateModel`、`validateAll`、`ModelConfig`、`ProviderConfig`、`ModelsJson`、`ALLOWED_APIS`、`ApiType` | models.json I/O + 类型 + 校验 |
| `sync.ts` | `fetchListing`、`inferModel`、`inferReasoning`、`inferInput`、`diffModels`、`isNoise`、`SyncPreset`、`FetchedModel`、`FetchResult`、`ApiKind` | 远端 model 拉取 + 启发式 |
| `test.ts` | `testModel`、`testProvider`、`getCached`、`clearCache`、`TestResult`、`CheckResult`、`TestMode` | 可用性探测 + 缓存 |
