# DEVELOP — maintainer notes

This file is for the **maintainer** of `provider-manager` (currently `fanchaozz`). End-user documentation lives in [README.md](./README.md) and [README_EN.md](./README_EN.md).

The end-user README must stay focused on **install + usage**. Anything that's "how to publish", "how to test the dev setup", or "what's in the package.json" belongs here, not in the user-facing README.

---

## Repository

- Source: https://github.com/fanchaozz/provider-manager (public)
- npm (planned): `@fanchaozz/provider-manager` — not published yet
- GitHub Packages: every GitHub Release triggers the publish workflow (see [`.github/workflows/publish.yml`](./.github/workflows/publish.yml))

## Test the dev setup

```bash
cd D:/codex/provider-manager
# node ESM cannot find packages by walking up; need local copy of pi's package
mkdir -p node_modules/@earendil-works
cp -r /d/Program/nvm/nodejs/node_modules/@earendil-works/pi-coding-agent node_modules/@earendil-works/

# Run all 13 _test_*.mts files
for f in _test_*.mts; do
  echo "=== $f ==="
  node --experimental-strip-types --no-warnings "$f" 2>&1 | tail -3
done
```

`node --experimental-strip-types` strips types at runtime; it does **not** type-check.

The 13 test files cover every exported function in `forms.ts` / `components.ts` / `ui.ts` / `sync.ts` / `store.ts` + a 25-assertion cross-flow audit (`_test_audit_endtoend.mts`).

### Test path overrides

```ts
(globalThis as any)[Symbol.for("pi-provider-manager:models-path-override")] = "/tmp/.../models.json";
(globalThis as any)[Symbol.for("pi-provider-manager:backup-path-override")] = "/tmp/.../models.json.bak";
(globalThis as any)[Symbol.for("pi-provider-manager:default-model-path-override")] = "/tmp/.../pm.json";
```

`store.ts` and `forms.ts` honor these. Production code does not.

## Deploy to pi's local extension dir

```bash
cp D:/codex/provider-manager/{forms,components,ui,commands,store,sync,test,index}.ts \
   C:/Users/fcmeng/.pi/agent/extensions/provider-manager/
md5sum D:/codex/provider-manager/{forms,components,ui}.ts \
         C:/Users/fcmeng/.pi/agent/extensions/provider-manager/{forms,components,ui}.ts
```

The deployed copy and repo source must be byte-identical. Verified at every release.

## Publish flow

### Path A: GitHub Packages (default, no 2FA)

Every GitHub Release triggers `.github/workflows/publish.yml`, which runs:

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with: { node-version: 20, registry-url: https://npm.pkg.github.com/ }
- run: npm publish
  env: { NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
```

`GITHUB_TOKEN` is auto-injected with `packages: write` scope on `release: published`. **No npm account or 2FA needed for the maintainer.** This is the only fully-automated path because npmjs.com deprecated bypass-2FA publish tokens in mid-2026.

To release:

1. Edit code, commit, push to `main`
2. `git tag v0.2.0 && git push --tags` (or use GitHub UI: Releases → "Draft a new release" → pick the tag → Publish)
3. Watch `.github/workflows/publish.yml` run on the Actions tab
4. Package appears at `https://github.com/fanchaozz/provider-manager/packages` (and as `npm install @fanchaozz/provider-manager` once a user adds the GitHub Packages registry to their `~/.npmrc`)

### Path B: npmjs.com (manual, requires 2FA)

```bash
cd D:/codex/provider-manager
npm login      # prompts for username / password / email / 2FA
npm publish --access public
```

Not recommended for routine releases because it requires interactive 2FA each time. The first publish also needs you to claim the `@fanchaozz` npm org if it doesn't exist yet.

## Repository conventions

- Branch: `main` (default), `master` redirects to `main`
- Author identity: `git config --local user.name "fanchaozz" && user.email "fanchaozz@users.noreply.github.com"`
  - **Use `--local`, not `--global**`: the user's global git config has their real name; local-only overrides keep personal identity out of the repo
- Commit messages: imperative mood, sentence-case prefix-free, ~70 chars subject + blank line + wrapped body
- History rewriting: only with explicit user consent (real names and sensitive info in the existing history)

## File layout (recap)

```
provider-manager/
├── index.ts          Entry: registers commands, calls ensureDefaultConfigFile
├── commands.ts       /providers command + subcommand dispatch
├── ui.ts             Dashboard TUI
├── forms.ts          All business flows + DEFAULT_MODEL_CONFIG + ensureDefaultConfigFile + loadDefaultModelConfig
├── components.ts     FormEditor, ModelChecklist, key matcher, PI_LEVELS
├── store.ts          models.json I/O (atomic + mutex + validation)
├── sync.ts           Remote model fetch + heuristic inference + diff/merge
├── test.ts           testModel / testProvider (auth + reachable + generated)
├── _test_*.mts        Unit tests (run via `node --experimental-strip-types`)
├── package.json      Scoped npm package (@fanchaozz/provider-manager)
├── .github/workflows/publish.yml    Auto-publish to GitHub Packages
├── README.md         User docs (zh)
├── README_EN.md      User docs (en)
└── DEVELOP.md        This file (maintainer-only)
```

## Key invariants (do not break)

1. **Atomic write** — every `writeModelsJson` does tmp-write + atomic rename, with `.bak` taken first
2. **Write mutex** — `writeChain` in `store.ts` is the only thing that serializes writes; never add `await writeFile` outside `writeModelsJson`
3. **`ensureDefaultConfigFile` is sync** — `writeFileSync`. `pi -p` mode exits before async resolves
4. **`runForm` / `runSync` use try/finally** — `onDone?.()` is called in `finally` so the dashboard is always restored, even on early Esc-cancel
5. **`q` / `s` are literal chars in typeable fields** — only intercept outside `text`/`secret`/`number`/`json`. Otherwise `apiKey="mysecret"` saves on the `s`
6. **Levelmap commit normalizes to 7 keys** — `commitDraft` always writes all 7 `PI_LEVELS` (with `null` for unselected)
7. **Sync `done` is wired directly to checklist callbacks** — `onConfirm: (sel) => done(new Set(sel))` / `onCancel: () => done(undefined)`
8. **`ctx.ui.custom(...).catch` must surface errors** — `console.error` + `ctx.ui.notify("xxx error", "error")` so the user can distinguish Esc from a framework crash
9. **All `.ts` source files import `ExtensionCommandContext`** from `@earendil-works/pi-coding-agent` — this is used 13+ times in `forms.ts` and is required at type-check time (jiti ignores but real type-checkers won't)

## Test discipline

When changing a form flow, **always** update `_test_forms.mts` and `_test_audit_endtoend.mts` (the cross-flow audit). The audit file is the canary for behavioral regressions.

When changing the dashboard (ui.ts), update `_test_ui.mts`. When changing the FormEditor or ModelChecklist (components.ts), update `_test_form_editor.mts` and `_test_form_editor_extras.mts`. The test files are intentionally not in the published `package.json` `files` list — they're dev-only.
