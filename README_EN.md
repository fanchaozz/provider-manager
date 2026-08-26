# provider-manager

[English](./README_EN.md) | [简体中文](./README.md)

A pi extension that manages custom providers and models in `~/.pi/agent/models.json` through a TUI dashboard, a `/providers` slash command, and a remote model sync.

> **Scope**: only `models.json` is covered — the extension does **not** manage built-in providers, does **not** switch models, and does **not** provide a login UI. Use pi's built-in `/model` and provider auth flow for those.

---

## Install

```bash
pi install npm:@fanchaozz/provider-manager
```

The package is hosted on **npmjs.com**. `pi install` queries npmjs by default, so no extra config is required.

### If you can't reach npmjs / want a development build

```bash
git clone https://github.com/fanchaozz/provider-manager.git
ln -s "$(pwd)/provider-manager" ~/.pi/agent/extensions/provider-manager
# Windows: mklink /D "%USERPROFILE%\.pi\agent\extensions\provider-manager" "%CD%\provider-manager"
# or: cp -r provider-manager ~/.pi/agent/extensions/
```

Or from your pi project root: `pi install /path/to/provider-manager`.

The extension depends on `@earendil-works/pi-coding-agent` (shipped with pi). jiti walks up `node_modules`, so **no `npm install` is needed** inside the extension directory.

