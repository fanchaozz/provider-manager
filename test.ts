/**
 * test.ts — model 可用性测试
 *
 * 3 档检查，每档独立返回 ok：
 *   - auth       modelRegistry.getProviderAuthStatus(provider) → configured? source?
 *   - reachable  GET `${baseUrl}/models`（或 Google 端点）期望 2xx
 *   - generated  modelRegistry.complete(...) 一次最小生成（maxTokens 硬上限 16）
 *
 * mode:
 *   - "quick" → auth + reachable
 *   - "full"  → generated（auth+reachable 也跑）
 *   - "both"  → 等价 "full"
 *
 * 安全：
 *   - 必传 signal，超时 10s（可改）
 *   - maxTokens 硬上限 16（即便 caller 传 1000 也截断）
 *   - 不并发跨 provider
 *   - 失败不重试
 *
 * 内存缓存：Map<"${provider}/${modelId}", TestResult>（会话级，不持久化）
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readModelsJson, type ModelsJson } from "./store.ts";

// ============================================================================
// Types
// ============================================================================

export type TestMode = "quick" | "full" | "both";

export type CheckResult = {
	ok: boolean;
	[key: string]: unknown;
};

export type TestResult = {
	provider: string;
	model: string;
	mode: TestMode;
	ok: boolean;
	latencyMs: number;
	checks: {
		auth: { ok: boolean; source?: string; label?: string; error?: string };
		reachable: { ok: boolean; status?: number; url?: string; error?: string };
		generated?: {
			ok: boolean;
			stopReason?: string;
			content?: string;       // 截断到 50 字符
			usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
			error?: string;
		};
	};
	testedAt: number;
};

// ============================================================================
// Cache (session-scoped, not persisted)
// ============================================================================

const cache = new Map<string, TestResult>();
const cacheKey = (provider: string, model: string) => `${provider}/${model}`;

export function getCached(provider: string, model: string): TestResult | undefined {
	return cache.get(cacheKey(provider, model));
}

export function clearCache(): void {
	cache.clear();
}

function storeCached(result: TestResult): void {
	cache.set(cacheKey(result.provider, result.model), result);
}

// ============================================================================
// Auth check
// ============================================================================

/** 把新旧两种 AuthStatus 形态（{ok, source} 和 {configured, source}）都接受 */
function isAuthOk(status: any): boolean {
	if (!status) return false;
	if (typeof status.ok === "boolean") return status.ok;
	if (typeof status.configured === "boolean") return status.configured;
	return false;
}

function authSource(status: any): string | undefined {
	return status?.source ?? status?.label;
}

function authLabel(status: any): string | undefined {
	return status?.label;
}

