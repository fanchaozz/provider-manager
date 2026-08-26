// 测试 addModelFlow 的 thinkingLevelMap + onDone undefined
import { readModelsJson } from "./store.ts";
import { addModelFlow } from "./forms.ts";

const ok = (label: string, cond: boolean) => console.log((cond ? "✓ " : "✗ ") + label);

async function main() {
	// 准备 temp 路径
	const { mkdtempSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	const TMP_DIR = mkdtempSync(join(tmpdir(), "pi-pm-forms-tlm-"));
	(globalThis as any)[Symbol.for("pi-provider-manager:models-path-override")] = join(TMP_DIR, "models.json");
	(globalThis as any)[Symbol.for("pi-provider-manager:backup-path-override")] = join(TMP_DIR, "models.json.bak");

	// mock ctx
	function mockCtx(inputs: (string | boolean | undefined)[]) {
		const queue = [...inputs];
		return {
			mode: "tui",
			modelRegistry: { getProvider: () => undefined, getProviderAuthStatus: () => ({ ok: true }) },
			ui: {
				notify: () => undefined,
				input: async (_t: string, _p?: string) => { const v = queue.shift(); return v === undefined ? undefined : String(v); },
				select: async (_t: string, _o: string[]) => { const v = queue.shift(); return v === undefined ? undefined : String(v); },
				confirm: async (_t: string, _m: string) => { const v = queue.shift(); return v === undefined ? undefined : Boolean(v); },
			},
		} as any;
	}

	// 初始 state
	const { writeModelsJson } = await import("./store.ts");
	await writeModelsJson({ providers: { kdapi: { baseUrl: "x", api: "openai-completions", apiKey: "k", models: [{ id: "old" }] } } }, { backup: false });
	const target = Object.keys((await readModelsJson()).providers)[0]!;

	console.log("=== thinkingLevelMap: preset Anthropic 风格 ===");
	{
		const ctx = mockCtx([
			"claude-opus-4-7",
			"",
			false,        // useDefaults=no
			true,        // reasoning
			"text",
			"200000",
			"32000",
			"Anthropic 风格 (low/medium/high/max → 同名 + off=null, minimal=null)",
		]);
		await addModelFlow(ctx, target, () => undefined);
		const m = (await readModelsJson()).providers[target].models.find((mm: any) => mm.id === "claude-opus-4-7");
		ok("claude-opus-4-7 已添加", !!m);
		ok("reasoning=true", m?.reasoning === true);
		ok("thinkingLevelMap.low", m?.thinkingLevelMap?.low === "low");
		ok("thinkingLevelMap.medium", m?.thinkingLevelMap?.medium === "medium");
		ok("thinkingLevelMap.max", m?.thinkingLevelMap?.max === "max");
		ok("thinkingLevelMap.off=null", m?.thinkingLevelMap?.off === null);
		ok("thinkingLevelMap.xhigh=null", m?.thinkingLevelMap?.xhigh === null);
	}

	console.log("\n=== onDone undefined 不崩（异常 providerId）===");
	{
		const ctx = mockCtx([]);
		let crashed = false;
		let err: any = null;
		try {
			await addModelFlow(ctx, "nonexistent-provider-xyz", undefined);
		} catch (e) {
			crashed = true;
			err = e;
		}
		ok("不抛异常", !crashed);
		if (crashed) console.log("  error:", err);
	}

	console.log("\n=== thinkingLevelMap: 选不设 → map 保持 undefined ===");
	{
		const ctx = mockCtx([
			"m-no-map", "", false,        // useDefaults=no (fall through)
			true, "text", "100000", "16384",
			"（不设 / 用 provider 默认）",
		]);
		await addModelFlow(ctx, target, () => undefined);
		const m = (await readModelsJson()).providers[target].models.find((mm: any) => mm.id === "m-no-map");
		ok("m-no-map 还是加上了", !!m);
		ok("thinkingLevelMap 是 undefined（user 没选 preset）", m?.thinkingLevelMap === undefined);
	}

	console.log("\n=== thinkingLevelMap: Custom (Enter JSON 解析失败 graceful skip) ===");
	{
		const ctx = mockCtx([
			"m2", "", false,            // useDefaults=no
			true, "text", "100000", "16384",
			"Custom (Enter 自填 JSON)",
			"{bad json",
		]);
		await addModelFlow(ctx, target, () => undefined);
		const m = (await readModelsJson()).providers[target].models.find((mm: any) => mm.id === "m2");
		ok("m2 还是加上了（thinkingLevelMap 跳过）", !!m);
		ok("thinkingLevelMap 是 undefined（user 没选 preset）", m?.thinkingLevelMap === undefined);
	}
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
