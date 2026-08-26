/**
 * forms.ts — TUI 表单流程
 *
 * 每个 flow 是一串 ctx.ui.input / ctx.ui.select / ctx.ui.confirm 调用，
 * 最后写盘 models.json + 通知用户。
 *
 * pi 实际 API（位置 string 参数，不是 object）：
 *   input(title, placeholder?, opts?)        -> Promise<string | undefined>
 *   select(title, options: string[], opts?)   -> Promise<string | undefined>
 *   confirm(title, message, opts?)            -> Promise<boolean>
 *
 * 与 LLM 工具（tools.ts）不共用——LLM 工具走自己的参数 schema。
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readModelsJson, writeModelsJson, backupExists, restoreBackup, type ModelsJson, type ProviderConfig, type ModelConfig, ALLOWED_APIS } from "./store.ts";
import { fetchListing, inferModel, isNoise, diffModels, type FetchedModel } from "./sync.ts";
import { ModelChecklist, FormEditor, type FormField } from "./components.ts";

// ============================================================================
// 共用 prompt helpers
// ============================================================================

// select 的 options 必须是 string[]，不能是 {label,value}。直接把 value 字符串化。
const API_OPTIONS: string[] = [
    ...ALLOWED_APIS,
    "(none / 由 model 字段指定)",
];
const INPUT_OPTIONS: string[] = ["text", "image (supports image)"];

/** thinking level 预设（避免用户手输 JSON）。
 *  null = 禁用该 level，string = 映射到 provider 那个字符串值。 */
const THINKING_PRESETS: { label: string; map: ModelConfig["thinkingLevelMap"] }[] = [
    { label: "（不设 / 用 provider 默认）", map: {} },
    { label: "Anthropic 风格 (low/medium/high/max → 同名 + off=null, minimal=null)", map: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: "max" } },
    { label: "OpenAI o1 风格 (low/medium/high → 同名 + off=null, minimal=null)", map: { off: null, minimal: null, low: "low", medium: "medium", high: "high" } },
    { label: "只暴露 high+max (其他全 null)", map: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" } },
    { label: "Custom (Enter 自填 JSON)", map: { __custom: true } as any },
];

/** 新 model 的默认配置。调 /providers model <pid> add 或 dashboard n 走 addModelFlow 时
 *  会问 "Use defaults?"，回答 yes → 套这里的所有值；回答 no → 逐个问。 */
export const DEFAULT_MODEL_CONFIG: {
    reasoning: boolean;
    input: ("text" | "image")[];
    contextWindow: number;
    maxTokens: number;
    thinkingLevelMap: ModelConfig["thinkingLevelMap"];
} = {
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 128000,
    maxTokens: 16384,
    thinkingLevelMap: {
        off: null,
        minimal: null,
        low: null,
        medium: "medium",   // 默认只勾 medium
        high: null,
        xhigh: null,
        max: null,
    },
};

// ============================================================================
// user-level override: ~/.pi/agent/provider-manager.json#defaultModel
// ============================================================================

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function getDefaultModelConfigPath(): string {
	const ov = (globalThis as any)[Symbol.for("pi-provider-manager:default-model-path-override")] as string | undefined;
	if (ov) return ov;
	return join(getAgentDir(), "provider-manager.json");
}

/**
 * If ~/.pi/agent/provider-manager.json does not exist, write current code DEFAULT_MODEL_CONFIG to it.
 * Existing file is left untouched. Returns path written or null.
 * 同步执行：index.ts 启动后立即调用；`pi -p` 模式进程会立即退出，async 会被中断。
 */
export function ensureDefaultConfigFile(): string | null {
	try {
		const p = getDefaultModelConfigPath();
		if (existsSync(p)) return null;
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, JSON.stringify({
			_defaultModel: "New model defaults used by /providers model <pid> add and dashboard n. When asked Use default config? answering yes applies these; no = per-field prompts. Edit then save -> next add picks up changes.",
			defaultModel: DEFAULT_MODEL_CONFIG,
		}, null, 2) + "\n", { mode: 0o600 });
		return p;
	} catch (err) {
		console.error(`[provider-manager] ensureDefaultConfigFile failed:`, err);
		return null;
	}
}