After install, `~/.pi/agent/provider-manager.json` is auto-created on first load (see [User config](#user-config--provider-managerjson)). Delete it to fall back to the code default.

---

## Quick start

| Want to… | Do this |
|---|---|
| Open the dashboard | `/providers` |
| List providers + their models | `/providers ls` (filter: `/providers ls kdapi`) |
| Add a provider | Dashboard, `n` on the Providers pane, or `/providers add [<id>]` |
| Add a model | Dashboard, switch to Models pane with `Tab`, `n`, or `/providers model <pid> add` |
| Edit provider / model | Dashboard, `e` |
| Delete | Dashboard, `d` (confirm dialog) |
| Pull new model list from a provider's API | Dashboard, `y`, or `/providers sync [<pid>]` |
| Probe auth + reachability + a 1-token test call | Dashboard, `t` (current model) or `T` (all in provider) |
| Restore last `.bak` | `/providers reset` |
| Print command help | `/providers help` |
| Close dashboard | `q` or `Esc` |

The sync command is the fastest way to populate a fresh provider: it fetches the remote model list, shows a checklist, and writes back the ones you select.

---

## Dashboard

`/providers` opens a two-pane TUI:

- **Left pane** — providers (id + model count)
- **Right pane** — models of the selected provider (id + `[R]` reasoning / `[I]` image flags + ctx / max)
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
| `t` / `T` | Probe current model / all models in selected provider |
| `?` | Toggle help overlay |
| `q` / `Esc` | Close dashboard |

When the provider list is empty, pressing `n` on the Models pane switches to the Providers pane and tells you to create one first.

---

## Sync flow

`sync` is the fastest way to add a batch of models. It fetches the remote model list for the selected provider and shows a checklist.

The checklist **shows every model for that provider — both existing and remote new**:

- Existing models are labelled `<id>  (existing)`, default checked. Uncheck to delete.
- Remote new models are labelled `<id>` only, default unchecked. Check to add.

Press `Enter` to write the result, `Esc` to cancel. On save, the final `models.json` is the union of (checked existing) + (checked new); remote new is preferred over local if both are checked (so you pick up the fresh `reasoning` / `input` / `ctx` / `maxTokens` / `thinkingLevelMap` from the default model config).

---

## User config — `provider-manager.json`

`~/.pi/agent/provider-manager.json` controls the defaults used when:
- you answer "yes" to "Use default config?" in the new-model form
- you sync new models from a remote API

Auto-created on first launch. Delete to revert to code defaults.

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

### Field rules

- **`reasoning`** — boolean. If `true`, the model supports extended thinking and `thinkingLevelMap` applies.
- **`input`** — non-empty array of `"text"` and/or `"image"`. `"text" | "image"` means the model accepts that modality.
- **`contextWindow`** / **`maxTokens`** — positive integers (tokens).
- **`thinkingLevelMap`** — object. Any subset of the 7 keys (`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`). A `string` value (e.g. `"medium"`) means that thinking level is enabled and the string is sent to the provider; `null` means disabled. Missing keys are treated as `null`.

If the file is missing, malformed JSON, or fails any check, the extension silently falls back to the built-in defaults shown above.

### Why `medium` is highlighted by default

When a synced model has `reasoning: true` and `thinkingLevelMap.medium = "medium"`, pi's Shift+Tab thinking-level cycle lands on `medium` by default. Pick whichever level your upstream actually supports — `null` is fine for providers with no extended-thinking knob.

---

## Form editor (new model / edit model / new provider)

`addProviderFlow` / `editProviderFlow` / `addModelFlow` / `editModelFlow` / `deleteProviderFlow` / `deleteModelFlow` all share one TUI form (`components.ts:FormEditor`).

### Field types

| Type | Behavior |
|---|---|
| `text` | Free text input |
| `secret` | Free text, rendered masked in the TUI |
| `number` | Free numeric input, validated on commit |
| `select` | Options list; press `e` to enter edit mode, `Space` to pick, `↑↓`/`jk` to navigate, `Enter` to commit |
| `multiselect` | Like `select` but multiple values; `Space` toggles each |
| `levelmap` | 7 rows (`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`); `Space` toggles each; commit normalizes missing keys to `null` |
| `readonly` | Display only, cannot edit |

### Key bindings

| Key | Behavior |
|---|---|
| `e` / `E` | Enter edit mode (only on `select` / `levelmap` / `multiselect`) |
| `Esc` / `q` | If editing: exit edit (commit current value). Otherwise: cancel the form |
| `s` | Save the whole form. Only on non-typeable fields — `s` is a literal char inside `text` / `secret` / `number` / `json` |
| `Enter` | If editing on a non-input field: commit and exit edit. On a typeable field: commit + move to next field. On a readonly field: save the form |
| `Space` | If editing on a non-input field: toggle current option |
| `↑↓` / `j k` | Navigate fields; inside edit mode of a non-input field: navigate options |
| `Backspace` | Delete last char (typeable fields) |

### New-model flow: "Use default config?"

`addModelFlow` asks once after the name:

- **Yes** — apply `DEFAULT_MODEL_CONFIG` (see [User config](#user-config--provider-managerjson)) and skip the remaining questions
- **No** — ask reasoning / input / ctx / max / thinking-level-map one by one

`Esc` at any prompt cancels the whole flow (the dashboard is restored automatically).

---

## Test a model (`t` / `T`)

`t` probes the current model; `T` probes all models in the current provider. Three checks per model:

| Check | What it does | Cost |
|---|---|---|
| `auth` | Looks up `~/.pi/agent/auth.json` (or env) for the provider's API key | free |
| `reachable` | `GET {baseUrl}/models` with a 10 s timeout | free |
| `generated` | Sends a 4-token prompt (`"Reply with the single word: ok"`) and checks `stopReason ∈ {stop, length}` | ~4 tokens |

Hard caps: `maxTokens` is clamped to 16, timeout 10 s (override with `PI_PROVIDER_TEST_TIMEOUT` env var in seconds). Result is cached in-process until you restart pi.

---

## File layout

```
~/.pi/agent/
├── models.json              ← the file this extension edits
├── models.json.bak          ← automatic backup taken before every write
└── extensions/
    └── provider-manager/    ← this extension (installed via pi install / git clone)
```

The extension does not touch anything outside `models.json` and `models.json.bak`. To roll back, restore from `.bak` with `/providers reset` or manually:

```bash
cp ~/.pi/agent/models.json.bak ~/.pi/agent/models.json
```

---

## Troubleshooting

**`pi install` fails with `E404` or "no such package".** The npm registry doesn't have this package. First run `npm view @fanchaozz/provider-manager` to confirm the publish succeeded; if it has, check `npm config get registry` is not `npm.pkg.github.com`.

**Dashboard opens but is empty.** Your `models.json` has no custom providers. The extension only manages `models.json` — built-in pi providers (anthropic / openai / google / …) are not shown. Use pi's built-in `/model` for those.

**Sync errors with `ECONNREFUSED` / `ENOTFOUND`.** The selected provider's `baseUrl` is unreachable. Edit it with `/providers edit <pid>` (or dashboard `e`).

**Sync errors with `HTTP 500` / `HTTP 401`.** Wrong `baseUrl` or missing / wrong `apiKey`. Verify in the provider edit form.

**A thinking level I set keeps disappearing.** pi may not support that level on the underlying model — try a different level, or set it to `null` to disable.

**All my customizations in `provider-manager.json` are ignored.** The file is malformed or fails validation (see [Schema](#schema)). The extension falls back to defaults silently. Validate with `node -e "JSON.parse(require('fs').readFileSync(process.env.HOME+'/.pi/agent/provider-manager.json','utf8'))"`.

**Models added by sync show wrong fields (`ctx=128000` regardless).** The model is using defaults, not the file. The file isn't being read. Check file path: should be exactly `~/.pi/agent/provider-manager.json` (not `~/.pi/agent/providers.json` or similar).

**Dashboard disappears after pressing `n` / `e` / `d` / `y` and Esc.** Should not happen in the current version — the dashboard is restored automatically. If it does, please report with `~/.pi/agent/provider-manager.log` output.

---

## Related

- pi's built-in `/model` — switch the active model
- pi's built-in provider auth (`/login` or env vars) — set up API keys
- Backup flow: `/providers reset` or `cp ~/.pi/agent/models.json.bak ~/.pi/agent/models.json`
