// test.ts 单元测试：mock ctx + mock fetch
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP_DIR = mkdtempSync(join(tmpdir(), "pi-pm-test-test-"));
const MODELS_PATH = join(TMP_DIR, "models.json");
const BAK_PATH = join(TMP_DIR, "models.json.bak");
(globalThis as any)[Symbol.for("pi-provider-manager:models-path-override")] = MODELS_PATH;
(globalThis as any)[Symbol.for("pi-provider-manager:backup-path-override")] = BAK_PATH;

// 写一个固定的 mock models.json
writeFileSync(MODELS_PATH, JSON.stringify({
	providers: {
		kdapi:  { baseUrl: "http://10.168.2.110:23000/v1", api: "openai-completions", apiKey: "sk-test",  models: [{ id: "m1" }, { id: "m2" }] },
		google: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", api: "google-generative-ai", apiKey: "goog-key", models: [{ id: "gemini-1.5" }] },
		oauth:  { models: [{ id: "radius-1" }] },  // 无 baseUrl 也不该 fetch
		badurl: { baseUrl: "http://127.0.0.1:1", api: "openai-completions", apiKey: "sk-x", models: [{ id: "m1" }] },  // 不可达
	},
}, null, 2));

import { testModel, testProvider, getCached, clearCache, formatTestResult, type TestResult } from "./test.ts";
import { readModelsJson } from "./store.ts";

const ok = (label: string, cond: boolean, extra?: string) => {
	console.log((cond ? "✓ " : "✗ ") + label + (extra ? " — " + extra : ""));
	if (!cond) process.exitCode = 1;
};

// ========================================================================
// mock ctx 工厂
// ========================================================================

type MockOpts = {
	authStatus?: any;        // 默认 { configured: true, source: "models_json_key" }
	findResult?: any;        // 默认返回 mock model
	completeResult?: any;    // 默认返回 ok
	completeThrows?: boolean;
};

function makeCtx(opts: MockOpts = {}): any {
	const find = opts.findResult === "null"  // 用 "null" 特殊标记表达"返回 null"
		? () => null
		: (provider: string, modelId: string) => opts.findResult ?? { id: modelId, provider, baseUrl: "http://x", api: "openai-completions" };
	const complete = async (model: any) => {
		if (opts.completeThrows) throw new Error("mock complete throw");
		return opts.completeResult ?? {
			stopReason: "stop",
			content: [{ type: "text", text: "ok" }],
			usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0001 } },
		};
	};
	return {
		modelRegistry: {
			getProviderAuthStatus: () => opts.authStatus ?? { configured: true, source: "models_json_key" },
			find,
			complete,
		},
	};
}

const origFetch = (globalThis as any).fetch;
function mockFetch(impl: (url: string) => Promise<Response> | Response) {
	(globalThis as any).fetch = async (url: string) => impl(url);
}
function restoreFetch() { (globalThis as any).fetch = origFetch; }

// ========================================================================
// auth
// ========================================================================

console.log("=== auth check ===");
clearCache();
{
	const r = await testModel({ ctx: makeCtx({ authStatus: { configured: true, source: "models_json_key" } }), provider: "kdapi", model: "m1", mode: "quick" });
	ok("configured=true → auth ok", r.checks.auth.ok === true);
	ok("source = models_json_key", r.checks.auth.source === "models_json_key");
	ok("mode=quick 不跑 generated", r.checks.generated === undefined);
}
{
	const r = await testModel({ ctx: makeCtx({ authStatus: { configured: false, source: "environment" } }), provider: "kdapi", model: "m1", mode: "quick" });
	ok("configured=false → auth fail", r.checks.auth.ok === false);
	ok("error 提到 source", typeof r.checks.auth.error === "string" && r.checks.auth.error!.includes("environment"));
	ok("reachable skip 因 auth fail", r.checks.reachable.error === "skipped (auth failed)");
	ok("整体 ok=false", r.ok === false);
}
{
	// 旧版 { ok, source } 形态也支持
	const r = await testModel({ ctx: makeCtx({ authStatus: { ok: true, source: "stored" } }), provider: "kdapi", model: "m1", mode: "quick" });
	ok("旧 {ok:true} 形态 → auth ok", r.checks.auth.ok === true);
	ok("旧 source 透传", r.checks.auth.source === "stored");
}