function isValidDefaultModelConfig(v: any): v is typeof DEFAULT_MODEL_CONFIG {
	return (
		v && typeof v === "object" &&
		typeof v.reasoning === "boolean" &&
		Array.isArray(v.input) && v.input.every((x: any) => x === "text" || x === "image") && v.input.length > 0 &&
		typeof v.contextWindow === "number" && v.contextWindow > 0 && Number.isFinite(v.contextWindow) &&
		typeof v.maxTokens === "number" && v.maxTokens > 0 && Number.isFinite(v.maxTokens) &&
		v.thinkingLevelMap && typeof v.thinkingLevelMap === "object" && !Array.isArray(v.thinkingLevelMap)
	);
}

/**
 * 加载 default model config：先读 ~/.pi/agent/provider-manager.json 的 defaultModel 字段，
 * 不存在或非法 → 走代码 DEFAULT_MODEL_CONFIG＋同步异常不崩＋
 */
export function loadDefaultModelConfig(): typeof DEFAULT_MODEL_CONFIG {
	try {
		const p = getDefaultModelConfigPath();
		if (!existsSync(p)) return DEFAULT_MODEL_CONFIG;
		const raw = readFileSync(p, "utf8");
		const parsed = JSON.parse(raw);
		const cfg = parsed?.defaultModel;
		if (isValidDefaultModelConfig(cfg)) return cfg;
	} catch {
		// 回退到代码默认
	}
	return DEFAULT_MODEL_CONFIG;
}

async function askInput(
    ctx: ExtensionCommandContext,
    opts: { message: string; placeholder?: string; secret?: boolean; defaultValue?: string; validate?: (s: string) => string | null },
): Promise<string | undefined> {
    // title 拼到 message 里（pi 只能传一个 string）
    let title = opts.message;
    if (opts.secret) title += "  (input hidden)";
    const result = await ctx.ui.input(title, opts.placeholder);
    if (result === undefined) return undefined;  // Esc 取消
    const trimmed = result.trim();
    // 空输入 + 有 defaultValue → 保留原值（empty = keep）
    if (trimmed === "" && opts.defaultValue !== undefined) {
        const v = opts.defaultValue;
        if (opts.validate) {
            const err = opts.validate(v);
            if (err) { ctx.ui.notify(err, "error"); return undefined; }
        }
        return v;
    }
    if (opts.validate) {
        const err = opts.validate(trimmed);
        if (err) { ctx.ui.notify(err, "error"); return undefined; }
    }
    return trimmed;
}
async function askSelect(
    ctx: ExtensionCommandContext,
    opts: { message: string; options: string[]; defaultValue?: string },
): Promise<string | undefined> {
    const result = await ctx.ui.select(opts.message, opts.options);
    if (result === undefined) return undefined;
    return result;
}

async function askConfirm(ctx: ExtensionCommandContext, title: string, message: string, defaultValue = true): Promise<boolean | undefined> {
    return ctx.ui.confirm(title, message);
    // 注：confirm 不支持 defaultValue，UI 自带 yes/no
}

/** 包 FormEditor 进 ctx.ui.custom dialog。返回 { saved, values } 或 { saved: false, values: initial }。 */
async function runFormEditor<T extends Record<string, unknown>>(
    ctx: ExtensionCommandContext,
    title: string,
    fields: FormField[],
    initial: T,
): Promise<{ saved: boolean; values: T }> {
    const result = await ctx.ui.custom<{ saved: boolean; values: T } | undefined>((_tui, theme, _kb, done) => {
        return new FormEditor({
            title,
            fields,
            initial,
            theme,
            onSave: (values: T) => done({ saved: true, values }),
            onCancel: () => done(undefined),
        });
    }).catch((err) => {
        // 框架抛错（不是用户取消 Esc）要让用户知道
        console.error(`[provider-manager] form editor error:`, err);
        ctx.ui.notify(`Form editor error: ${err instanceof Error ? err.message : err}`, "error");
        return undefined;
    });
    return result ?? { saved: false, values: initial };
}

// ============================================================================
// Provider CRUD
// ============================================================================

