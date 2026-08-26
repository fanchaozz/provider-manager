# provider-manager

A pi extension that manages custom providers and models in `~/.pi/agent/models.json` through a TUI dashboard, a `/providers` slash command, and a sync-from-remote flow.

> **Scope**: only `models.json` is covered — the extension does **not** manage built-in providers, does **not** switch models, and does **not** provide a login UI. Use pi's built-in `/model` and provider auth flow for those.

---

## Install

`provider-manager` is intended to ship as a pi extension package. From the pi project root:

```bash
pi install npm:provider-manager       # or local path during development
```

The extension requires `@earendil-works/pi-coding-agent` (provided by pi). jiti resolves `node_modules` upward, so no separate `npm install` is needed inside the extension directory.

After install, `~/.pi/agent/provider-manager.json` is auto-created on first load (see [User config](#user-config--provider-managerjson)). Delete it to fall back to the code default.

---

## File layout

```
D:/codex/provider-manager/                ← repo / dev root
├── index.ts          ( 18)  Entry: registers commands, calls ensureDefaultConfigFile
├── commands.ts       (313)  /providers command + subcommand dispatch
├── ui.ts             (643)  Dashboard TUI component (panels, help, key handlers)
├── forms.ts          (622)  All business flows + default model config + user-level config loader
├── components.ts     (696)  Reusable TUI components: FormEditor, ModelChecklist, key matcher
├── store.ts          (282)  models.json I/O: read/write/backup/restore/validate (atomic + mutex)
├── sync.ts           (253)  Remote model fetch + heuristic field inference + diff/merge
├── test.ts           (354)  model availability probe: auth + reachable + 1-shot generation
└── _test_*.mts              Unit tests (run via `node --experimental-strip-types`)

C:/Users/fcmeng/.pi/agent/extensions/provider-manager/  ← deployed copy (md5-identical to repo)
```

---

## Commands

All commands are registered under `/providers` (see `commands.ts`).

| Subcommand | Action | Required TUI? |
|---|---|---|
| `/providers` (no args) | Open the TUI dashboard | yes |
| `/providers ls [filter]` | List custom providers (id, displayName, model count, [reasoning][vision] flags) | no |
| `/providers add [<id>]` | Open the add-provider form | yes |
| `/providers remove <id>` | Confirm + delete provider | yes |
| `/providers model <pid> add` | Open the add-model form for the given provider | yes |
| `/providers sync [<pid>]` | Fetch remote model list, show merge checklist, write back | yes |
| `/providers test` / `test-all` | Probe the selected model / all models in the selected provider | yes |
| `/providers reset` | Restore `models.json` from `models.json.bak` (with confirm) | yes |
| `/providers help` | Print help | no |

Argument completions: `ls`, `add`, `remove`, `sync`, `test`, `test-all`, `reset`, `help`.

---

## Dashboard

`/providers` opens a two-pane TUI (`ui.ts:Dashboard`):

- **Left pane** — providers (id + model count)
- **Right pane** — models of the currently selected provider (id + [R][I] flags + ctx / max)
- **Detail strip** — raw JSON of the selected row
- **Footer** — current key bindings

### Key bindings

| Key | Action |
|---|---|
| `↑↓` / `j k` | Navigate in current pane |
| `g` / `G` | Jump to top / bottom |
| `Tab` | Switch between Providers ↔ Models pane |
| `n` | New: add provider on Providers pane, add model on Models pane |
| `e` | Edit selected provider / model |
| `d` | Delete (with confirm dialog) |
| `y` | Sync (fetch remote model list for selected provider) |
| `t` / `T` | Test selected model / all models in selected provider |
| `?` | Toggle help overlay |
| `q` / `Esc` | Close dashboard |

When the provider list is empty, pressing `n` on the Models pane switches to the Providers pane and notifies you to create one first.

---

## Form editor

`/providers add`, `/providers remove`, `/providers model <pid> add`, edit (e), and sync (y) all open the same TUI form component (`components.ts:FormEditor`).

### Form fields

| Type | Behavior |
|---|---|
| `text` | Free text input |
| `secret` | Free text, rendered masked in the TUI |
| `number` | Free numeric input, validated on commit |
| `select` | Options list; press `e` to enter edit mode, `Space` to pick, `↑↓`/`jk` to navigate, `Enter` to commit |
| `multiselect` | Like select but multiple values; `Space` toggles each |
| `levelmap` | 7 rows (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`); `Space` toggles each; commit normalizes missing keys to `null` |
| `readonly` | Display only, cannot edit |

### Form key bindings

| Key | Behavior |
|---|---|
| `e` / `E` | Enter edit mode (only on `select` / `levelmap` / `multiselect`) |
| `Esc` / `q` | If editing: exit edit (commit current value). Otherwise: cancel the form |
| `s` | Save the whole form (commit draft + write). Only on non-typeable fields — `s` is a literal char inside `text`/`secret`/`number`/`json` |
| `Enter` | If editing on a non-input field: commit and exit edit. On a typeable field: commit + move to next field. On a readonly field: save the form |
| `Space` | If editing on a non-input field: toggle current option |
| `↑↓` / `j k` | Navigate fields; inside edit mode of a non-input field: navigate options |
| `Backspace` | Delete last char (typeable fields) |

### `Use default config?` (new-model only)

`addModelFlow` asks once after `name`:

- Yes → applies `DEFAULT_MODEL_CONFIG` (see [User config](#user-config--provider-managerjson)) and skips the remaining questions
- No → asks reasoning, input, ctx, max, thinkingLevelMap one by one

---

## Sync flow

`syncFlow` (in `forms.ts`) fetches the remote model list for the selected provider and shows a checklist. The behavior:

- The checklist **shows every model in the provider** (both existing and remote new)
  - existing models: label `<id>  (existing)`, hint `uncheck to remove`, **default checked**
  - remote new models: label `<id>`, hint `reasoning=… input=… ctx=…`, **default unchecked**
- User unchecks models to drop, checks new models to add
- Press `Enter` to confirm, `Esc` to cancel (no changes)
- On save, the final `models.json` is the union of:
  - existing models that were checked
  - new (remote) models that were checked
  - remote new is preferred over local if both checked (to pick up the fresh `reasoning/input/ctx/max/thinkingLevelMap` from `DEFAULT_MODEL_CONFIG`)

If 0 models are checked, the sync is a no-op (with a notify).

---

## Store layer (`store.ts`)

All reads/writes of `~/.pi/agent/models.json` go through `store.ts`.

- **Atomic write** — every `writeModelsJson(next, opts)` does:
  1. `copyFile` current `models.json` → `models.json.bak` (unless `opts.backup === false`)
  2. `writeFile` to `models.json.tmp`
  3. `rename` `models.json.tmp` → `models.json`
  4. `chmod 0o600` (no-op on Windows)
- **Write mutex** — a module-level `writeChain: Promise<void>` serializes all writes; one failure doesn't poison the chain
- **Validation** — `validateProvider` / `validateModel` / `validateAll` check types and required fields
- **Path overrides** (for tests) — `Symbol.for("pi-provider-manager:models-path-override")` and `…backup-path-override`

> **Caveat**: the mutex serializes file I/O but **not** the read-modify-write pattern that every flow uses. Two concurrent flows can lose data. Single-user CLI is safe; programmatic invocation is not.

---

## Sync fetch layer (`sync.ts`)

`sync.ts` provides:

- `fetchListing({ baseUrl, apiKey, apiKind, signal, timeoutMs })` — calls `GET {base}/models` for both OpenAI-compat (`{ data: [...] }`) and Google Generative AI (`{ models: [{ name, ... }] }`). Filters noise (`embed`, `tts`, `whisper`, `dall-e`, `clip`, `moderation`, `image-*`).
- `inferReasoning(id)` / `inferInput(id)` — name-based heuristics (`o1`/`reasoning`/`thinking`/`deepseek-r`/etc → `reasoning: true`; `vision`/`gpt-4`/`claude`/`gemini` → `input: ["text","image"]`)
- `inferModel(id, fetched, overrides?)` — produces a `ModelConfig`; default `contextWindow: 128000`, `maxTokens: 16384`, `thinkingLevelMap.medium = "medium"` (others `null`). Honors `overrides.defaults` from `loadDefaultModelConfig`.
- `diffModels(fetched, existing, overrides?)` — splits fetched into `toAdd` (new) and `skipped` (noise)

`THINKING_PRESETS` is exported from `forms.ts` (5 options including Custom JSON entry) and used in `addModelFlow` only (sync no longer asks the user — it applies defaults).

---

## Test layer (`test.ts`)

`t` / `T` in the dashboard call `testModel` / `testProvider` from `test.ts`. Each model probe has three checks:

| Check | What it does | Cost |
|---|---|---|
| `auth` | `ctx.modelRegistry.getProviderAuthStatus(provider)` | 0 |
| `reachable` | `GET {base}/models` (or Google endpoint) with 10s timeout | 0 |
| `generated` | `ctx.modelRegistry.complete(model, ctx, { signal, maxTokens: 4 })` with prompt `"Reply with the single word: ok"` | ≤ 4 tokens |

Hard cap: `maxTokens` is clamped to 16 (regardless of caller input). 10s timeout (configurable via `PI_PROVIDER_TEST_TIMEOUT` env var). `stopReason === "stop" | "length"` counts as success.

Results are cached in-process in a `Map<"${provider}/${modelId}", TestResult>`. Use `getCached` / `clearCache` from tests.

---

## User config — `provider-manager.json`

On every pi startup, `ensureDefaultConfigFile` synchronously writes a default `provider-manager.json` to `~/.pi/agent/provider-manager.json` if it doesn't exist. The file controls the defaults used by `addModelFlow` ("Use default config? yes" path) and `syncFlow` (new model fields).

### Schema

```jsonc
{
  "_defaultModel": "free-form comment, ignored at runtime",
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

### Validation rules

- `reasoning`: must be boolean
- `input`: must be non-empty array of `"text"` and/or `"image"`
- `contextWindow` / `maxTokens`: must be positive finite numbers
- `thinkingLevelMap`: must be an object (any subset of the 7 keys; missing keys are treated as `null`)

If the file is missing, malformed JSON, or fails any check, `loadDefaultModelConfig` silently falls back to the code default and logs a warning to `console`.

### Path override (for tests)

`Symbol.for("pi-provider-manager:default-model-path-override")` redirects the path used by `getDefaultModelConfigPath`.

---

## Code default (`DEFAULT_MODEL_CONFIG` in `forms.ts`)

When `provider-manager.json` is missing or invalid, the code uses:

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

## Development

### Run all tests

```bash
cd D:/codex/provider-manager
for f in _test_*.mts; do
  echo "=== $f ==="
  node --experimental-strip-types --no-warnings "$f" 2>&1 | tail -3
done
```

`node --experimental-strip-types` strips TypeScript types at runtime; it does **not** type-check. So `import type { Foo }` is required for any types that are erased but not transitively reachable.

The 13 test files cover:

- `forms.ts` exports: `addProviderFlow` / `editProviderFlow` / `deleteProviderFlow` / `addModelFlow` / `editModelFlow` / `deleteModelFlow` / `restoreFromBackupFlow` / `syncFlow` / `ensureDefaultConfigFile` / `loadDefaultModelConfig`
- `components.ts`: `FormEditor` (all key paths, levelmap, multiselect, s/Esc/Enter gating) and `ModelChecklist`
- `ui.ts`: `Dashboard` key handling, `runForm` / `runSync` / `runTest` (`__test = true` static flag enables unit-test invocation)
- `sync.ts`: `fetchListing` / `inferModel` / `diffModels` / `isNoise` / `inferReasoning` / `inferInput` with a mock `fetch` and a mock `ctx`
- `store.ts`: read/write/backup/restore/validate paths
- End-to-end audit (`_test_audit_endtoend.mts`): 25 cross-flow assertions including the new merge semantics, default-keep behavior, `s` / `Esc` / customSelect scenarios, ensureDefaultConfigFile idempotency, sync error handling

### Path overrides (test setup)

```ts
(globalThis as any)[Symbol.for("pi-provider-manager:models-path-override")] = "/tmp/.../models.json";
(globalThis as any)[Symbol.for("pi-provider-manager:backup-path-override")] = "/tmp/.../models.json.bak";
(globalThis as any)[Symbol.for("pi-provider-manager:default-model-path-override")] = "/tmp/.../pm.json";
```

`store.ts` and `forms.ts` honor these symbols; no other production code does.

### Deploy after change

```bash
cp D:/codex/provider-manager/{forms,components,ui,commands,store,sync,test,index}.ts \
   C:/Users/fcmeng/.pi/agent/extensions/provider-manager/
md5sum D:/codex/provider-manager/{forms,components,ui}.ts \
         C:/Users/fcmeng/.pi/agent/extensions/provider-manager/{forms,components,ui}.ts
```

---

## Key invariants (worth preserving)

1. **Atomic write** — every `writeModelsJson` does tmp-write + atomic rename, with `.bak` taken first. Never break this.
2. **Write mutex** — `writeChain` in `store.ts` is the only thing that prevents concurrent clobber. Don't add `await writeFile` outside `writeModelsJson`.
3. **No async in `ensureDefaultConfigFile`** — sync (`writeFileSync`) is required so `pi -p` mode doesn't exit before the file is created. Don't revert to async.
4. **try/finally in dashboard `runForm` / `runSync`** — `onDone?.()` is called in `finally` so the dashboard is always restored after form flow exit, including early Esc-cancel.
5. **`q` / `s` are literal chars in typeable fields** — only intercept them outside `text`/`secret`/`number`/`json`. Otherwise `apiKey="mysecret"` saves on the `s`.
6. **Levelmap commit normalizes to 7 keys** — `commitDraft` always writes all 7 `PI_LEVELS` (with `null` for unselected). Don't bypass this in `toggleLevelmapRow`.
7. **Sync `done` is wired directly to checklist callbacks** — `onConfirm: (sel) => done(new Set(sel))` / `onCancel: () => done(undefined)`. Wrapping in a Promise that the checklist can't reach causes the dialog to hang.
8. **`ctx.ui.custom(...).catch` must surface errors** — `console.error` + `ctx.ui.notify("xxx error", "error")` so the user can distinguish Esc from a framework crash.

---

## Known limitations / non-goals

- **No built-in provider management** — only `models.json` is read or written
- **No model switching** — the user uses pi's built-in `/model` (Ctrl+L) for that
- **No login UI** — API keys are stored as plain text in `models.json` (file is 0o600)
- **No concurrent-flow safety** — the write mutex covers I/O but not the read-modify-write pattern; programmatic invocation is not safe
- **No multi-locale** — the codebase mixes Chinese and English in `ctx.ui.notify` calls; pick one before shipping
- **`s` / `T` footer entries always shown** — even when no provider is selected; cleanup UX is a follow-up
- **Dashboard `s` key** — only meaningful inside the form editor, not the dashboard itself; add a footer note or hide when not in form context

---

## File-by-file API surface

| File | Exports | Purpose |
|---|---|---|
| `index.ts` | `default function (pi: ExtensionAPI)` | Entry point |
| `commands.ts` | `registerCommands(pi)` | Wires `/providers` and its subcommands |
| `ui.ts` | `Dashboard` (class), `openDashboard(ctx)` | TUI dashboard |
| `forms.ts` | `addProviderFlow`, `editProviderFlow`, `deleteProviderFlow`, `addModelFlow`, `editModelFlow`, `deleteModelFlow`, `restoreFromBackupFlow`, `syncFlow`; `DEFAULT_MODEL_CONFIG`, `getDefaultModelConfigPath`, `ensureDefaultConfigFile`, `loadDefaultModelConfig` | Business flows + config |
| `components.ts` | `matchesKey`, `FormEditor`, `ModelChecklist`, `PI_LEVELS`, `FormField`, `FormFieldType` | TUI building blocks |
| `store.ts` | `getModelsJsonPath`, `getBackupPath`, `readModelsJson`, `writeModelsJson`, `restoreBackup`, `backupExists`, `validateProvider`, `validateModel`, `validateAll`, `ModelConfig`, `ProviderConfig`, `ModelsJson`, `ALLOWED_APIS`, `ApiType` | models.json I/O + types + validation |
| `sync.ts` | `fetchListing`, `inferModel`, `inferReasoning`, `inferInput`, `diffModels`, `isNoise`, `SyncPreset`, `FetchedModel`, `FetchResult`, `ApiKind` | Remote model fetch + heuristics |
| `test.ts` | `testModel`, `testProvider`, `getCached`, `clearCache`, `TestResult`, `CheckResult`, `TestMode` | Availability probe + cache |
