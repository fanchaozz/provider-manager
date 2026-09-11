// TestPanel 浮窗测试：t/T 的测试结果现在以 overlay 展示（不再走对话窗口 notify）
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP = mkdtempSync(join(tmpdir(), "pi-pm-testpanel-"));
const MODELS_PATH = join(TMP, "models.json");
const BAK_PATH = join(TMP, "models.json.bak");
(globalThis as any)[Symbol.for("pi-provider-manager:models-path-override")] = MODELS_PATH;
(globalThis as any)[Symbol.for("pi-provider-manager:backup-path-override")] = BAK_PATH;

const providers: Record<string, any> = {
	kdapi: {
		baseUrl: "http://mock.test/v1",
		api: "openai-completions",
		apiKey: "sk-mock",
		models: Array.from({ length: 20 }, (_, j) => ({ id: `m${j}`, contextWindow: 100_000, maxTokens: 8_000, reasoning: false, input: ["text"] })),
	},
};
writeFileSync(MODELS_PATH, JSON.stringify({ providers }, null, 2));

const origFetch = (globalThis as any).fetch;
(globalThis as any).fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });

const { TestPanel, TEST_RESULT_VIEW_ROWS, openTestPanel } = await import("./ui.ts");

const ok = (label: string, cond: boolean) => {
	console.log((cond ? "✓ " : "✗ ") + label);
	if (!cond) process.exitCode = 1;
};
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const th = {
	fg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	bg: () => "",
};

const mockCtx: any = {
	mode: "tui",
	modelRegistry: {
		getProviderAuthStatus: () => ({ ok: true, source: "test" }),
		find: () => ({ id: "m0" }),
		complete: async () => ({
			stopReason: "stop",
			content: [{ type: "text", text: "ok" }],
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.000001 } },
		}),
	},
	ui: { notify: () => undefined },
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFinished(panel: any, ms = 8000): Promise<boolean> {
	for (let i = 0; i < ms / 20 && !panel.finished; i++) await sleep(20);
	return panel.finished === true;
}

async function main() {
	console.log("=== 单 model（t）：完整 formatTestResult 展示 ===");
	{
		let closed = false;
		const panel = new TestPanel({
			ctx: mockCtx, provider: "kdapi", modelIds: ["m0"],
			tui: { requestRender: () => {} }, theme: th, done: () => { closed = true; },
		});
		const l0 = panel.render(80);
		ok("初始含 testing 0/1", /testing 0\/1/.test(strip(l0.join("\n"))));
		ok("初始也有外边框（┌ 开头）", strip(l0[0]!).startsWith("┌"));
		ok("等待测试完成", await waitFinished(panel));
		const l1 = panel.render(80);
		const j1 = strip(l1.join("\n"));
		ok("完成后 1 tested, 1 ok", /1 tested, 1 ok/.test(j1));
		ok("完整 detail 含 auth 行", /auth\s+✓/.test(j1));
		ok("完整 detail 含 reachable 行", /reachable\s+✓/.test(j1));
		ok("完整 detail 含 generated 行", /generated\s+✓/.test(j1));
		ok("顶框含 Test kdapi/m0", strip(l1[0]!).includes("Test kdapi/m0"));
		ok("底框有 └", strip(l1.at(-1)!).startsWith("└"));
		ok("汇总行 kdapi: 1/1 ok", /kdapi: 1\/1 ok/.test(j1));
		ok("footer 含 q/Esc close", /q\/Esc close/.test(j1));
		panel.handleInput("q");
		ok("q 关闭", closed === true);
	}

	console.log("\n=== 批量（T）：紧凑 1 行/model + 滚动 ===");
	{
		let closed = false;
		const panel = new TestPanel({
			ctx: mockCtx, provider: "kdapi", modelIds: Array.from({ length: 20 }, (_, j) => `m${j}`),
			tui: { requestRender: () => {} }, theme: th, done: () => { closed = true; },
		});
		ok("TEST_RESULT_VIEW_ROWS = 12", TEST_RESULT_VIEW_ROWS === 12);
		ok("等待批量完成", await waitFinished(panel));
		const l1 = panel.render(80);
		const j1 = strip(l1.join("\n"));
		ok("完成后 20 tested, 20 ok", /20 tested, 20 ok/.test(j1));
		ok("紧凑模式不展开 auth/reachable 明细行", !/reachable\s+✓/.test(j1));
		// 自动滚到底：top 应为 8（20 行 - 12 可视），到底后无 more below
		ok("自动滚到底 top=8", (panel as any).top === 8);
		ok("滚到底时无 ⋮ more below", !/more below/.test(j1));
		// k 向上滚动：出现 more below
		panel.handleInput("k");
		ok("k 向上滚动 top=7", (panel as any).top === 7);
		const l2 = panel.render(80);
		ok("上滚后显示 ⋮ 1 more below", /⋮ 1 more below/.test(strip(l2.join("\n"))));
		// j 向下滚回底部
		panel.handleInput("j");
		ok("j 向下滚回 top=8", (panel as any).top === 8);
		// 手动回到顶部：more 计数 = 20 - 12 = 8
		(panel as any).top = 0;
		panel.invalidate();
		ok("顶部时显示 ⋮ 8 more below", /⋮ 8 more below/.test(strip(panel.render(80).join("\n"))));
		panel.handleInput("q");
		ok("q 关闭", closed === true);
	}

	console.log("\n=== 失败结果带错误详情行 ===");
	{
		// reachable 失败：fetch 返回 500
		(globalThis as any).fetch = async () => new Response("err", { status: 500 });
		const panel = new TestPanel({
			ctx: mockCtx, provider: "kdapi", modelIds: ["m1"],
			tui: { requestRender: () => {} }, theme: th, done: () => {},
		});
		ok("等待失败测试完成", await waitFinished(panel));
		const j = strip(panel.render(80).join("\n"));
		ok("显示 ✗ fail", /✗\s+1 tested, 0 ok/.test(j));
		ok("含 reachable 500 错误", /HTTP 500/.test(j));
		(globalThis as any).fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
	}

	console.log("\n=== openTestPanel overlay 参数 ===");
	{
		const calls: any[] = [];
		const ctx2: any = {
			...mockCtx,
			ui: {
				notify: () => undefined,
				custom: async <T>(factory: any, opts?: any): Promise<T | undefined> => {
					calls.push(opts);
					const fakeTui = { requestRender: () => {} };
					let doneResult: any;
					const comp = factory(fakeTui, th, {}, (r: any) => { doneResult = r; });
					comp.handleInput("q");
					return doneResult as T;
				},
			},
		};
		await openTestPanel(ctx2, { provider: "kdapi", modelIds: ["m0"], mode: "full" });
		ok("custom 带 overlay=true", calls[0]?.overlay === true);
		ok("anchor=center", calls[0]?.overlayOptions?.anchor === "center");
	}

	console.log("\n=== openTestPanel 非 TUI fallback（notify）===");
	{
		const notes: string[] = [];
		const ctx3: any = {
			...mockCtx,
			mode: "print",
			ui: { notify: (msg: string) => notes.push(msg) },
		};
		await openTestPanel(ctx3, { provider: "kdapi", modelIds: ["m0"], mode: "full" });
		ok("fallback 走 notify", notes.length >= 1);
		ok("notify 含 kdapi/m0", notes.join("\n").includes("kdapi/m0"));
	}

	(globalThis as any).fetch = origFetch;
	rmSync(TMP, { recursive: true, force: true });
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });
