# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