export async function addProviderFlow(ctx: ExtensionCommandContext, onDone: () => void): Promise<void> {
    const id = await askInput(ctx, {
        message: "Provider id (lowercase / digits / _ / -; e.g. my-provider):",
        placeholder: "my-provider",
        validate: (s) => {
            if (!/^[a-z0-9_-]+$/i.test(s)) return "id must match [a-z0-9_-]+";
            return null;
        },
    });
    if (!id) return;

    const json = await readModelsJson();
    if (json.providers[id]) {
        ctx.ui.notify(`Provider "${id}" already exists. Use /providers remove ${id} first.`, "error");
        return;
    }

    const name = await askInput(ctx, { message: `Display name (optional):`, placeholder: id });
    if (name === undefined) return;

    const baseUrl = await askInput(ctx, { message: "baseUrl (e.g. http://localhost:11434/v1):", placeholder: "https://api.example.com/v1" });
    if (baseUrl === undefined) return;

    const apiKey = await askInput(ctx, { message: "apiKey (empty = no key):", secret: true });
    if (apiKey === undefined) return;

    const apiChoice = await askSelect(ctx, { message: "API type:", options: API_OPTIONS });
    if (apiChoice === undefined) return;

    const newProv: ProviderConfig = {
        ...(name ? { name } : {}),
        baseUrl,
        apiKey: apiKey || undefined,
        api: apiChoice,
        models: [],
    };
    try {
        await writeModelsJson({ ...json, providers: { ...json.providers, [id]: newProv } });
        ctx.ui.notify(`✓ Provider "${id}" added. Open /providers to add models.`, "success");
    } catch (err) {
        ctx.ui.notify(`Write failed: ${err instanceof Error ? err.message : err}`, "error");
    }
    onDone?.();
}

