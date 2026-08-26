/**
 * sync.ts — 远端 model 拉取 + 字段推断
 *
 * 2 个 preset:
 *   - google:    https://generativelanguage.googleapis.com/v1beta, /models?key=$KEY
 *   - custom:    任意 OpenAI-compat /v1/models
 *
 * 启发式（基于 id 命名字符串，仅 best-effort）：
 *   - input:      含 vision/gpt-4/claude/gemini/grok/llava/moondream → ["text","image"]
 *   - reasoning:  含 o1/o3/o4/reasoning/thinking/deepseek-r/qwq/qwen3 → true
 *   - 过滤:       embed/tts/whisper/dall-e/clip/image-/moderation
 *
 * 真实成本/上下文对 OpenAI-compat /v1/models 拿不到；v1 默认 128k/16k，
 *   user 在 step 3 引导里可逐个改。
 */

import type { ModelConfig } from "./store.ts";
import { DEFAULT_MODEL_CONFIG } from "./forms.ts";

// ============================================================================
// Types
// ============================================================================

export type ApiKind = "openai-compat" | "google";

export type FetchedModel = {
	id: string;
	name?: string;
};

export type FetchResult = {
	baseUrl: string;
	apiKind: ApiKind;
	models: FetchedModel[];
	warnings: string[];
};

// ============================================================================
// Presets
// ============================================================================

export type SyncPreset = {
	id: "google" | "custom";
	label: string;
	baseUrl?: string;       // google 是固定，custom 留空让用户填
	api: ApiKind;
};

export const SYNC_PRESETS: SyncPreset[] = [
	{ id: "google", label: "Google Generative AI", baseUrl: "https://generativelanguage.googleapis.com/v1beta", api: "google" },
	{ id: "custom", label: "Custom OpenAI-compatible URL...", api: "openai-compat" },
];

// ============================================================================
// Heuristics
// ============================================================================

const NOISE_PATTERN = /\b(embed|embedding|tts|whisper|dall-?e|clip|moderation)\b|^image[-_]|image-generation/i;
const REASONING_PATTERN = /(?:^|[^a-z])(o[1-9]|reasoning|thinking|deepseek-?r|qwq|qwen3)(?:$|[^a-z])/i;
const VISION_PATTERN = /(vision|claude|gemini|gpt-4|gpt-5|grok|llava|moondream|pixtral|llava|nova-?pro)/i;
const INPUT_IMAGE_PATTERN = /(vision|multimodal|image[-_]?input)/i;

const DEFAULT_CONTEXT = 1000000;
const DEFAULT_MAX_TOKENS = 128000;

/** 是否是 noise（embedding / tts / image-gen 等） */
export function isNoise(id: string): boolean {
	return NOISE_PATTERN.test(id);
}

/** 推断 reasoning（extended thinking 支持） */
export function inferReasoning(id: string): boolean {
	return REASONING_PATTERN.test(id);
}

/** 推断 input 类型 */
export function inferInput(id: string): ("text" | "image")[] {
	if (INPUT_IMAGE_PATTERN.test(id) || VISION_PATTERN.test(id)) return ["text", "image"];
	return ["text"];
}

/** 把 FetchedModel 变成 ModelConfig。缺省值以 DEFAULT_MODEL_CONFIG 为准（reasoning=yes / input=[text,image] / ctx/max / thinkingLevelMap.medium=medium），
 *  启发式仅在缺省为 no 时下调（比如「明显不是 reasoning」）。可选 3 个参传入覆盖上下文窗口 / max / defaults。 */
export function inferModel(id: string, fetched: FetchedModel, overrides?: { contextWindow?: number; maxTokens?: number; defaults?: typeof DEFAULT_MODEL_CONFIG }): ModelConfig {
	const cfg = overrides?.defaults ?? DEFAULT_MODEL_CONFIG;
	const heuristicReasoning = inferReasoning(id);
	const heuristicInput = inferInput(id);
	return {
		id,
		name: fetched.name && fetched.name !== id ? fetched.name : undefined,
		reasoning: cfg.reasoning || heuristicReasoning,
		input: cfg.input.includes("image") || heuristicInput.includes("image")
			? ["text", "image"]
			: cfg.input,
		contextWindow: overrides?.contextWindow ?? cfg.contextWindow,
		maxTokens: overrides?.maxTokens ?? cfg.maxTokens,
		thinkingLevelMap: { ...cfg.thinkingLevelMap },
	};
}

// ============================================================================
// Fetcher
// ============================================================================

