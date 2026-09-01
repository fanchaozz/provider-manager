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
import { fetchListing, inferModel, diffModels } from "./sync.ts";
import { ModelChecklist, FormEditor, type FormField } from "./components.ts";

// ============================================================================
// 共用 prompt helpers
// ============================================================================

// select 的 options 必须是 string[]，不能是 {label,value}。直接把 value 字符串化。
const API_OPTIONS: string[] = [
    ...ALLOWED_APIS,
    "(none / 由 model 字段指定)",
];

/** 新 model 的默认配置。调 /providers model <pid> add 或 dashboard n 走 addModelFlow 时
 *  会问 "Use defaults?"，回答 yes → 套这里的所有值；回答 no → 逐个问。 */
export const DEFAULT_MODEL_CONFIG: {
    reasoning: boolean;
    input: ("text" | "image")[];
    contextWindow: number;
    maxTokens: number;
    thinkingLevelMap: ModelConfig["thinkingLevelMap"];
    compat: { supportsDeveloperRole: boolean };
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
    // Zhipu GLM 等 OpenAI-compat 网关拒收 role:"developer"（会返 422）。默认 false → pi 用 system role。
    compat: { supportsDeveloperRole: false },
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
			_syncViewportSize: "Sync checklist viewport height (rows). Affects how many models are visible at once during /providers sync. Default = 8. Range 5-200. To override: add \"syncViewportSize\": 30 here.",
		}, null, 2) + "\n", { mode: 0o600 });
		return p;
	} catch (err) {
		console.error(`[provider-manager] ensureDefaultConfigFile failed:`, err);
		return null;
	}
}

/**
 * 读 ~/.pi/agent/provider-manager.json 的 syncViewportSize 字段。
 * 用于 sync checklist 视口大小（一次性能看到的 model 行数）。
 * 不存在 / 非法 / 越界（< 5 或 > 200）→ 返回 null，由调用方走默认。
 */
export function getSyncViewportSize(): number | null {
	try {
		const p = getDefaultModelConfigPath();
		if (!existsSync(p)) return null;
		const raw = readFileSync(p, "utf8");
		const parsed = JSON.parse(raw);
		const v = parsed?.syncViewportSize;
		if (typeof v !== "number" || !Number.isFinite(v)) return null;
		const n = Math.floor(v);
		// 越界保护：5-200 之间。太小装不下任何项，太大可能让 framework 不裁剪（体验差）
		if (n < 5 || n > 200) return null;
		return n;
	} catch {
		return null;
	}
}

