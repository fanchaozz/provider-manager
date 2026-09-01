# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-09-01

### Added
- **恢复 addModelFlow 手动新增 model**：sync 拉不到上游（离线 / 私有部署 / 不支持 `/models`）时，仪表盘 Model 面板按 `n` 可手动新增。流程：先问 "Use default config?"，yes 套 `~/.pi/agent/provider-manager.json#defaultModel` 模板（含 `compat.supportsDeveloperRole:false` 不丢），no 逐项提示。id 重复 / 非法留在表单里提示。
- `getSyncViewportSize()` 读 `~/.pi/agent/provider-manager.json#syncViewportSize`，越界返 null。
- 新增 `_test_checklist_filter.mts` 12 个 case 覆盖视口 / 搜索 / wrap / config。

### Fixed
- **sync 拿到的 model 丢 compat 默认**：inferModel 没拷默认 compat，导致新加的 model 省略 `compat.supportsDeveloperRole:false` 默认项（Zhipu GLM 等需 false 的 provider 会话时会被默认按 pi 原生走 developer role、引发 422）。sync 后生效路径是写进 models.json，下次不重新 sync 不会自动补上—用户需重 sync 或手动 edit。
- **sync 全部 uncheck + Enter 不清空 provider.models**：原代码遇到 `finalModels.length === 0` 就当作 “Sync cancelled” 走早返、不写盘。预期是 Enter 总是提交：uncheck 全部 = 清空该 provider 下所有 model；只有 Esc 才取消。

### Changed
- **Sync checklist 重做，对齐 pi 的 `/models` 列表**。model 100+ 时也能顺畅选择。
  - **始终可见的 search 输入框**：顶部 `> ` 提示 + 输光标。所有可打印字符（a / i / g / G 等）都进 search，不作快捷键。
  - **视口滚动**：默认 8 行可见。`syncViewportSize` 覆盖（5-200，越界走默认）。
  - **钉住首项**：cursor 滚出首页后顶部仍钉住 `m000 (top)`，并打 `⋮ N hidden` 说明隐藏多少。
  - **wrap-around 导航**：`↑` / `↓` 顶部 / 底部循环；`j` / `k` 等价。
  - **Space toggle**：filter 状态下也作用于当前项。
  - **顶部 `selected / total selected`** 保持。
  - **底部 `(current/total)`** 位置指示。

### Removed
- 旧的 `g` / `G` / `a` / `i` 快捷键（与 search 输入冲突）。`j` / `k` 保留为 ↑ / ↓ 的别名。
- 旧的 `/` filter 模式开关（search 现在始终可见）。

## [0.2.3] - 2026-08-27

### Fixed
- 修复 `~/.pi/agent/models.json` 为空时 dashboard 无法新增 provider 的问题：原来 `n` 键的处理在导航 if/else 链之外、且被 `if (items.length === 0) { /* noop */ }` 吞掉，导致无 provider 时按 `n` 毫无反应。现已将 `n` 上移到导航判定之前，并补全 `pane === "model"` 时的提示。
- 空 providers 状态下底部键位提示改为 `n add first provider · ? help · q close`，去掉 `↑↓/jk nav` / `Enter edit` / `d del` / `t test` 等在空态无意义的项。
- 新增 `_test_empty_state.mts` 覆盖空态渲染与 `n` 触发表单的路径。

## [0.2.2] - 2026-08-27

### Fixed
- 模型测试结果通知统一 info 级别：成功/失败均被后续输出覆盖，失败信息不再滞留聊天历史
- 批量测试（`T` / `/providers test-all`）将全部模型结果合并为单条消息展示，逐模型成败一目了然

## [0.2.1] - 2026-08-27

### Fixed
- 修复 Zhipu GLM 422：新增模型 `compat.supportsDeveloperRole` 字段（edit 表单可改，默认 `no`），退回 `system` role

## [0.2.0] - 2026-08-26

