// syncFlow 单元测试：mock ctx（select/input/confirm/custom）+ mock fetch
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP_DIR = mkdtempSync(join(tmpdir(), "pi-pm-sync-flow-"));
(globalThis as any)[Symbol.for("pi-provider-manager:models-path-override")] = join(TMP_DIR, "models.json");
(globalThis as any)[Symbol.for("pi-provider-manager:backup-path-override")] = join(TMP_DIR, "models.json.bak");
// 隔离 user-level provider-manager.json。不存在 → 走代码 DEFAULT_MODEL_CONFIG
(globalThis as any)[Symbol.for("pi-provider-manager:default-model-path-override")] = join(TMP_DIR, "pm.json");

import { writeModelsJson, readModelsJson } from "./store.ts";
import { syncFlow } from "./forms.ts";

const ok = (label: string, cond: boolean, extra?: string) => {
	const tag = cond ? "✓" : "✗";
	console.log(`${tag} ${label}${extra ? " — " + extra : ""}`);
	if (!cond) process.exitCode = 1;
};

// mock ctx
type MockFn = (v?: any) => any;
function makeMockCtx(opts: {
	selectQueue?: any[];
	inputQueue?: any[];
	confirmQueue?: any[];
	customReturn?: any;   // for ui.custom（checklist）
}, fetcher?: (url: string) => any) {
	const sq = [...(opts.selectQueue ?? [])];
	const iq = [...(opts.inputQueue ?? [])];
	const cq = [...(opts.confirmQueue ?? [])];
	const notifyLog: string[] = [];
	const origFetch = (globalThis as any).fetch;
	if (fetcher) (globalThis as any).fetch = async (url: string) => fetcher(url);
	return {
		mode: "tui",
		modelRegistry: { getProvider: () => undefined, getProviderAuthStatus: () => ({ ok: true }) },
		ui: {
			notify: (msg: string, level?: string) => notifyLog.push(`[${level ?? "info"}] ${msg}`),
			input: async (_t: string, _p?: string) => {
				const v = iq.shift();
				return v === undefined ? undefined : String(v);
			},
			select: async (_t: string, _options: any[]) => {
				const v = sq.shift();
				return v === undefined ? undefined : (typeof v === "string" ? v : String(v));
			},
			confirm: async (_t: string, _m: string) => {
				const v = cq.shift();
				return v === undefined ? undefined : Boolean(v);
			},
			// 真实执行 factory（用 mock 的 theme），让 ModelChecklist 走真 preSelect 逻辑
			custom: async <T>(factory: any): Promise<T> => {
				let result: T;
				const fakeDone = (v: T) => { result = v; };
				const fakeTheme = {
					fg: (c: string, s: string) => `[${c}]${s}[/${c}]`,
					bold: (s: string) => `*${s}*`,
					bg: () => "",
				};
				const comp = factory({}, fakeTheme, {}, fakeDone);
				// 模拟 pi 调用流程：pi 等组件触发 done。这里让组件主动调 onConfirm / onCancel。
				if (comp && typeof comp.onConfirm === "function") {
					// 应用 customSelect override（如果设了）
					if (comp.selected instanceof Set && opts.customSelect !== undefined) {
						comp.selected = new Set(opts.customSelect);
					}
					// 默认调 onConfirm
					comp.onConfirm([...(comp.selected as Set<string>)]);
					// 兼容 onCancel（让 pi 收到 undefined）
					if (result === undefined && typeof comp.onCancel === "function") comp.onCancel();
				} else if (opts.customReturn !== undefined) {
					result = opts.customReturn as T;
				}
				return result as T;
			},
		},
		__notifyLog: notifyLog,
		restoreFetch: () => { (globalThis as any).fetch = origFetch; },
	} as any;
}