export async function addModelFlow(
    ctx: ExtensionCommandContext,
    providerId: string,
    onDone?: () => void,
): Promise<void> {
    const json = await readModelsJson();
    const prov = json.providers[providerId];
    if (!prov) {
        ctx.ui.notify(`Provider "${providerId}" does not exist.`, "error");
        onDone?.();
        return;
    }

    const id = await askInput(ctx, { message: "Model id (e.g. gpt-5 / claude-opus-4-7):", validate: (s) => s ? null : "id required" });
    if (!id) return;

    if ((prov.models ?? []).some((m) => m.id === id)) {
        ctx.ui.notify(`Model "${id}" already exists in "${providerId}".`, "error");
        onDone?.();
        return;
    }

    const name = await askInput(ctx, { message: `Display name (optional):`, placeholder: id });
    if (name === undefined) return;

    // 用默认配置？reasoning/input/ctx/max/thinkingLevelMap 都用 DEFAULT_MODEL_CONFIG＋可被 ~/.pi/agent/provider-manager.json#defaultModel 覆盖
    const DEFAULT_CFG = loadDefaultModelConfig();
    const useDefaults = await askConfirm(
        ctx,
        "Use default config?",
        `reasoning=${DEFAULT_CFG.reasoning ? "yes" : "no"} · input=${DEFAULT_CFG.input.join("+")} · ctx=${DEFAULT_CFG.contextWindow} · max=${DEFAULT_CFG.maxTokens} · thinkingLevelMap: medium=medium, others=null. (After creation, use 'e' to customize.)`,
    );
    if (useDefaults === undefined) return;

    let reasoning: boolean;
    let input: ("text" | "image")[];
    let ctxWindow: number;
    let maxTokens: number;
    let thinkingLevelMap: ModelConfig["thinkingLevelMap"] | undefined;

    if (useDefaults) {
        reasoning = DEFAULT_CFG.reasoning;
        input = [...DEFAULT_CFG.input];
        ctxWindow = DEFAULT_CFG.contextWindow;
        maxTokens = DEFAULT_CFG.maxTokens;
        thinkingLevelMap = { ...DEFAULT_CFG.thinkingLevelMap };
    } else {
        reasoning = await askConfirm(ctx, "Supports extended thinking?", "Yes for o1/o3/reasoning models, No otherwise.");
        if (reasoning === undefined) return;

        const inputType = await askSelect(ctx, { message: "Input type:", options: INPUT_OPTIONS });
        if (inputType === undefined) return;
        input = inputType === "text" ? ["text"] : ["text", "image"];

        const ctxWindowStr = await askInput(ctx, { message: "context window tokens (empty = 128000):", placeholder: "128000", validate: (s) => !s || /^\d+$/.test(s) ? null : "must be a number" });
        if (ctxWindowStr === undefined) return;
        ctxWindow = ctxWindowStr ? parseInt(ctxWindowStr, 10) : 128000;

        const maxTokensStr = await askInput(ctx, { message: "max output tokens (empty = 16384):", placeholder: "16384", validate: (s) => !s || /^\d+$/.test(s) ? null : "must be a number" });
        if (maxTokensStr === undefined) return;
        maxTokens = maxTokensStr ? parseInt(maxTokensStr, 10) : 16384;

        if (reasoning) {
            const presetLabels = THINKING_PRESETS.map((p) => p.label);
            const pick = await askSelect(ctx, {
                message: "Thinking level map (provider-dependent):",
                options: presetLabels,
                defaultValue: presetLabels[0],
            });
            if (pick === undefined) return;
            const preset = THINKING_PRESETS.find((p) => p.label === pick);
            if (preset && Object.keys(preset.map).length > 0) {
                if ((preset.map as any).__custom) {
                    const mapStr = await askInput(ctx, {
                        message: 'thinking level map (JSON, e.g. {"low":"low","medium":"medium"}):',
                        placeholder: '{"off":null,"low":"low"}',
                    });
                    if (mapStr === undefined) return;
                    if (mapStr.trim()) {
                        try {
                            const parsed = JSON.parse(mapStr);
                            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                                thinkingLevelMap = parsed as ModelConfig["thinkingLevelMap"];
                            } else {
                                ctx.ui.notify("thinking level map must be a JSON object; skipping", "warning");
                            }
                        } catch (err) {
                            ctx.ui.notify(`thinking level map JSON invalid: ${err instanceof Error ? err.message : err}; skipping`, "warning");
                        }
                    }
                } else {
                    thinkingLevelMap = preset.map;
                }
            }
        }
    }

    const model: ModelConfig = {
        id,
        name: name || undefined,
        reasoning,
        input,
        contextWindow: ctxWindow,
        maxTokens,
        ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    };

    const newProv: ProviderConfig = { ...prov, models: [...(prov.models ?? []), model] };
    try {
        await writeModelsJson({ ...json, providers: { ...json.providers, [providerId]: newProv } });
        ctx.ui.notify(`✓ Model "${id}" added to "${providerId}".`, "success");
    } catch (err) {
        ctx.ui.notify(`Write failed: ${err instanceof Error ? err.message : err}`, "error");
    }
    onDone?.();
}

export async function editProviderFlow(
    ctx: ExtensionCommandContext,
    providerId: string,
    onDone?: () => void,
): Promise<void> {
    const json = await readModelsJson();
    const cur = json.providers[providerId];
    if (!cur) {
        ctx.ui.notify(`Provider "${providerId}" does not exist.`, "error");
        onDone?.();
        return;
    }
    if (ctx.mode !== "tui") {
        ctx.ui.notify("edit 需要 TUI 模式。打开 /providers 选中 provider 后按 e", "warning");
        onDone?.();
        return;
    }

    const fields: FormField[] = [
        { key: "name", label: "Display name", type: "text", hint: "(empty = unset)" },
        { key: "baseUrl", label: "baseUrl", type: "text" },
        { key: "apiKey", label: "apiKey", type: "secret" },
        { key: "api", label: "api", type: "select", options: API_OPTIONS, hint: "1-N 选" },
        { key: "authHeader", label: "authHeader", type: "select", options: ["no", "yes"] },
    ];
    const initial: Record<string, unknown> = {
        name: cur.name ?? "",
        baseUrl: cur.baseUrl ?? "",
        apiKey: cur.apiKey ?? "",
        api: cur.api ?? "",
        authHeader: cur.authHeader ? "yes" : "no",
    };
    const result = await runFormEditor(ctx, `Edit provider "${providerId}"`, fields, initial);
    if (!result.saved) { onDone?.(); return; }
    const v = result.values;
    const next: ProviderConfig = {
        ...cur,
        name: ((v.name as string) || "") || undefined,
        baseUrl: ((v.baseUrl as string) || "") || undefined,
        apiKey: ((v.apiKey as string) || "") || undefined,
        api: ((v.api as string) || "") || undefined,
        authHeader: v.authHeader === "yes",
    };
    try {
        await writeModelsJson({ ...json, providers: { ...json.providers, [providerId]: next } });
        ctx.ui.notify(`✓ Provider "${providerId}" updated.`, "success");
    } catch (err) {
        ctx.ui.notify(`Write failed: ${err instanceof Error ? err.message : err}`, "error");
    }
    onDone?.();
}