### Changed
- **Unified view/edit form model** — all fields (including `text` / `secret` / `number` / `json`) require `Enter` to enter edit mode before changes. View mode rejects all character input. Eliminates the 0.1.x ambiguity where `s` / `q` inside typeable fields acted as save/cancel.
- **Dashboard key changes**: `e` → `Enter` (edit); `Tab` → `←` / `→` (switch panes). The model pane's `n` is removed.
- **form-based `addProviderFlow`** — `id` lives in the FormEditor too, structurally identical to `editProviderFlow`. Errors (duplicate id, invalid charset) show in the form's own `⚠ ...` line, not via a popup.

### Added
- **`proxy` field on provider** — sync uses `HTTPS_PROXY` / `HTTP_PROXY` env vars (restored after the request).
- **sync uses `loadDefaultModelConfig()`** — reads the `defaultModel` template from `~/.pi/agent/provider-manager.json` instead of always using the code default.
- **apiKey pre-flight** in `fetchListing` — rejects apiKeys with characters whose code > 255 (`•`, CJK, emoji, etc.) with an actionable error message.
- **Dashboard UI enhancements** — title bar with stats, column headers/underlines, detail panel grouped into `Identity` / `Endpoint` / `Auth` / `Capabilities` / `Limits` / `Thinking levels` / `Cost`, thinking levels shown as a single-line comma-separated list of enabled names.
- **Local apiKey status** in the dashboard — self-checks the `apiKey` field in `models.json` (no longer asks pi's runtime, which had multi-path OAuth/env/extension confusion). Reports `set` / `empty` / `$ENV` / `!command`.

### Fixed
- **Secret field two-layer protection** — entering edit restores the draft to the real value (so the user sees and edits the actual key, not the mask); `commitDraft` skips the write when the draft is unmodified (so the original key stays intact). Re-opening the edit form can no longer clobber the real key with the masked display.
- **Dashboard alignment** — header arrows (`▸` / `  `) now match the row prefix in each pane (active pane uses `▸`, inactive uses 2 spaces, never mixed).
- **Truncate ANSI correctly** — `truncateToWidth` no longer counts ANSI escape sequences as visible width (header lines are no longer cut off mid-word).

### Removed
- `addModelFlow` and `/providers model <pid> add` subcommand — models can only be added/removed via sync.
- Dead code: unused `addModelFlow` import in `ui.ts`, `isNoise` / `FetchedModel` imports in `forms.ts`, `INPUT_OPTIONS` / `THINKING_PRESETS` constants, unused `defaultValue` parameter in `askConfirm`, unused `let body: any` in `fetchListing`.

## [0.1.1] - 2026-08-26

### Added
- `pi-package` keyword in `package.json` for the [pi.dev](https://pi.dev) gallery crawl.
- `pi.extensions` declaration pointing at the package root.

## [0.1.0] - 2026-08-26

### Added
- Initial release.
- TUI dashboard (`/providers`) with two panes (Providers / Models), inline detail, help overlay, and a 13-test, 458-assertion unit test suite.
- `/providers` slash command with subcommands: `ls` (with filter), `add`, `remove`, `sync` (interactive checklist), `test` / `test-all` (auth + reachability + 1-shot generation probe), `reset` (restore from `.bak`), `help`.
- Shared `FormEditor` TUI component (`components.ts`) with `text` / `secret` / `number` / `json` / `select` / `multiselect` / `levelmap` / `readonly` field types and unified key bindings.
- `ModelChecklist` component for the sync picker.
- Sync flow — fetches `{baseUrl}/models` (OpenAI-compat or Google Generative AI), filters noise, heuristically infers `reasoning` / `input` from model id.
- Atomic write + auto-backup (`models.json.bak`) + write mutex in `store.ts`.
- User-level config `~/.pi/agent/provider-manager.json` auto-created on first load with `DEFAULT_MODEL_CONFIG` (reasoning / input / contextWindow / maxTokens / thinkingLevelMap).
- Bilingual README (English + Simplified Chinese).