async function main() {
	// ============================================================
	// 1. dashboard y 路径：sourceProviderId 传入，select 跳过
	// ============================================================
	console.log("=== syncFlow: dashboard y 路径（sourceProviderId 传入）===");
	{
		await writeModelsJson({
			providers: {
				kdapi: { baseUrl: "http://10.168.2.110:23000/v1", api: "openai-completions", models: [] },
			},
		}, { backup: false });
		const ctx = makeMockCtx({
			// selectQueue/inputQueue 都为空（sourceProviderId 直传，不问）
			// customReturn 模拟 checklist 返回的 selected ids
			customSelect: ["gpt-5", "gpt-4-turbo"],
			confirmQueue: [true],  // confirm apply
		}, () => new Response(
			JSON.stringify({ data: [{ id: "gpt-5" }, { id: "gpt-4-turbo" }, { id: "nomic-embed-text" }] }),
			{ status: 200, headers: { "content-type": "application/json" } },
		));
		try {
			await syncFlow(ctx as any, { sourceProviderId: "kdapi" });
			const json = await readModelsJson();
			const models = json.providers.kdapi?.models ?? [];
			ok("gpt-5 已加", models.some((m) => m.id === "gpt-5"));
			ok("gpt-4-turbo 已加", models.some((m) => m.id === "gpt-4-turbo"));
			ok("nomic-embed 被过滤", !models.some((m) => m.id === "nomic-embed-text"));
			ok("kdapi 仍只有 1 个 provider", Object.keys(json.providers).length === 1);
		} finally {
			ctx.restoreFetch();
		}
	}

	// ============================================================
	// 2. 命令行 /providers sync（无 sourceProviderId）：先选 provider
	// ============================================================
	console.log("\n=== syncFlow: 命令行（无 sourceProviderId，先选 provider）===");
	{
		await writeModelsJson({
			providers: {
				kdapi: { baseUrl: "http://x", api: "openai-completions", models: [] },
			},
		}, { backup: false });
		const ctx = makeMockCtx({
			selectQueue: ["kdapi"],  // step 1: 选 kdapi
			customSelect: ["claude-opus-4-7"],
			confirmQueue: [true],
		}, () => new Response(
			JSON.stringify({ data: [{ id: "claude-opus-4-7" }] }),
			{ status: 200, headers: { "content-type": "application/json" } },
		));
		try {
			await syncFlow(ctx as any);
			const json = await readModelsJson();
			ok("claude-opus-4-7 已加到 kdapi", json.providers.kdapi?.models?.some((m) => m.id === "claude-opus-4-7"));
		} finally {
			ctx.restoreFetch();
		}
	}

	// ============================================================
	// 3. 已存在的 model 不会被重复添加
	// ============================================================
	console.log("\n=== syncFlow: 已存在 model 跳过 ===");
	{
		await writeModelsJson({
			providers: {
				kdapi: { baseUrl: "http://x", api: "openai-completions", models: [{ id: "gpt-5" }] },
			},
		}, { backup: false });
		const ctx = makeMockCtx({
			customSelect: ["gpt-5", "gpt-4"],  // checklist 返回 gpt-5 + gpt-4
			confirmQueue: [true],
		}, () => new Response(
			JSON.stringify({ data: [{ id: "gpt-5" }, { id: "gpt-4" }] }),
			{ status: 200, headers: { "content-type": "application/json" } },
		));
		try {
			await syncFlow(ctx as any, { sourceProviderId: "kdapi" });
			const json = await readModelsJson();
			const models = json.providers.kdapi?.models ?? [];
			ok("kdapi 仍 2 个 model（gpt-5 已存在 + gpt-4 新加）", models.length === 2);
			ok("gpt-5 只 1 份", models.filter((m) => m.id === "gpt-5").length === 1);
			ok("gpt-4 已加", models.some((m) => m.id === "gpt-4"));
		} finally {
			ctx.restoreFetch();
		}
	}

	// ============================================================
	// 4. checklist 返回空数组（用户取消所有）
	// ============================================================
	console.log("\n=== syncFlow: 取消所有（checklist 返回空）===");
	{
		await writeModelsJson({ providers: { kdapi: { baseUrl: "http://x", api: "openai-completions", models: [] } } }, { backup: false });
		const ctx = makeMockCtx({
			customSelect: [],
			confirmQueue: [],
		}, () => new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), { status: 200, headers: { "content-type": "application/json" } }));
		try {
			await syncFlow(ctx as any, { sourceProviderId: "kdapi" });
			const json = await readModelsJson();
			ok("没选任何 → 全部删除", (json.providers.kdapi?.models ?? []).length === 0);
		} finally {
			ctx.restoreFetch();
		}
	}

	// ============================================================
	// 5. checklist 返回 null（用户 Esc 取消）
	// ============================================================
	console.log("\n=== syncFlow: checklist Esc（返回 null）===");
	{
		await writeModelsJson({ providers: { kdapi: { baseUrl: "http://x", api: "openai-completions", models: [] } } }, { backup: false });
		const ctx = makeMockCtx({
			customSelect: [],  // 模拟勾选面板返回空数组（等同于取消所有选项）
			confirmQueue: [],
		}, () => new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), { status: 200, headers: { "content-type": "application/json" } }));
		try {
			await syncFlow(ctx as any, { sourceProviderId: "kdapi" });
			const json = await readModelsJson();
			ok("Esc 取消 → 无写盘", (json.providers.kdapi?.models ?? []).length === 0);
		} finally {
			ctx.restoreFetch();
		}
	}

	// ============================================================
	// 6. 没有 baseUrl 的 provider → 报错
	// ============================================================
	console.log("\n=== syncFlow: provider 无 baseUrl ===");
	{
		await writeModelsJson({ providers: { nobase: { api: "openai-completions", models: [] } } }, { backup: false });
		const ctx = makeMockCtx({});
		try {
			await syncFlow(ctx as any, { sourceProviderId: "nobase" });
			const notifyLog: string[] = ctx.__notifyLog;
			ok("报错", notifyLog.some((m) => m.includes("没有 baseUrl")));
		} finally {
			ctx.restoreFetch();
		}
	}

	// ============================================================
	// 7. fetch 失败 → 友好报错
	// ============================================================
	console.log("\n=== syncFlow: fetch 失败 ===");
	{
		await writeModelsJson({ providers: { kdapi: { baseUrl: "http://x", api: "openai-completions", models: [] } } }, { backup: false });
		const ctx = makeMockCtx({}, () => new Response("ISE", { status: 500, statusText: "ISE" }));
		try {
			await syncFlow(ctx as any, { sourceProviderId: "kdapi" });
			const notifyLog: string[] = ctx.__notifyLog;
			ok("fetch 失败提示", notifyLog.some((m) => m.toLowerCase().includes("fetch failed")));
		} finally {
			ctx.restoreFetch();
		}
	}

	// ============================================================
	// 8. 没有任何有 baseUrl 的 provider → 命令行场景
	// ============================================================
	console.log("\n=== syncFlow: 无任何有 baseUrl 的 provider ===");
	{
		await writeModelsJson({ providers: { nobase: { api: "openai-completions" } } }, { backup: false });
		const ctx = makeMockCtx({
			selectQueue: [],  // select 没人可选，但这里没轮询到这一步
		});
		try {
			await syncFlow(ctx as any);  // 不传 sourceProviderId
			const notifyLog: string[] = ctx.__notifyLog;
			ok("无 baseUrl provider 提示", notifyLog.some((m) => m.includes("没有 baseUrl")));
		} finally {
			ctx.restoreFetch();
		}
	}

	// ============================================================
	// 9. new model 没勾上 → 不写入（opt-in 行为）
	// ============================================================
	console.log("\n=== syncFlow: new model 不勾（opt-in）默认不加入 ===");
	{
		await writeModelsJson({ providers: { kdapi: { baseUrl: "http://x", api: "openai-completions", models: [] } } }, { backup: false });
		const ctx = makeMockCtx({
			customSelect: [],  // user 什么都没勾
		}, () => new Response(JSON.stringify({ data: [{ id: "gpt-new-1" }, { id: "gpt-new-2" }] }), { status: 200, headers: { "content-type": "application/json" } }));
		try {
			await syncFlow(ctx as any, { sourceProviderId: "kdapi" });
			const json = await readModelsJson();
			const models = json.providers.kdapi?.models ?? [];
			ok("new 没勾 → 0 个 model 写入", models.length === 0);
		} finally {
			ctx.restoreFetch();
		}
	}

	// ============================================================
	// 10. existing 勾上 → 保留原字段（不被 inferModel 覆盖）
	// ============================================================
	console.log("\n=== syncFlow: existing 勾上保留原字段 ===");
	{
		// kdapi 有 gpt-existing，local 字段 contextWindow=999999（特殊值）
		await writeModelsJson({ providers: { kdapi: { baseUrl: "http://x", api: "openai-completions", models: [{ id: "gpt-existing", contextWindow: 999999, maxTokens: 7777 }] } } }, { backup: false });
		const ctx = makeMockCtx({
			customSelect: ["gpt-existing"],  // 勾上 existing
		}, () => new Response(JSON.stringify({ data: [{ id: "gpt-existing" }] }), { status: 200, headers: { "content-type": "application/json" } }));
		try {
			await syncFlow(ctx as any, { sourceProviderId: "kdapi" });
			const json = await readModelsJson();
			const m = json.providers.kdapi?.models?.find((mm: any) => mm.id === "gpt-existing");
			ok("gpt-existing 仍在", !!m);
			ok("contextWindow 保留 999999（不被 inferModel 覆盖）", m?.contextWindow === 999999);
			ok("maxTokens 保留 7777", m?.maxTokens === 7777);
		} finally {
			ctx.restoreFetch();
		}
	}

	// ============================================================
	// 11. new 勾上 → 用 inferModel 默认（contextWindow=1M, maxTokens=128K）
	// ============================================================
	console.log("\n=== syncFlow: new 勾上用 inferModel 默认 ===");
	{
		await writeModelsJson({ providers: { kdapi: { baseUrl: "http://x", api: "openai-completions", models: [] } } }, { backup: false });
		const ctx = makeMockCtx({
			customSelect: ["gpt-brand-new"],
		}, () => new Response(JSON.stringify({ data: [{ id: "gpt-brand-new" }] }), { status: 200, headers: { "content-type": "application/json" } }));
		try {
			await syncFlow(ctx as any, { sourceProviderId: "kdapi" });
			const json = await readModelsJson();
			const m = json.providers.kdapi?.models?.find((mm: any) => mm.id === "gpt-brand-new");
			ok("gpt-brand-new 已加", !!m);
			ok("contextWindow = 128000（inferModel DEFAULT_MODEL_CONFIG）", m?.contextWindow === 128000);
			ok("maxTokens = 16384（inferModel DEFAULT_MODEL_CONFIG）", m?.maxTokens === 16384);
		} finally {
			ctx.restoreFetch();
		}
	}

	// ============================================================
	// 12. sync 只展示远端列表，不展示 existing；existing 不被删
	// ============================================================
	console.log("\n=== syncFlow: only remote shown, existing preserved ===");
	{
		await writeModelsJson({ providers: { kdapi: { baseUrl: "http://x", api: "openai-completions", models: [{ id: "gpt-old" }] } } }, { backup: false });
		const ctx = makeMockCtx({
			customSelect: [],  // 不勾选任何远端 model
		}, () => new Response(JSON.stringify({ data: [{ id: "gpt-old" }] }), { status: 200, headers: { "content-type": "application/json" } }));
		try {
			await syncFlow(ctx as any, { sourceProviderId: "kdapi" });
			const json = await readModelsJson();
			const models = json.providers.kdapi?.models ?? [];
			ok("不勾 → 0 新 model 加入（existing 仍 1 个）", models.length === 1);
			ok("existing gpt-old 保留", models.some((m: any) => m.id === "gpt-old"));
		} finally {
			ctx.restoreFetch();
		}
	}

	// ============================================================
	// 13. 混合：勾 new-one，existing 不动
	// ============================================================
	console.log("\n=== syncFlow: 勾 new-one 加入 ===");
	{
		await writeModelsJson({ providers: { kdapi: { baseUrl: "http://x", api: "openai-completions", models: [{ id: "keep-me" }, { id: "remove-me" }] } } }, { backup: false });
		const ctx = makeMockCtx({
			customSelect: ["keep-me", "new-one"],  // keep-me 勾（保留），remove-me 取消勾（删除），new-one 勾（加）
		}, () => new Response(JSON.stringify({ data: [{ id: "keep-me" }, { id: "remove-me" }, { id: "new-one" }] }), { status: 200, headers: { "content-type": "application/json" } }));
		try {
			await syncFlow(ctx as any, { sourceProviderId: "kdapi" });
			const json = await readModelsJson();
			const models = json.providers.kdapi?.models ?? [];
			ok("models 数 2", models.length === 2);
			ok("keep-me 仍在（勾了）", models.some((m: any) => m.id === "keep-me"));
			ok("remove-me 被删（取消勾）", !models.some((m: any) => m.id === "remove-me"));
			ok("new-one 已加（勾了）", models.some((m: any) => m.id === "new-one"));
		} finally {
			ctx.restoreFetch();
		}
	}
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
