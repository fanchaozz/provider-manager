// 测试 sync 路径下新加 model 的 thinkingLevelMap 走 loadDefaultModelConfig（change 7 修复）
// addModelFlow 现在也是真表单（useDefault=yes/no）了—同样会读 loadDefaultModelConfig 拿 thinkingLevelMap。
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP = mkdtempSync(join(tmpdir(), "pi-pm-tlmap-"));
(globalThis as any)[Symbol.for("pi-provider-manager:models-path-override")] = join(TMP, "m.json");
(globalThis as any)[Symbol.for("pi-provider-manager:backup-path-override")] = join(TMP, "m.bak");
(globalThis as any)[Symbol.for("pi-provider-manager:default-model-path-override")] = join(TMP, "pm.json");

const ok = (label: string, cond: boolean) => console.log((cond ? "✓ " : "✗ ") + label);

async function main() {
	const { writeModelsJson, readModelsJson } = await import("./store.ts");
	const { inferModel, diffModels } = await import("./sync.ts");
	const { loadDefaultModelConfig } = await import("./forms.ts");

	console.log("=== inferModel 用代码默认（无 user override）===");
	{
		// 清空 user override 走代码 DEFAULT_MODEL_CONFIG
		rmSync(join(TMP, "pm.json"), { force: true });
		const defaults = loadDefaultModelConfig();
		ok("defaults.medium = medium", defaults.thinkingLevelMap.medium === "medium");
		ok("defaults.off = null", defaults.thinkingLevelMap.off === null);
		const m = inferModel("claude-opus-4-7", { id: "claude-opus-4-7" }, { defaults });
		ok("新 model medium=medium", m.thinkingLevelMap?.medium === "medium");
		ok("新 model off=null", m.thinkingLevelMap?.off === null);
	}

	console.log("\n=== inferModel 用 user override（Anthropic 风格）===");
	{
		const userDefaults = {
			reasoning: true,
			input: ["text", "image"] as ("text" | "image")[],
			contextWindow: 200000,
			maxTokens: 32000,
			thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: "max" },
		};
		writeFileSync(join(TMP, "pm.json"), JSON.stringify({ defaultModel: userDefaults }, null, 2));
		const defaults = loadDefaultModelConfig();
		ok("user defaults 加载", defaults.thinkingLevelMap.max === "max");
		const m = inferModel("claude-opus-4-7", { id: "claude-opus-4-7" }, { defaults });
		ok("新 model thinkingLevelMap.low = low", m.thinkingLevelMap?.low === "low");
		ok("新 model thinkingLevelMap.high = high", m.thinkingLevelMap?.high === "high");
		ok("新 model thinkingLevelMap.max = max", m.thinkingLevelMap?.max === "max");
		ok("新 model thinkingLevelMap.xhigh = null", m.thinkingLevelMap?.xhigh === null);
	}

	console.log("\n=== diffModels 透传 defaults → toAdd 应用 user override ===");
	{
		const userDefaults = {
			reasoning: true,
			input: ["text", "image"] as ("text" | "image")[],
			contextWindow: 200000,
			maxTokens: 32000,
			thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: "max" },
		};
		const fetched = [{ id: "gpt-5" }, { id: "o1-preview" }];
		const existing = [{ id: "old" }];
		const { toAdd, skipped } = diffModels(fetched, existing, { defaults: userDefaults });
		ok("toAdd 长度 2", toAdd.length === 2);
		ok("skipped 长度 0", skipped.length === 0);
		const gpt5 = toAdd.find((m) => m.id === "gpt-5")!;
		ok("gpt-5.maxTokens 用 user override (32000)", gpt5.maxTokens === 32000);
		ok("gpt-5.contextWindow 用 user override (200000)", gpt5.contextWindow === 200000);
		ok("gpt-5.thinkingLevelMap.max = max", gpt5.thinkingLevelMap?.max === "max");
		const o1 = toAdd.find((m) => m.id === "o1-preview")!;
		ok("o1-preview 用 user override", o1.thinkingLevelMap?.high === "high");
	}

	console.log("\n=== syncFlow 传递 user defaults（修复 key 7 的核心断言）===");
	{
		// 准备 user override
		const userDefaults = {
			reasoning: true,
			input: ["text", "image"] as ("text" | "image")[],
			contextWindow: 500000,
			maxTokens: 64000,
			thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: "high", xhigh: null, max: "max" },
		};
		writeFileSync(join(TMP, "pm.json"), JSON.stringify({ defaultModel: userDefaults }, null, 2));

		const { syncFlow } = await import("./forms.ts");
		await writeModelsJson({ providers: { kdapi: { baseUrl: "http://x", api: "openai-completions", models: [{ id: "old" }] } } }, { backup: false });
		const origFetch = (globalThis as any).fetch;
		(globalThis as any).fetch = async () => new Response(JSON.stringify({ data: [{ id: "new1" }, { id: "new2" }] }), { status: 200 });
		const ctx: any = {
			mode: "tui",
			signal: undefined,
			modelRegistry: { getProvider: () => undefined, getProviderAuthStatus: () => ({ ok: true }) },
			ui: {
				notify: () => undefined,
				input: async () => undefined,
				select: async () => undefined,
				confirm: async () => undefined,
				custom: async <T>(factory: any): Promise<T> => {
					let result: T;
					const fakeDone = (v: T) => { result = v; };
					const comp = factory({}, { fg: (c: string, s: string) => s, bold: (s: string) => s, bg: () => "" }, {}, fakeDone);
					// preSelect 默认勾 existing；我们把 new1 + new2 也勾上
					if (comp && comp.selected) {
						comp.selected.add("new1");
						comp.selected.add("new2");
						comp.onConfirm([...(comp.selected as Set<string>)]);
					}
					return result!;
				},
			},
		};
		await syncFlow(ctx, { sourceProviderId: "kdapi" });
		(globalThis as any).fetch = origFetch;

		const j = await readModelsJson();
		const new1 = j.providers.kdapi.models.find((m: any) => m.id === "new1");
		ok("new1 已加", !!new1);
		ok("new1.maxTokens = 64000（user default，非代码 16384）", new1?.maxTokens === 64000);
		ok("new1.contextWindow = 500000（user default，非代码 128000）", new1?.contextWindow === 500000);
		ok("new1.thinkingLevelMap.max = max（user 覆盖）", new1?.thinkingLevelMap?.max === "max");
	}

	rmSync(TMP, { recursive: true, force: true });
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