export async function deleteProviderFlow(
    ctx: ExtensionCommandContext,
    providerId: string,
    onDone?: () => void,
): Promise<void> {
    const json = await readModelsJson();
    if (!json.providers[providerId]) {
        ctx.ui.notify(`Provider "${providerId}" does not exist.`, "error");
        onDone?.();
        return;
    }
    const ok = await askConfirm(
        ctx,
        `Delete provider "${providerId}"?`,
        `This removes ${json.providers[providerId].models?.length ?? 0} model(s). Can be restored from .bak via /providers reset.`,
    );
    if (ok === undefined || !ok) {
        onDone?.();
        return;
    }
    const { [providerId]: _, ...rest } = json.providers;
    try {
        await writeModelsJson({ providers: rest });
        ctx.ui.notify(`✓ Provider "${providerId}" deleted (restore with /providers reset).`, "success");
    } catch (err) {
        ctx.ui.notify(`Write failed: ${err instanceof Error ? err.message : err}`, "error");
    }
    onDone?.();
}
// ============================================================================
// Model CRUD (continued)
// ============================================================================

export async function editModelFlow(
    ctx: ExtensionCommandContext,
    providerId: string,
    modelId: string,
    onDone?: () => void,
): Promise<void> {
    const json = await readModelsJson();
    const prov = json.providers[providerId];
    if (!prov) { ctx.ui.notify(`Provider "${providerId}" does not exist.`, "error"); onDone?.(); return; }
    const cur = (prov.models ?? []).find((m) => m.id === modelId);
    if (!cur) { ctx.ui.notify(`Model "${modelId}" does not exist in "${providerId}".`, "error"); onDone?.(); return; }
    if (ctx.mode !== "tui") { ctx.ui.notify("edit 需要 TUI 模式。打开 /providers 选中 model 后按 e", "warning"); onDone?.(); return; }

    const fields: FormField[] = [
        { key: "name", label: "Display name", type: "text", hint: "(empty = unset)" },
        { key: "reasoning", label: "reasoning", type: "select", options: ["no", "yes"] },
        { key: "input", label: "input", type: "multiselect", options: ["text", "image"] },
        { key: "contextWindow", label: "contextWindow", type: "number", validate: (v) => typeof v === "number" && v >= 0 ? null : "must be non-negative" },
        { key: "maxTokens", label: "maxTokens", type: "number", validate: (v) => typeof v === "number" && v >= 0 ? null : "must be non-negative" },
        { key: "thinkingLevelMap", label: "thinkingLevelMap", type: "levelmap", hint: "(empty = remove)" },
    ];
    const initial: Record<string, unknown> = {
        name: cur.name ?? "",
        reasoning: cur.reasoning === true || cur.reasoning === "yes" ? "yes" : "no",
        input: Array.isArray(cur.input) ? cur.input.filter((x) => x === "text" || x === "image") : [],
        contextWindow: cur.contextWindow ?? 0,
        maxTokens: cur.maxTokens ?? 0,
        thinkingLevelMap: cur.thinkingLevelMap ?? null,
    };
    const result = await runFormEditor(ctx, `Edit model "${providerId}/${modelId}"`, fields, initial);
    if (!result.saved) { onDone?.(); return; }
    const v = result.values;
    const next: ModelConfig = {
        ...cur,
        name: ((v.name as string) || "") || undefined,
        reasoning: v.reasoning === "yes",
        input: Array.isArray(v.input) ? v.input : (v.input === "image" ? ["text", "image"] : ["text"]),
        contextWindow: (v.contextWindow as number) || undefined,
        maxTokens: (v.maxTokens as number) || undefined,
        thinkingLevelMap: (v.thinkingLevelMap as Record<string, unknown> | null) ?? undefined,
    };
    const newModels = (prov.models ?? []).map((m) => (m.id === modelId ? next : m));
    const newProv: ProviderConfig = { ...prov, models: newModels };
    try {
        await writeModelsJson({ ...json, providers: { ...json.providers, [providerId]: newProv } });
        ctx.ui.notify(`✓ Model "${modelId}" updated.`, "success");
    } catch (err) {
        ctx.ui.notify(`Write failed: ${err instanceof Error ? err.message : err}`, "error");
    }
    onDone?.();
}