function checkAuth(ctx: ExtensionContext, provider: string): TestResult["checks"]["auth"] {
	let status: any;
	try {
		status = (ctx.modelRegistry as any).getProviderAuthStatus(provider);
	} catch (err) {
		return { ok: false, error: `auth check threw: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (isAuthOk(status)) {
		return { ok: true, source: authSource(status), label: authLabel(status) };
	}
	const src = authSource(status) ?? "unknown";
	return { ok: false, source: src, label: authLabel(status), error: `No key configured (source: ${src})` };
}

// ============================================================================
// Reachable check
// ============================================================================

/** 从 models.json 读 baseUrl/api（仅自定义 provider） */
function readProviderConfig(json: ModelsJson, provider: string): { baseUrl?: string; apiKey?: string; api?: string } {
	const p = json.providers[provider];
	if (!p) return {};
	const out: { baseUrl?: string; apiKey?: string; api?: string } = {};
	if (typeof p.baseUrl === "string") out.baseUrl = p.baseUrl;
	if (typeof p.apiKey === "string") out.apiKey = p.apiKey;
	if (typeof p.api === "string") out.api = p.api;
	return out;
}

function probeUrl(baseUrl: string, api: string | undefined, apiKey: string | undefined): { url: string; headers: Record<string, string> } {
	const base = baseUrl.replace(/\/+$/, "");
	if (api === "google-generative-ai") {
		const key = apiKey ? `?key=${encodeURIComponent(apiKey)}` : "";
		return { url: `${base}/models${key}`, headers: {} };
	}
	// OpenAI-compat / anthropic-messages 等统一走 GET /models
	const headers: Record<string, string> = {};
	if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
	return { url: `${base}/models`, headers };
}

async function checkReachable(json: ModelsJson, provider: string, timeoutMs: number, signal?: AbortSignal): Promise<TestResult["checks"]["reachable"]> {
	const cfg = readProviderConfig(json, provider);
	if (!cfg.baseUrl) {
		return { ok: false, error: `provider "${provider}" has no baseUrl in models.json; reachable check skipped` };
	}
	const { url, headers } = probeUrl(cfg.baseUrl, cfg.api, cfg.apiKey);

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(new Error("reachable timeout")), timeoutMs);
	const onAbort = () => ctrl.abort(signal!.reason);
	if (signal) signal.addEventListener("abort", onAbort);

	try {
		const res = await fetch(url, { method: "GET", headers, signal: ctrl.signal });
		const ok = res.status >= 200 && res.status < 300;
		// 不读 body，只要状态码
		try { await res.body?.cancel(); } catch { /* ignore */ }
		return ok
			? { ok: true, status: res.status, url }
			: { ok: false, status: res.status, url, error: `HTTP ${res.status} ${res.statusText}` };
	} catch (err) {
		return { ok: false, url, error: err instanceof Error ? err.message : String(err) };
	} finally {
		clearTimeout(timer);
		if (signal) signal.removeEventListener("abort", onAbort);
	}
}

// ============================================================================
// Generated check
// ============================================================================

const DEFAULT_PROMPT = "Reply with the single word: ok";
const DEFAULT_MAX_TOKENS = 4;
const HARD_MAX_TOKENS_CAP = 16;
const MAX_CONTENT_LEN = 50;

async function checkGenerated(opts: {
	ctx: ExtensionContext;
	modelId: string;
	provider: string;
	prompt?: string;
	maxTokens?: number;
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<TestResult["checks"]["generated"]> {
	const prompt = opts.prompt ?? DEFAULT_PROMPT;
	const requested = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
	const maxTokens = Math.min(Math.max(1, requested), HARD_MAX_TOKENS_CAP);

	// 找到 model 对象（modelRegistry 有 find(provider, id)）
	const model = (opts.ctx.modelRegistry as any).find?.(opts.provider, opts.modelId);
	if (!model) {
		return { ok: false, error: `model ${opts.provider}/${opts.modelId} not found in modelRegistry` };
	}

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(new Error("generated timeout")), opts.timeoutMs);
	const onAbort = () => ctrl.abort(opts.signal!.reason);
	if (opts.signal) opts.signal.addEventListener("abort", onAbort);

	const context = {
		systemPrompt: "You are a test probe. Reply concisely.",
		messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
	};

	try {
		const msg = await (opts.ctx.modelRegistry as any).complete(model, context, {
			signal: ctrl.signal,
			maxTokens,
		});
		const ok = msg?.stopReason === "stop" || msg?.stopReason === "length";
		const text = (msg?.content ?? [])
			.filter((c: any) => c?.type === "text")
			.map((c: any) => c.text)
			.join("");
		const content = text.length > MAX_CONTENT_LEN ? text.slice(0, MAX_CONTENT_LEN) + "..." : text;
		const usage = msg?.usage ? {
			input: msg.usage.input ?? 0,
			output: msg.usage.output ?? 0,
			cacheRead: msg.usage.cacheRead ?? 0,
			cacheWrite: msg.usage.cacheWrite ?? 0,
			cost: msg.usage.cost?.total ?? 0,
		} : undefined;
		return ok
			? { ok: true, stopReason: msg.stopReason, content, usage }
			: { ok: false, stopReason: msg?.stopReason, content, error: msg?.errorMessage ?? `stopReason=${msg?.stopReason}` };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	} finally {
		clearTimeout(timer);
		if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
	}
}

// ============================================================================
// Public API
// ============================================================================

export type TestModelOpts = {
	ctx: ExtensionContext;
	provider: string;
	model: string;
	mode?: TestMode;       // default "quick"
	prompt?: string;
	maxTokens?: number;
	timeoutMs?: number;    // default 10000
	signal?: AbortSignal;
};

/** 测单个 model；结果写入 cache */
export async function testModel(opts: TestModelOpts): Promise<TestResult> {
	const mode = opts.mode ?? "quick";
	const timeoutMs = opts.timeoutMs ?? parseInt(process.env.PI_PROVIDER_TEST_TIMEOUT ?? "10000", 10);

	const start = Date.now();
	const json = await readModelsJson();

	const checks: TestResult["checks"] = {
		auth: checkAuth(opts.ctx, opts.provider),
		reachable: { ok: false, error: "skipped" },
	};

	if (checks.auth.ok) {
		checks.reachable = await checkReachable(json, opts.provider, timeoutMs, opts.signal);
	} else {
		checks.reachable = { ok: false, error: "skipped (auth failed)" };
	}

	if (mode === "full" || mode === "both") {
		if (checks.auth.ok && checks.reachable.ok) {
			checks.generated = await checkGenerated({
				ctx: opts.ctx,
				provider: opts.provider,
				modelId: opts.model,
				prompt: opts.prompt,
				maxTokens: opts.maxTokens,
				timeoutMs,
				signal: opts.signal,
			});
		} else {
			checks.generated = { ok: false, error: "skipped (auth or reachable failed)" };
		}
	}

	const ok = checks.auth.ok && checks.reachable.ok && (checks.generated?.ok ?? true);
	const result: TestResult = {
		provider: opts.provider,
		model: opts.model,
		mode,
		ok,
		latencyMs: Date.now() - start,
		checks,
		testedAt: Date.now(),
	};
	storeCached(result);
	return result;
}

export type TestProviderOpts = {
	ctx: ExtensionContext;
	provider: string;
	modelIds: string[];
	mode?: TestMode;
	concurrency?: number;  // default 3
	timeoutMs?: number;
	signal?: AbortSignal;
	onProgress?: (done: number, total: number, result: TestResult) => void;
};

/** 批量测 provider 下多个 model；并发度默认 3 */
export async function testProvider(opts: TestProviderOpts): Promise<TestResult[]> {
	const concurrency = Math.max(1, opts.concurrency ?? 3);
	const total = opts.modelIds.length;
	const out: TestResult[] = [];
	let cursor = 0;
	let done = 0;

	async function worker(): Promise<void> {
		while (cursor < total) {
			const i = cursor++;
			const modelId = opts.modelIds[i];
			const result = await testModel({
				ctx: opts.ctx,
				provider: opts.provider,
				model: modelId,
				mode: opts.mode,
				timeoutMs: opts.timeoutMs,
				signal: opts.signal,
			});
			out[i] = result;
			done++;
			opts.onProgress?.(done, total, result);
		}
	}

	const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
	await Promise.all(workers);
	return out;
}

// ============================================================================
// Display helpers
// ============================================================================

/** 把 TestResult 格式化成多行可读文本（detail panel / notify） */
export function formatTestResult(r: TestResult): string {
	const lines: string[] = [];
	lines.push(`${r.provider}/${r.model}  ${r.ok ? "✓ ok" : "✗ fail"}  (${r.latencyMs}ms, mode=${r.mode})`);
	lines.push(`  auth      ${r.checks.auth.ok ? "✓" : "✗"} ${r.checks.auth.source ?? ""} ${r.checks.auth.error ? "— " + r.checks.auth.error : ""}`);
	lines.push(`  reachable ${r.checks.reachable.ok ? "✓" : "✗"} ${r.checks.reachable.status ?? ""} ${r.checks.reachable.error ? "— " + r.checks.reachable.error : ""}`);
	if (r.checks.generated) {
		const g = r.checks.generated;
		lines.push(`  generated ${g.ok ? "✓" : "✗"} ${g.stopReason ?? ""} ${g.content ? `— "${g.content}"` : ""} ${g.error ? "— " + g.error : ""}`);
		if (g.usage) lines.push(`            usage: in=${g.usage.input} out=${g.usage.output} cost=$${g.usage.cost.toFixed(6)}`);
	}
	return lines.join("\n");
}