/** 拉取远端 model 列表；自带超时和 noise 过滤 */
export async function fetchListing(opts: {
	baseUrl: string;
	apiKey?: string;
	apiKind: ApiKind;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<FetchResult> {
	const { baseUrl, apiKey, apiKind, signal, timeoutMs = 10000 } = opts;
	const warnings: string[] = [];

	// 用 AbortController 双重保护：外部 signal + 超时
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
	const onAbort = () => ctrl.abort(signal!.reason);
	if (signal) signal.addEventListener("abort", onAbort);

	try {
		const base = baseUrl.replace(/\/+$/, "");
		let url: string;
		let headers: Record<string, string> = {};
		let body: any;

		if (apiKind === "google") {
			// GET {base}/models?key=$KEY → { models: [{ name, ... }] }
			const keyParam = apiKey ? `?key=${encodeURIComponent(apiKey)}` : "";
			url = `${base}/models${keyParam}`;
		} else {
			// GET {base}/models → { data: [{ id, name, ... }] }
			url = `${base}/models`;
			if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
		}

		const res = await fetch(url, { method: "GET", headers, signal: ctrl.signal });
		if (!res.ok) {
			throw new Error(`HTTP ${res.status} ${res.statusText}`);
		}

		const MAX = 5 * 1024 * 1024; // 5MB 硬上限，防止 OOM
		const reader = res.body?.getReader();
		if (!reader) throw new Error("no response body");
		let received = 0;
		const chunks: Uint8Array[] = [];
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			received += value.byteLength;
			if (received > MAX) {
				reader.cancel();
				throw new Error(`response too large (>${MAX} bytes)`);
			}
			chunks.push(value);
		}
		const text = new TextDecoder().decode(Buffer.concat(chunks));
		const json = JSON.parse(text);

		// 提取 models
		let raw: any[] = [];
		if (apiKind === "google") {
			raw = Array.isArray(json?.models) ? json.models : [];
		} else {
			raw = Array.isArray(json?.data) ? json.data : [];
		}

		const models: FetchedModel[] = [];
		for (const m of raw) {
			let id: string | undefined;
			if (apiKind === "google") {
				// Google 返回 name 形如 "models/gemini-1.5-pro-latest"
				const name = typeof m?.name === "string" ? m.name : "";
				id = name.startsWith("models/") ? name.slice("models/".length) : name;
				// 只保留支持 generateContent 的（chat model）
				const methods = m?.supportedGenerationMethods;
				if (Array.isArray(methods) && !methods.includes("generateContent")) continue;
			} else {
				if (typeof m?.id === "string") id = m.id;
			}
			if (!id) continue;
			if (isNoise(id)) continue;
			const out: FetchedModel = { id };
			if (typeof m?.displayName === "string" && apiKind === "google") out.name = m.displayName;
			else if (typeof m?.name === "string" && apiKind === "openai-compat" && m.name !== id) out.name = m.name;
			models.push(out);
		}

		return { baseUrl: base, apiKind, models, warnings };
	} finally {
		clearTimeout(timer);
		if (signal) signal.removeEventListener("abort", onAbort);
	}
}

// ============================================================================
// Sync existing providers: 给定 json，对每个有 baseUrl 的 provider 跑 fetchListing
// ============================================================================

export async function syncExisting(
	providers: Record<string, { baseUrl?: string; apiKey?: string; api?: string }>,
	signal?: AbortSignal,
	timeoutMs?: number,
): Promise<Array<{ providerId: string; result: FetchResult | { error: string } }>> {
	const out: Array<{ providerId: string; result: FetchResult | { error: string } }> = [];
	for (const [pid, p] of Object.entries(providers)) {
		if (!p.baseUrl) continue;
		const apiKind: ApiKind = p.api === "google-generative-ai" ? "google" : "openai-compat";
		try {
			const result = await fetchListing({
				baseUrl: p.baseUrl,
				apiKey: p.apiKey,
				apiKind,
				signal,
				timeoutMs,
			});
			out.push({ providerId: pid, result });
		} catch (err) {
			out.push({ providerId: pid, result: { error: err instanceof Error ? err.message : String(err) } });
		}
	}
	return out;
}

// ============================================================================
// 合并逻辑
// ============================================================================

/** 把 FetchedModel[] 和现有 models[] 合并：去重（按 id）、用启发式生成新 model 字段。
 *  返回 { toAdd: ModelConfig[], toUpdate: ModelConfig[], skipped: string[] }
 *  - toAdd: 新 id（不在 existing）
 *  - toUpdate: 已存在 id（不更新，保持用户手工改的字段）
 *  - skipped: 跳过的 id（noise 等）
 *  - defaults: 透传给 inferModel（控制 ctx/max 和 thinkingLevelMap 等默认值） */
export function diffModels(
	fetched: FetchedModel[],
	existing: { id: string }[],
	overrides?: { contextWindow?: number; maxTokens?: number; defaults?: typeof DEFAULT_MODEL_CONFIG },
): { toAdd: ModelConfig[]; skipped: string[] } {
	const existingIds = new Set(existing.map((m) => m.id));
	const toAdd: ModelConfig[] = [];
	const skipped: string[] = [];
	for (const f of fetched) {
		if (isNoise(f.id)) {
			skipped.push(f.id);
			continue;
		}
		if (existingIds.has(f.id)) continue;  // 已存在不更新
		toAdd.push(inferModel(f.id, f, overrides));
	}
	return { toAdd, skipped };
}