export async function deleteModelFlow(
    ctx: ExtensionCommandContext,
    providerId: string,
    modelId: string,
    onDone?: () => void,
): Promise<void> {
    const json = await readModelsJson();
    const prov = json.providers[providerId];
    if (!prov) { ctx.ui.notify(`Provider "${providerId}" does not exist.`, "error"); onDone?.(); return; }
    if (!(prov.models ?? []).some((m) => m.id === modelId)) { ctx.ui.notify(`Model "${modelId}" not in "${providerId}".`, "error"); onDone?.(); return; }
    const ok = await askConfirm(ctx, `Delete model "${modelId}"?`, "This removes it from models.json. Can be restored from .bak via /providers reset.");
    if (ok === undefined || !ok) { onDone?.(); return; }
    const newModels = (prov.models ?? []).filter((m) => m.id !== modelId);
    const newProv: ProviderConfig = { ...prov, models: newModels };
    try {
        await writeModelsJson({ ...json, providers: { ...json.providers, [providerId]: newProv } });
        ctx.ui.notify(`✓ Model "${modelId}" deleted (restore with /providers reset).`, "success");
    } catch (err) {
        ctx.ui.notify(`Write failed: ${err instanceof Error ? err.message : err}`, "error");
    }
    onDone?.();
}

// ============================================================================
// Backup restore / sync
// ============================================================================

export async function restoreFromBackupFlow(ctx: ExtensionCommandContext, onDone: () => void): Promise<void> {
    if (!backupExists()) { ctx.ui.notify("No backup found. Nothing to restore.", "warning"); onDone?.(); return; }
    const ok = await askConfirm(ctx, "Restore from .bak?", "Current models.json will be overwritten with .bak content. .bak itself is preserved.");
    if (ok === undefined || !ok) { onDone?.(); return; }
    const restored = await restoreBackup();
    if (restored) ctx.ui.notify("✓ Restored from .bak.", "success");
    else ctx.ui.notify("Restore failed.", "error");
    onDone?.();
}

export type SyncOpts = { sourceProviderId?: string; onDone?: () => void };