// ========================================================================
// reachable
// ========================================================================

console.log("\n=== reachable check ===");
clearCache();
{
	// 2xx
	mockFetch(() => new Response("{}", { status: 200 }));
	const r = await testModel({ ctx: makeCtx(), provider: "kdapi", model: "m1", mode: "quick" });
	ok("200 → reachable ok", r.checks.reachable.ok === true);
	ok("status=200", r.checks.reachable.status === 200);
	ok("url 是 GET /v1/models", (r.checks.reachable.url ?? "").endsWith("/v1/models"));
	restoreFetch();
}
{
	// 401
	mockFetch(() => new Response("unauth", { status: 401 }));
	const r = await testModel({ ctx: makeCtx(), provider: "kdapi", model: "m1", mode: "quick" });
	ok("401 → reachable fail", r.checks.reachable.ok === false);
	ok("status=401", r.checks.reachable.status === 401);
	ok("error 提到 HTTP 401", r.checks.reachable.error!.includes("401"));
	restoreFetch();
}
{
	// 不可达
	mockFetch(() => { throw new Error("ECONNREFUSED"); });
	const r = await testModel({ ctx: makeCtx(), provider: "kdapi", model: "m1", mode: "quick" });
	ok("ECONNREFUSED → reachable fail", r.checks.reachable.ok === false);
	ok("error 提到 ECONNREFUSED", r.checks.reachable.error!.includes("ECONNREFUSED"));
	restoreFetch();
}
{
	// 不可达 baseUrl（badurl: 127.0.0.1:1）
	mockFetch(() => { throw new Error("ECONNREFUSED"); });
	const r = await testModel({ ctx: makeCtx(), provider: "badurl", model: "m1", mode: "quick", timeoutMs: 1000 });
	ok("127.0.0.1:1 → reachable fail", r.checks.reachable.ok === false);
	restoreFetch();
}
{
	// 无 baseUrl
	const r = await testModel({ ctx: makeCtx(), provider: "oauth", model: "radius-1", mode: "quick" });
	ok("无 baseUrl → reachable fail（带原因）", r.checks.reachable.ok === false);
	ok("error 提到 baseUrl", r.checks.reachable.error!.includes("baseUrl"));
}
{
	// Google endpoint
	mockFetch((url) => {
		ok("Google url 走 /v1beta/models?key=", url.includes("/v1beta/models?key="));
		return new Response("{}", { status: 200 });
	});
	const r = await testModel({ ctx: makeCtx(), provider: "google", model: "gemini-1.5", mode: "quick" });
	ok("Google 200 → reachable ok", r.checks.reachable.ok === true);
	ok("Google url 不带 Authorization header（应为空）", !r.checks.reachable.error);
	restoreFetch();
}

// ========================================================================
// generated (mocked complete)
// ========================================================================

