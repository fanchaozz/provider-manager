// 全局 audit：addProviderFlow / addModelFlow / editProviderFlow / editModelFlow /
// deleteProviderFlow / deleteModelFlow / restoreFromBackupFlow / syncFlow
// 的端到端边界 case 测试。
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP = mkdtempSync(join(tmpdir(), "pi-pm-audit-"));
(globalThis as any)[Symbol.for("pi-provider-manager:models-path-override")] = join(TMP, "m.json");
(globalThis as any)[Symbol.for("pi-provider-manager:backup-path-override")] = join(TMP, "m.bak");
(globalThis as any)[Symbol.for("pi-provider-manager:default-model-path-override")] = join(TMP, "pm.json");

const ok = (label: string, cond: boolean) => {
	console.log((cond ? "✓ " : "✗ ") + label);
	if (!cond) process.exitCode = 1;
};

function makeCtx(opts: { inputs?: any[]; customSelect?: string[]; customCancel?: boolean } = {}) {
	const q: any[] = [...(opts.inputs ?? [])];
	return {
		mode: "tui" as const,
		signal: undefined,
		modelRegistry: {
			getProvider: () => undefined,
			getProviderAuthStatus: () => ({ configured: true, source: "test" }),
		},
		ui: {
			notify: (msg: string) => { /* swallow */ },
			input: async () => { const v = q.shift(); return v === undefined ? undefined : String(v); },
			select: async () => { const v = q.shift(); return v === undefined ? undefined : String(v); },
			confirm: async () => { const v = q.shift(); return v === undefined ? undefined : Boolean(v); },
			custom: async <T>(factory: any): Promise<T> => {
				let result: T;
				const fakeDone = (v: T) => { result = v; };
				const comp = factory({}, { fg: (c: string, s: string) => s, bold: (s: string) => s, bg: () => "" }, {}, fakeDone);
				if (opts.customSelect && comp && comp.selected) comp.selected = new Set(opts.customSelect);
				if (opts.customCancel) {
					if (comp && comp.onCancel) comp.onCancel();
				} else {
					if (comp && comp.selected && typeof comp.onConfirm === "function") comp.onConfirm([...(comp.selected as Set<string>)]);
				}
				return result;
			},
		},
	} as any;
}