export async function syncFlow(ctx: ExtensionCommandContext, opts: SyncOpts = {}): Promise<void> {
    const json = await readModelsJson();
    const ids = Object.keys(json.providers);
    if (ids.length === 0) { ctx.ui.notify("models.json is empty. Add a provider first.", "warning"); opts.onDone?.(); return; }
    let sourceId = opts.sourceProviderId;
    // 预先检查：没有任何 provider 有 baseUrl → 直接报错
    const allNoBaseUrl = ids.length > 0 && ids.every((id) => !json.providers[id]?.baseUrl);
    if (allNoBaseUrl) {
        ctx.ui.notify("没有 baseUrl。先去 /providers 改一下 baseUrl 再 sync。", "error");
        opts.onDone?.();
        return;
    }
    if (!sourceId) {
        const picked = await askSelect(ctx, { message: "Sync from which provider?", options: ids });
        if (picked === undefined) { opts.onDone?.(); return; }
        sourceId = picked;
    }
    const prov = json.providers[sourceId];
    if (!prov || !prov.baseUrl) { ctx.ui.notify(`Provider "${sourceId}" 没有 baseUrl，先去 /providers 改一下 baseUrl 再 sync。`, "error"); opts.onDone?.(); return; }
    const apiKey = prov.apiKey ?? "";
    const apiKind: "openai-compat" | "google" = prov.api === "google-generative-ai" ? "google" : "openai-compat";
    ctx.ui.notify(`Fetching models from ${prov.baseUrl}...`, "info");
    let result;
    try {
        result = await fetchListing({ baseUrl: prov.baseUrl, apiKey, apiKind, signal: ctx.signal, timeoutMs: 10000 });
    } catch (err) {
        ctx.ui.notify(`Fetch failed: ${err instanceof Error ? err.message : err}`, "error");
        opts.onDone?.();
        return;
    }
    if (result.warnings.length) ctx.ui.notify(result.warnings.join("; "), "warning");
    if (result.models.length === 0 && (prov.models ?? []).length === 0) { ctx.ui.notify("No models found. Check baseUrl / api key.", "warning"); opts.onDone?.(); return; }
    const existing = (prov.models ?? []).map((m) => ({ id: m.id }));
    const { toAdd } = diffModels(result.models, existing);
    // wire pi done directly to checklist onConfirm/onCancel (otherwise dialog never closes)
    // checklist shows ALL models in this provider:
    //   - existing: label " (existing)", default checked (uncheck = remove)
    //   - toAdd (remote new): default unchecked (check = add)
    const items = [
        ...(prov.models ?? []).map((m) => ({ id: m.id, label: `${m.id}  (existing)`, hint: "uncheck to remove" })),
        ...toAdd.map((m) => ({ id: m.id, label: m.id, hint: `reasoning=${m.reasoning} input=${m.input.join(",")} ctx=${m.contextWindow}` })),
    ];
    const selectedIds = await ctx.ui.custom<Set<string> | string[]>((_t, theme, _kb, done) => {
        const checklist = new ModelChecklist({
            title: `Sync "${sourceId}": ${toAdd.length} new, ${(prov.models ?? []).length} existing`,
            items,
            preSelect: (it) => it.id ? (prov.models ?? []).some((m) => m.id === it.id) : true,
            theme,  // 构造时传 theme，pi 框架会注入
            onConfirm: (sel) => done(new Set(sel)),
            onCancel: () => done(undefined),
        });
        return checklist;
    }).catch((err) => {
        // 框架抛错（不是用户取消）要让用户知道
        console.error(`[provider-manager] sync checklist error:`, err);
        ctx.ui.notify(`Sync checklist error: ${err instanceof Error ? err.message : err}`, "error");
        return undefined;
    });
    if (selectedIds === undefined || selectedIds === null) { ctx.ui.notify("Sync cancelled.", "info"); opts.onDone?.(); return; }
    const pickedIds = selectedIds instanceof Set ? selectedIds : new Set(selectedIds as string[]);
    // merge: checked = keep/add; unchecked = remove
    const existingIds = (prov.models ?? []).map((m) => m.id);
    const allIds = new Set([...existingIds, ...toAdd.map((m) => m.id)]);
    const finalModels: ModelConfig[] = [];
    for (const id of allIds) {
        if (!pickedIds.has(id)) continue;
        const fromRemote = toAdd.find((m) => m.id === id);
        if (fromRemote) finalModels.push(fromRemote);
        else {
            const fromLocal = (prov.models ?? []).find((m) => m.id === id);
            if (fromLocal) finalModels.push(fromLocal);
        }
    }
    if (finalModels.length === 0) {
        ctx.ui.notify("No models selected. Sync cancelled (nothing kept).", "info");
        opts.onDone?.();
        return;
    }
    const newProv: ProviderConfig = { ...prov, models: finalModels };
    try {
        await writeModelsJson({ ...json, providers: { ...json.providers, [sourceId!]: newProv } });
        ctx.ui.notify(`Synced "${sourceId}": ${finalModels.length} model(s) kept. Press Ctrl+L to pick model.`, "success");
    } catch (err) {
        ctx.ui.notify(`Write failed: ${err instanceof Error ? err.message : err}`, "error");
    }
    opts.onDone?.();
}