function isValidDefaultModelConfig(v: any): v is typeof DEFAULT_MODEL_CONFIG {
	const compatOk = !v.compat
		|| (typeof v.compat === "object" && !Array.isArray(v.compat) && (
			v.compat.supportsDeveloperRole === undefined
			|| typeof v.compat.supportsDeveloperRole === "boolean"
		));
	return (
		v && typeof v === "object" &&
		typeof v.reasoning === "boolean" &&
		Array.isArray(v.input) && v.input.every((x: any) => x === "text" || x === "image") && v.input.length > 0 &&
		typeof v.contextWindow === "number" && v.contextWindow > 0 && Number.isFinite(v.contextWindow) &&
		typeof v.maxTokens === "number" && v.maxTokens > 0 && Number.isFinite(v.maxTokens) &&
		v.thinkingLevelMap && typeof v.thinkingLevelMap === "object" && !Array.isArray(v.thinkingLevelMap) &&
		compatOk
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
		if (isValidDefaultModelConfig(cfg)) {
			// 补全缺失的 compat（老 config 没有这个字段时默认为 false）
			if (!cfg.compat) cfg.compat = { supportsDeveloperRole: false };
			return cfg;
		}
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

async function askConfirm(ctx: ExtensionCommandContext, title: string, message: string): Promise<boolean | undefined> {
    return ctx.ui.confirm(title, message);
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
    if (ctx.mode !== "tui") {
        ctx.ui.notify("add provider 需要 TUI 模式。打开 /providers 后按 n", "warning");
        onDone?.();
        return;
    }

    // 与 editProviderFlow 同形：一次性表单采集所有字段（含 id）
    // 错误（id 重复 / id 非法）不走 notify 弹窗 — 留在表单里提示，点 s 后再调
    const json = await readModelsJson();
    const fields: FormField[] = [
        { key: "id", label: "id", type: "text", hint: "[a-z0-9_-]+", validate: (s) => {
            if (!s) return "id required";
            if (!/^[a-z0-9_-]+$/i.test(s as string)) return "id must match [a-z0-9_-]+";
            if (json.providers[s as string]) return `provider "${s}" already exists`;
            return null;
        } },
        { key: "name", label: "Display name", type: "text", hint: "(empty = unset)" },
        { key: "baseUrl", label: "baseUrl", type: "text" },
        { key: "apiKey", label: "apiKey", type: "secret" },
        { key: "api", label: "api", type: "select", options: API_OPTIONS, hint: "(empty = unset)" },
        { key: "authHeader", label: "authHeader", type: "select", options: ["no", "yes"] },
        { key: "proxy", label: "proxy", type: "text", hint: "(empty = unset; http://host:port)" },
    ];
    const initial: Record<string, unknown> = {
        id: "",
        name: "",
        baseUrl: "",
        apiKey: "",
        api: "",
        authHeader: "no",
        proxy: "",
    };
    const result = await runFormEditor(ctx, `Add provider`, fields, initial);
    if (!result.saved) { onDone?.(); return; }
    const v = result.values;
    const id = (v.id as string).trim();
    // 二次校验：表单后还会再查一次（同进程可能别的并发写）
    if (json.providers[id]) {
        ctx.ui.notify(`Provider "${id}" already exists. Use /providers remove ${id} first.`, "error");
        onDone?.();
        return;
    }
    const newProv: ProviderConfig = {
        ...((v.name as string) ? { name: v.name as string } : {}),
        baseUrl: ((v.baseUrl as string) || "") || undefined,
        apiKey: ((v.apiKey as string) || "") || undefined,
        api: ((v.api as string) || "") || undefined,
        authHeader: v.authHeader === "yes",
        proxy: ((v.proxy as string) || "") || undefined,
        models: [],
    };
    try {
        const fresh = await readModelsJson();
        await writeModelsJson({ ...fresh, providers: { ...fresh.providers, [id]: newProv } });
        ctx.ui.notify(`✓ Provider "${id}" added. Use 'y' to sync models.`, "success");
    } catch (err) {
        ctx.ui.notify(`Write failed: ${err instanceof Error ? err.message : err}`, "error");
    }
    onDone?.();
}

/** @deprecated Models are added/removed via sync; this flow is for cases where sync
 *  cannot reach the upstream (offline / private deploy / unsupported listing). Uses
 *  loadDefaultModelConfig() as the field template. The "compat.supportsDeveloperRole:false"
 *  default is preserved here too (Zhipu GLM 等 OpenAI-compat 网关需 false 避免 422)。 */
export async function addModelFlow(
    ctx: ExtensionCommandContext,
    providerId: string,
    onDone?: () => void,
): Promise<void> {
    if (ctx.mode !== "tui") {
        ctx.ui.notify("add model 需要 TUI 模式。打开 /providers 选中 provider 后按 n", "warning");
        onDone?.();
        return;
    }
    const json = await readModelsJson();
    const prov = json.providers[providerId];
    if (!prov) {
        ctx.ui.notify(`Provider "${providerId}" 不存在。`, "error");
        onDone?.();
        return;
    }
    // 先问 "Use default config?" — yes → loadDefaultModelConfig() 作初值；no → 逐项提问（0/空）
    const useDefault = await ctx.ui.confirm(
        "Use default model config?",
        `Apply ~/.pi/agent/provider-manager.json#defaultModel template (reasoning / input / contextWindow / maxTokens / thinkingLevelMap / compat.supportsDeveloperRole)?  yes = template values; no = per-field prompts.`,
    );
    if (useDefault === undefined) { onDone?.(); return; }  // Esc 取消
    const defaults = loadDefaultModelConfig();

    // 字段集：id 始终问、name 问、其余问 + 给默认值
    const fields: FormField[] = [
        { key: "id", label: "id", type: "text", hint: "[a-z0-9_-]+", validate: (s) => {
            if (!s) return "id required";
            if (!/^[a-z0-9_.-]+$/i.test(s as string)) return "id must match [a-z0-9_.-]+";
            if ((prov.models ?? []).some((m) => m.id === s)) return `model "${s}" already exists in provider "${providerId}"`;
            return null;
        } },
        { key: "name", label: "Display name", type: "text", hint: "(empty = unset)" },
    ];
    if (!useDefault) {
        // 逐项提示。给一个起点初值（上一轮默认值／代码默认）
        fields.push(
            { key: "reasoning", label: "reasoning", type: "select", options: ["no", "yes"], hint: "Zhipu GLM 等推理=否" },
            { key: "input", label: "input", type: "multiselect", options: ["text", "image"] },
            { key: "contextWindow", label: "contextWindow", type: "number", validate: (v) => typeof v === "number" && v >= 0 ? null : "must be non-negative" },
            { key: "maxTokens", label: "maxTokens", type: "number", validate: (v) => typeof v === "number" && v >= 0 ? null : "must be non-negative" },
            { key: "thinkingLevelMap", label: "thinkingLevelMap", type: "levelmap", hint: "(empty = remove)" },
            // Zhipu GLM 等需 no (用 system role)
            { key: "supportsDeveloperRole", label: "supportsDeveloperRole (compat)", type: "select", options: ["no", "yes"], hint: "Zhipu GLM 等需 no" },
        );
    }
    const initial: Record<string, unknown> = useDefault
        ? { id: "", name: "" }
        : {
            id: "",
            name: "",
            reasoning: defaults.reasoning ? "yes" : "no",
            input: defaults.input,
            contextWindow: defaults.contextWindow,
            maxTokens: defaults.maxTokens,
            thinkingLevelMap: defaults.thinkingLevelMap,
            supportsDeveloperRole: defaults.compat?.supportsDeveloperRole === true ? "yes" : "no",
        };
    const result = await runFormEditor(ctx, `Add model to "${providerId}"`, fields, initial);
    if (!result.saved) { onDone?.(); return; }
    const v = result.values;
    const id = (v.id as string).trim();
    // 二次校验：表单后还会再查一次（同进程可能别的并发写）
    if ((prov.models ?? []).some((m) => m.id === id)) {
        ctx.ui.notify(`Model "${id}" already exists in "${providerId}".`, "error");
        onDone?.();
        return;
    }
    const newModel: ModelConfig = useDefault
        ? buildModelFromTemplate(id, v.name as string, defaults)
        : buildModelFromFields(id, v);
    const newModels = [...(prov.models ?? []), newModel];
    const newProv: ProviderConfig = { ...prov, models: newModels };
    try {
        const fresh = await readModelsJson();
        await writeModelsJson({ ...fresh, providers: { ...fresh.providers, [providerId]: newProv } });
        ctx.ui.notify(`✓ Model "${id}" added to "${providerId}".`, "success");
    } catch (err) {
        ctx.ui.notify(`Write failed: ${err instanceof Error ? err.message : err}`, "error");
    }
    onDone?.();
}

/** 从 template（useDefault=yes）拼 ModelConfig。所有字段都从 defaults 拷贝。 */
function buildModelFromTemplate(id: string, nameRaw: string, defaults: typeof DEFAULT_MODEL_CONFIG): ModelConfig {
    return {
        id,
        name: nameRaw || undefined,
        reasoning: defaults.reasoning,
        input: [...defaults.input],
        contextWindow: defaults.contextWindow,
        maxTokens: defaults.maxTokens,
        thinkingLevelMap: { ...defaults.thinkingLevelMap },
        // compat 拷贝不丢：Zhipu GLM 等需 supportsDeveloperRole=false 防 422
        compat: defaults.compat ? { ...defaults.compat } : { supportsDeveloperRole: false },
    };
}

/** 从表单（useDefault=no）拼 ModelConfig。逐项使用用户输入，缺失项用 defaults 补。 */
function buildModelFromFields(id: string, v: Record<string, unknown>): ModelConfig {
    const defaults = loadDefaultModelConfig();
    const name = ((v.name as string) || "") || undefined;
    const reasoning = v.reasoning === "yes";
    const input = Array.isArray(v.input) ? v.input as ("text" | "image")[] : [...defaults.input];
    const contextWindow = (typeof v.contextWindow === "number" && v.contextWindow > 0)
        ? v.contextWindow
        : defaults.contextWindow;
    const maxTokens = (typeof v.maxTokens === "number" && v.maxTokens > 0)
        ? v.maxTokens
        : defaults.maxTokens;
    const thinkingLevelMap = v.thinkingLevelMap && typeof v.thinkingLevelMap === "object"
        ? v.thinkingLevelMap as ModelConfig["thinkingLevelMap"]
        : { ...defaults.thinkingLevelMap };
    // compat：保留老 compat（如果用户输入给了）+ 补 supportsDeveloperRole。0/空 → false
    const compat: Record<string, unknown> = { ...(defaults.compat ?? {}) };
    compat.supportsDeveloperRole = v.supportsDeveloperRole === "yes";
    return {
        id,
        name,
        reasoning,
        input,
        contextWindow,
        maxTokens,
        thinkingLevelMap,
        compat,
    };
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
        { key: "proxy", label: "proxy", type: "text", hint: "(empty = unset; http://host:port)" },
    ];
    const initial: Record<string, unknown> = {
        name: cur.name ?? "",
        baseUrl: cur.baseUrl ?? "",
        apiKey: cur.apiKey ?? "",
        api: cur.api ?? "",
        authHeader: cur.authHeader ? "yes" : "no",
        proxy: cur.proxy ?? "",
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
        proxy: ((v.proxy as string) || "") || undefined,
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
        // Zhipu GLM 等 OpenAI-compat 网关不接受 role:"developer" (会返 422)。默认 no 用 system role。
        { key: "supportsDeveloperRole", label: "supportsDeveloperRole (compat)", type: "select", options: ["no", "yes"], hint: "Zhipu GLM 等需 no (用 system role)" },
    ];
    const initial: Record<string, unknown> = {
        name: cur.name ?? "",
        reasoning: cur.reasoning === true || cur.reasoning === "yes" ? "yes" : "no",
        input: Array.isArray(cur.input) ? cur.input.filter((x) => x === "text" || x === "image") : [],
        contextWindow: cur.contextWindow ?? 0,
        maxTokens: cur.maxTokens ?? 0,
        thinkingLevelMap: cur.thinkingLevelMap ?? null,
        supportsDeveloperRole: (cur.compat as any)?.supportsDeveloperRole === true ? "yes" : "no",
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
        compat: { ...(cur.compat ?? {}), supportsDeveloperRole: v.supportsDeveloperRole === "yes" },
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
        result = await fetchListing({ baseUrl: prov.baseUrl, apiKey, apiKind, proxy: prov.proxy, signal: ctx.signal, timeoutMs: 10000 });
    } catch (err) {
        ctx.ui.notify(`Fetch failed: ${err instanceof Error ? err.message : err}`, "error");
        opts.onDone?.();
        return;
    }
    if (result.warnings.length) ctx.ui.notify(result.warnings.join("; "), "warning");
    if (result.models.length === 0 && (prov.models ?? []).length === 0) { ctx.ui.notify("No models found. Check baseUrl / api key.", "warning"); opts.onDone?.(); return; }
    const existing = (prov.models ?? []).map((m) => ({ id: m.id }));
    // 关键修复：传 loadDefaultModelConfig() 作 defaults，使 toAdd 使用用户级 default（不是代码内置默认）
    const userDefaults = loadDefaultModelConfig();
    const { toAdd } = diffModels(result.models, existing, { defaults: userDefaults });
    // wire pi done directly to checklist onConfirm/onCancel (otherwise dialog never closes)
    // checklist shows ALL models in this provider:
    //   - existing: label " (existing)", default checked (uncheck = remove)
    //   - toAdd (remote new): default unchecked (check = add)
    const items = [
        ...(prov.models ?? []).map((m) => ({ id: m.id, label: `${m.id}  (existing)`, hint: "uncheck to remove" })),
        ...toAdd.map((m) => ({ id: m.id, label: m.id, hint: `reasoning=${m.reasoning} input=${m.input.join(",")} ctx=${m.contextWindow}` })),
    ];
    const selectedIds = await ctx.ui.custom<Set<string> | string[]>((_t, theme, _kb, done) => {
        // 视口高度：用户配置 > 默认 8。越界 / 非法 → getSyncViewportSize 返 null，走默认。
        const configured = getSyncViewportSize();
        const maxRows = configured ?? 8;
        const checklist = new ModelChecklist({
            title: `Sync "${sourceId}": ${toAdd.length} new, ${(prov.models ?? []).length} existing`,
            items,
            preSelect: (it) => it.id ? (prov.models ?? []).some((m) => m.id === it.id) : true,
            theme,  // 构造时传 theme，pi 框架会注入
            maxRows,
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
        // Enter = 提交选择。不 short-circuit：uncheck 全部 + Enter 也要写空列表。
        // 只有 Esc / checklist onCancel 会走 onDone 不写盘。
        const newProv: ProviderConfig = { ...prov, models: [] };
        try {
            await writeModelsJson({ ...json, providers: { ...json.providers, [sourceId!]: newProv } });
            ctx.ui.notify(`Cleared all models from "${sourceId}". Press Ctrl+L to pick a model.`, "info");
        } catch (err) {
            ctx.ui.notify(`Write failed: ${err instanceof Error ? err.message : err}`, "error");
        }
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