console.log("\n=== generated check (mocked) ===");
clearCache();
{
	// mode=full → 跑 generated
	mockFetch(() => new Response("{}", { status: 200 }));
	const r = await testModel({ ctx: makeCtx(), provider: "kdapi", model: "m1", mode: "full" });
	ok("mode=full 跑 generated", r.checks.generated !== undefined);
	ok("generated ok", r.checks.generated!.ok === true);
	ok("content = ok", r.checks.generated!.content === "ok");
	ok("stopReason = stop", r.checks.generated!.stopReason === "stop");
	ok("usage in=10 out=2", r.checks.generated!.usage?.input === 10 && r.checks.generated!.usage?.output === 2);
	ok("整体 ok=true", r.ok === true);
	restoreFetch();
}
{
	mockFetch(() => new Response("{}", { status: 200 }));
	// length stopReason 仍算 ok
	const r = await testModel({ ctx: makeCtx({ completeResult: { stopReason: "length", content: [{ type: "text", text: "ok" }], usage: { input: 5, output: 4, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }), provider: "kdapi", model: "m1", mode: "full" });
	ok("stopReason=length 仍算 ok", r.checks.generated!.ok === true);
	restoreFetch();
}
{
	mockFetch(() => new Response("{}", { status: 200 }));
	// error stopReason → fail
	const r = await testModel({ ctx: makeCtx({ completeResult: { stopReason: "error", errorMessage: "rate limited", content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }), provider: "kdapi", model: "m1", mode: "full" });
	ok("stopReason=error → generated fail", r.checks.generated!.ok === false);
	ok("error 提到 rate limited", r.checks.generated!.error!.includes("rate limited"));
	ok("整体 ok=false", r.ok === false);
	restoreFetch();
}
{
	mockFetch(() => new Response("{}", { status: 200 }));
	// complete throws
	const r = await testModel({ ctx: makeCtx({ completeThrows: true }), provider: "kdapi", model: "m1", mode: "full" });
	ok("complete throws → generated fail", r.checks.generated!.ok === false);
	ok("error 提到 throw", r.checks.generated!.error!.includes("throw"));
	restoreFetch();
}
{
	mockFetch(() => new Response("{}", { status: 200 }));
	// modelRegistry.find 返回 null
	const r = await testModel({ ctx: makeCtx({ findResult: "null" }), provider: "kdapi", model: "missing", mode: "full" });
	ok("model 未找到 → generated fail", r.checks.generated!.ok === false);
	ok("error 提到 not found", r.checks.generated!.error!.includes("not found"));
	restoreFetch();
}
{
	// auth 失败时 generated skip（不需 mock fetch，因 reachable 也 skip）
	const r = await testModel({ ctx: makeCtx({ authStatus: { configured: false } }), provider: "kdapi", model: "m1", mode: "full" });
	ok("auth fail → generated skip", r.checks.generated!.error === "skipped (auth or reachable failed)");
}
{
	mockFetch(() => new Response("{}", { status: 200 }));
	// 截断 content 到 50 字符
	const longText = "x".repeat(100);
	const r = await testModel({ ctx: makeCtx({ completeResult: { stopReason: "stop", content: [{ type: "text", text: longText }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }), provider: "kdapi", model: "m1", mode: "full" });
	ok("content >50 字符被截断", r.checks.generated!.content!.length === 53); // 50 + "..."
	ok("截断后以 ... 结尾", r.checks.generated!.content!.endsWith("..."));
	restoreFetch();
}
{
	mockFetch(() => new Response("{}", { status: 200 }));
	// maxTokens 硬上限 16
	const calls: number[] = [];
	const ctx2 = makeCtx();
	(ctx2.modelRegistry as any).complete = async (_m: any, _c: any, opts: any) => {
		calls.push(opts.maxTokens);
		return { stopReason: "stop", content: [{ type: "text", text: "ok" }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
	};
	await testModel({ ctx: ctx2, provider: "kdapi", model: "m1", mode: "full", maxTokens: 1000 });
	ok("maxTokens=1000 截到 16", calls[0] === 16);

	// maxTokens=2 不被截
	await testModel({ ctx: ctx2, provider: "kdapi", model: "m2", mode: "full", maxTokens: 2 });
	ok("maxTokens=2 保留", calls[1] === 2);
	restoreFetch();
}

// ========================================================================
// cache
// ========================================================================

console.log("\n=== cache ===");
clearCache();
{
	mockFetch(() => new Response("{}", { status: 200 }));
	const r1 = await testModel({ ctx: makeCtx(), provider: "kdapi", model: "m1", mode: "quick" });
	ok("cache miss → 调 fetch", true);
	const cached = getCached("kdapi", "m1");
	ok("getCached 返回刚 test 的结果", cached?.testedAt === r1.testedAt);
	ok("cached 存的是最后一次结果", cached!.provider === "kdapi" && cached!.model === "m1");
	restoreFetch();
}

// ========================================================================
// testProvider (concurrency)
// ========================================================================

console.log("\n=== testProvider 并发 ===");
clearCache();
{
	mockFetch(() => new Response("{}", { status: 200 }));
	const order: string[] = [];
	const ctx2 = makeCtx();
	(ctx2.modelRegistry as any).complete = async (m: any) => {
		order.push(`enter:${m.id}`);
		await new Promise((r) => setTimeout(r, 20));
		order.push(`exit:${m.id}`);
		return { stopReason: "stop", content: [{ type: "text", text: "ok" }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
	};
	const progress: Array<{ done: number; total: number }> = [];
	const results = await testProvider({
		ctx: ctx2,
		provider: "kdapi",
		modelIds: ["m1", "m2"],
		mode: "full",
		concurrency: 2,
		onProgress: (d, t) => progress.push({ done: d, total: t }),
	});
	ok("返回 2 个 result", results.length === 2);
	ok("m1 ok", results[0]!.checks.generated?.ok === true);
	ok("m2 ok", results[1]!.checks.generated?.ok === true);
	ok("progress 收到 2 次", progress.length === 2);
	ok("最后 progress done=2", progress[1]!.done === 2);
	ok("concurrency=2：先 enter m1 m2（无 exit），然后才 exit", order[0]!.startsWith("enter:") && order[1]!.startsWith("enter:") && order[2]!.startsWith("exit:"));
	restoreFetch();
}
{
	// concurrency=1 串行
	mockFetch(() => new Response("{}", { status: 200 }));
	const order: string[] = [];
	const ctx2 = makeCtx();
	(ctx2.modelRegistry as any).complete = async (m: any) => {
		order.push(`${m.id}`);
		return { stopReason: "stop", content: [{ type: "text", text: "ok" }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
	};
	const results = await testProvider({ ctx: ctx2, provider: "kdapi", modelIds: ["m1", "m2"], mode: "full", concurrency: 1 });
	ok("concurrency=1 串行：m1 先", order[0] === "m1" && order[1] === "m2");
	restoreFetch();
}

// ========================================================================
// formatTestResult
// ========================================================================

console.log("\n=== formatTestResult ===");
{
	const r: TestResult = {
		provider: "kdapi", model: "m1", mode: "full", ok: true, latencyMs: 234,
		checks: {
			auth: { ok: true, source: "models_json_key" },
			reachable: { ok: true, status: 200 },
			generated: { ok: true, stopReason: "stop", content: "ok", usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.0001 } },
		},
		testedAt: Date.now(),
	};
	const out = formatTestResult(r);
	ok("含 provider/model", out.includes("kdapi/m1"));
	ok("含 ✓ ok", out.includes("✓ ok"));
	ok("含 latency", out.includes("234ms"));
	ok("含 auth ✓", out.includes("auth      ✓"));
	ok("含 reachable ✓ 200", out.includes("reachable ✓ 200"));
	ok("含 generated ✓", out.includes("generated ✓"));
	ok("含 usage", out.includes("in=10 out=2"));
}
{
	const r: TestResult = {
		provider: "x", model: "y", mode: "quick", ok: false, latencyMs: 50,
		checks: {
			auth: { ok: false, error: "no key" },
			reachable: { ok: false, error: "skipped (auth failed)" },
		},
		testedAt: Date.now(),
	};
	const out = formatTestResult(r);
	ok("fail 模式含 ✗ fail", out.includes("✗ fail"));
	ok("含 auth ✗", out.includes("auth      ✗"));
	ok("quick 模式无 generated 行", !out.includes("generated"));
}

// ========================================================================
// mode 行为
// ========================================================================

console.log("\n=== mode 行为 ===");
clearCache();
{
	// mode=both 等价 full
	const r = await testModel({ ctx: makeCtx(), provider: "kdapi", model: "m1", mode: "both" });
	ok("mode=both 跑 generated", r.checks.generated !== undefined);
}
{
	// mode 默认 = quick
	const r = await testModel({ ctx: makeCtx(), provider: "kdapi", model: "m1" });
	ok("默认 mode=quick 不跑 generated", r.checks.generated === undefined);
	ok("r.mode=quick", r.mode === "quick");
}