async function main() {
	const { writeModelsJson, readModelsJson } = await import("./store.ts");
	const { addProviderFlow, addModelFlow, editProviderFlow, editModelFlow, deleteProviderFlow, deleteModelFlow, restoreFromBackupFlow, syncFlow, ensureDefaultConfigFile, loadDefaultModelConfig } = await import("./forms.ts");
	const origFetch = (globalThis as any).fetch;

	// === 1. addProviderFlow 重复 id 不覆盖 ===
	writeFileSync(join(TMP, "m.json"), JSON.stringify({ providers: { kdapi: { baseUrl: "x", api: "openai-completions", models: [] } } }));
	await addProviderFlow(makeCtx({ inputs: ["kdapi", "", "http://y", "", "openai-completions"] }), "kdapi", () => undefined);
	const j1 = JSON.parse(readFileSync(join(TMP, "m.json"), "utf8"));
	ok("addProviderFlow 重复 id 不覆盖", j1.providers.kdapi.baseUrl === "x");

	// === 2. addProviderFlow id 非法 ===
	writeFileSync(join(TMP, "m.json"), JSON.stringify({ providers: {} }));
	await addProviderFlow(makeCtx({ inputs: ["BAD ID!", "good"] }), "good", () => undefined);
	const j2 = JSON.parse(readFileSync(join(TMP, "m.json"), "utf8"));
	ok("addProviderFlow 非法 id 没写", !j2.providers["BAD ID!"]);

	// === 3. addProviderFlow 全部 Esc 中断 ===
	writeFileSync(join(TMP, "m.json"), JSON.stringify({ providers: {} }));
	await addProviderFlow(makeCtx({ inputs: [] }), "kdapi", () => undefined);
	const j3 = JSON.parse(readFileSync(join(TMP, "m.json"), "utf8"));
	ok("addProviderFlow 全部 Esc → 不写", Object.keys(j3.providers).length === 0);

	// === 4. addModelFlow 重复 id ===
	writeFileSync(join(TMP, "m.json"), JSON.stringify({ providers: { kdapi: { baseUrl: "x", api: "openai-completions", models: [{ id: "existing" }] } } }));
	await addModelFlow(makeCtx({ inputs: ["existing", "", true] }), "kdapi", () => undefined);
	const j4 = JSON.parse(readFileSync(join(TMP, "m.json"), "utf8"));
	ok("addModelFlow 重复 id 不新增", j4.providers.kdapi.models.length === 1);

	// === 5. addModelFlow useDefaults=yes ===
	writeFileSync(join(TMP, "m.json"), JSON.stringify({ providers: { kdapi: { baseUrl: "x", api: "openai-completions", models: [] } } }));
	await addModelFlow(makeCtx({ inputs: ["m-yes", "", true] }), "kdapi", () => undefined);
	const j5 = JSON.parse(readFileSync(join(TMP, "m.json"), "utf8"));
	const m5 = j5.providers.kdapi.models[0];
	ok("addModelFlow useDefaults=yes 写入", j5.providers.kdapi.models.length === 1);
	ok("  reasoning=true", m5.reasoning === true);
	ok("  contextWindow=128000", m5.contextWindow === 128000);
	ok("  thinkingLevelMap.medium=medium", m5.thinkingLevelMap?.medium === "medium");

	// === 6. addModelFlow useDefaults=no (custom) ===
	writeFileSync(join(TMP, "m.json"), JSON.stringify({ providers: { kdapi: { baseUrl: "x", api: "openai-completions", models: [] } } }));
	await addModelFlow(makeCtx({ inputs: ["m-no", "", false, true, "text", "100000", "20000", "（不设 / 用 provider 默认）"] }), "kdapi", () => undefined);
	const j6 = JSON.parse(readFileSync(join(TMP, "m.json"), "utf8"));
	const m6 = j6.providers.kdapi.models[0];
	ok("addModelFlow useDefaults=no custom ctx", m6.contextWindow === 100000);
	ok("  custom max", m6.maxTokens === 20000);
	ok("  no thinking map", m6.thinkingLevelMap === undefined);

	// === 7. editModelFlow 跑通（用 customReturn 模拟 save）===
	writeFileSync(join(TMP, "m.json"), JSON.stringify({ providers: { kdapi: { baseUrl: "x", api: "openai-completions", models: [{ id: "m1", reasoning: false, input: ["text"] }] } } }));
	const ctx7 = makeCtx();
	ctx7.ui.custom = async <T>(factory: any): Promise<T> => {
		const comp = factory({}, { fg: (c: string, s: string) => s, bold: (s: string) => s, bg: () => "" }, {}, () => undefined);
		if (comp && comp.handleInput) comp.handleInput("s");
		return { saved: true, values: { name: "Updated", reasoning: "yes", input: ["text", "image"], contextWindow: 200000, maxTokens: 8192, thinkingLevelMap: null } } as T;
	};
	let editErr: any = null;
	try { await editModelFlow(ctx7, "kdapi", "m1", () => undefined); } catch (e) { editErr = e; }
	ok("editModelFlow 不抛错", editErr === null);

	// === 8. deleteModelFlow ===
	writeFileSync(join(TMP, "m.json"), JSON.stringify({ providers: { kdapi: { baseUrl: "x", api: "openai-completions", models: [{ id: "del" }, { id: "keep" }] } } }));
	await deleteModelFlow(makeCtx({ inputs: [true] }), "kdapi", "del", () => undefined);
	const j8 = JSON.parse(readFileSync(join(TMP, "m.json"), "utf8"));
	ok("deleteModelFlow 删目标", j8.providers.kdapi.models.length === 1 && j8.providers.kdapi.models[0].id === "keep");

	// === 9. deleteProviderFlow ===
	writeFileSync(join(TMP, "m.json"), JSON.stringify({ providers: { kdapi: { baseUrl: "x", api: "openai-completions", models: [] }, agnes: { baseUrl: "y", api: "openai-completions", models: [] } } }));
	await deleteProviderFlow(makeCtx({ inputs: [true] }), "kdapi", () => undefined);
	const j9 = JSON.parse(readFileSync(join(TMP, "m.json"), "utf8"));
	ok("deleteProviderFlow 删指定", !j9.providers.kdapi && !!j9.providers.agnes);

	// === 10. restoreFromBackupFlow ===
	const beforeRestore = readFileSync(join(TMP, "m.json"), "utf8");
	writeFileSync(join(TMP, "m.json"), JSON.stringify({ providers: {} }));
	await restoreFromBackupFlow(makeCtx({ inputs: [true] }), () => undefined);
	const j10 = JSON.parse(readFileSync(join(TMP, "m.json"), "utf8"));
	ok("restoreFromBackupFlow 恢复", Object.keys(j10.providers).length === 2);

	// === 11. syncFlow 全部勾 → existing + new 都加 ===
	writeFileSync(join(TMP, "m.json"), JSON.stringify({ providers: { kdapi: { baseUrl: "http://x", api: "openai-completions", models: [{ id: "o1" }] } } }));
	(globalThis as any).fetch = async () => new Response(JSON.stringify({ data: [{ id: "n1" }] }), { status: 200 });
	await syncFlow(makeCtx({ customSelect: ["o1", "n1"] }), { sourceProviderId: "kdapi" });
	const j11 = JSON.parse(readFileSync(join(TMP, "m.json"), "utf8"));
	ok("syncFlow 勾 o1+n1 → 2 个（o1 保留 + n1 新加）", j11.providers.kdapi.models.length === 2);
	ok("  o1 保留", j11.providers.kdapi.models.some((m: any) => m.id === "o1"));
	ok("  n1 已加", j11.providers.kdapi.models.some((m: any) => m.id === "n1"));

	// === 12. syncFlow 不勾 → 0 新 model 加入，existing 全保留 ===
	writeFileSync(join(TMP, "m.json"), JSON.stringify({ providers: { kdapi: { baseUrl: "http://x", api: "openai-completions", models: [{ id: "o1" }, { id: "o2" }] } } }));
	(globalThis as any).fetch = async () => new Response(JSON.stringify({ data: [{ id: "n1" }] }), { status: 200 });
	await syncFlow(makeCtx({ customSelect: ["o1", "o2"] }), { sourceProviderId: "kdapi" });
	const j12 = JSON.parse(readFileSync(join(TMP, "m.json"), "utf8"));
	ok("syncFlow 勾全部 existing（o1+o2 保留，n1 不加）→ 2 个", j12.providers.kdapi.models.length === 2);

	// === 13. syncFlow Esc → 不动 ===
	writeFileSync(join(TMP, "m.json"), JSON.stringify({ providers: { kdapi: { baseUrl: "http://x", api: "openai-completions", models: [{ id: "o1" }] } } }));
	(globalThis as any).fetch = async () => new Response(JSON.stringify({ data: [{ id: "n1" }] }), { status: 200 });
	await syncFlow(makeCtx({ customCancel: true }), { sourceProviderId: "kdapi" });
	const j13 = JSON.parse(readFileSync(join(TMP, "m.json"), "utf8"));
	ok("syncFlow Esc → o1 保留", j13.providers.kdapi.models.length === 1 && j13.providers.kdapi.models[0].id === "o1");

	// === 14. ensureDefaultConfigFile + loadDefaultModelConfig ===
	rmSync(join(TMP, "pm.json"), { force: true });
	const p = ensureDefaultConfigFile();
	ok("ensureDefaultConfigFile 首次写入", p === join(TMP, "pm.json"));
	const cfg = loadDefaultModelConfig();
	ok("loadDefaultModelConfig 读到默认", cfg.reasoning === true && cfg.contextWindow === 128000);
	const p2 = ensureDefaultConfigFile();
	ok("ensureDefaultConfigFile 第二次 null（已存在）", p2 === null);

	// === 15. syncFlow 默认 default-keep（existing 勾选，new 不勾选）===
	writeFileSync(join(TMP, "m.json"), JSON.stringify({ providers: { kdapi: { baseUrl: "http://x", api: "openai-completions", models: [{ id: "exist" }] } } }));
	(globalThis as any).fetch = async () => new Response(JSON.stringify({ data: [{ id: "exist" }, { id: "new1" }, { id: "new2" }] }), { status: 200 });
	const ctx15 = makeCtx();  // 不传 customSelect，让 preSelect 决定
	await syncFlow(ctx15, { sourceProviderId: "kdapi" });
	const j15 = JSON.parse(readFileSync(join(TMP, "m.json"), "utf8"));
	ok("default-keep: 只 exist 在（new 不加）", j15.providers.kdapi.models.length === 1 && j15.providers.kdapi.models[0].id === "exist");

	// === 16. syncFlow 用户主动勾 new 后会加入 ===
	writeFileSync(join(TMP, "m.json"), JSON.stringify({ providers: { kdapi: { baseUrl: "http://x", api: "openai-completions", models: [{ id: "exist" }] } } }));
	(globalThis as any).fetch = async () => new Response(JSON.stringify({ data: [{ id: "exist" }, { id: "new1" }] }), { status: 200 });
	const ctx16 = makeCtx({ customSelect: ["exist", "new1"] });
	await syncFlow(ctx16, { sourceProviderId: "kdapi" });
	const j16 = JSON.parse(readFileSync(join(TMP, "m.json"), "utf8"));
	ok("勾 exist+new1 → 2 个", j16.providers.kdapi.models.length === 2);

	(globalThis as any).fetch = origFetch;
	rmSync(TMP, { recursive: true, force: true });
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
