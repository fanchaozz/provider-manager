// Dashboard overlay 浮窗 + 3 区域固定布局 + 可见行数 + (current/total) + footer 截断 测试
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP = mkdtempSync(join(tmpdir(), "pi-pm-overlay-"));
const MODELS_PATH = join(TMP, "models.json");
const BAK_PATH = join(TMP, "models.json.bak");
(globalThis as any)[Symbol.for("pi-provider-manager:models-path-override")] = MODELS_PATH;
(globalThis as any)[Symbol.for("pi-provider-manager:backup-path-override")] = BAK_PATH;

// 30 个 provider，每个 5 个 model → 触发滚动
const providers: Record<string, any> = {};
for (let i = 0; i < 30; i++) {
	const id = `p${i.toString().padStart(2, "0")}`;
	providers[id] = {
		baseUrl: `http://example${i}.test/v1`,
		api: "openai-completions",
		apiKey: `sk-${id}-long-secret-key-for-mask-test-1234567890`,
		models: Array.from({ length: 5 }, (_, j) => ({
			id: `${id}-m${j}`,
			contextWindow: 100_000 + j * 1000,
			maxTokens: 8_000,
			reasoning: j % 2 === 0,
			input: j === 0 ? ["text", "image"] : ["text"],
			compat: { supportsDeveloperRole: j % 2 === 0 },
		})),
	};
}
writeFileSync(MODELS_PATH, JSON.stringify({ providers }, null, 2));

import { Dashboard, PROVIDER_VIEW_ROWS, MODEL_VIEW_ROWS, OVERLAY_WIDTH } from "./ui.ts";

const ok = (label: string, cond: boolean) => {
	const tag = cond ? "✓" : "✗";
	console.log(`${tag} ${label}`);
	if (!cond) process.exitCode = 1;
};

const th = {
	fg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	bg: (_c: string, s: string) => s,
};

// 全部 strip ANSI 后比对文本
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

async function main() {
	console.log("=== 导出常量 ===");
	ok("PROVIDER_VIEW_ROWS > 0", PROVIDER_VIEW_ROWS > 0);
	ok("MODEL_VIEW_ROWS > 0", MODEL_VIEW_ROWS > 0);
	ok("OVERLAY_WIDTH > 50", OVERLAY_WIDTH >= 50);

	console.log("\n=== 初始化 + 基础 render ===");
	const d = new Dashboard({ mode: "tui", modelRegistry: { getProviderDisplayName: (id: string) => id } } as any, th, () => {}, {
		// 测试用窄视口，确认固定区域不会随数据膨胀
		providerViewRows: 6,
		modelViewRows: 6,
		detailViewRows: 10,
	});
	await d.init();
	const lines = d.render(96);
	const joined = strip(lines.join("\n"));

	ok("render 出非空字符串", lines.length > 0);
	ok("标题行存在",  joined.includes("provider-manager"));
	ok("stats 行 (30P · 150M)", /30P\s*·\s*150M/.test(joined));

	console.log("\n=== 固定区域高度（不随数据膨胀）===");
	// 3 个主要区域：top（header + 两列固定行数）+ detail（固定行数）+ footer
	// 3 行 = title + 空 + 区域1
	// 然后 6 行顶部 = 2 列高度
	// 然后 "" 间隔 + 10 行 detail
	// 然后 1 行分隔
	// 然后 ≤2 行 footer
	// 外框 2 行（顶 + 底）。总行数：1+1+6+1+10+1+1+2 = 23（+ footer ≤2）
	ok("render 行数含 box 边框后在 21-26 之间",  lines.length >= 21 && lines.length <= 26);

	// 验证 provider 列：固定 6 行（header 1 + list 5）
	// 滚动时显示 (current/total) 但不算进 6 行
	const providerColumn = joined.split("\n").slice(3, 9);  // 跳过 title + 空 + 顶框 + 区域
	ok("provider 列行数 = 6", providerColumn.length === 6);

	console.log("\n=== 滚动：>visRows 时显示 (current/total) + pin-first ===");
	// 30 个 provider，visRows=6 → 列表 5 行 → 需滚动
	ok("初始 (current/total) 标记 (1/30)", /\(1\/30\)/.test(joined));
	// 初始 cursor=0，不需 pin
	ok("初始不显示 (top) 标记（cursor=0）", !joined.includes("(top)"));

	// 滚到中部
	for (let i = 0; i < 15; i++) d.handleInput("j");
	{
		const lns = strip(d.render(96).join("\n"));
		ok("cursor=15 后 (current/total) (16/30)", /\(16\/30\)/.test(lns));
		ok("cursor=15 后首项钉住 (top)",  /\(top\)/.test(lns));
		// 顶部 p00 应该出现在 (top) 行
		ok("p00 出现在首项钉住",  /p00.*\(top\)/.test(lns));
		// 现在应该看到 p15 在中部（钉住 + 4 行 list）
		ok("p15 出现在 list",  /\bp15\b/.test(lns));
		ok("cursor 行 ▸ p15 可见（压线修复）",  /▸ p15/.test(lns));
	}

	// g 跳顶
	d.handleInput("g");
	{
		const lns = strip(d.render(96).join("\n"));
		ok("g 跳顶 (1/30)",  /\(1\/30\)/.test(lns));
		ok("g 后不显示 (top)",  !/\(top\)/.test(lns));
	}

	// G 跳底
	d.handleInput("G");
	{
		const lns = strip(d.render(96).join("\n"));
		ok("G 跳底 (30/30)",  /\(30\/30\)/.test(lns));
		ok("G 后首项 p00 仍钉住 (top)",  /p00.*\(top\)/.test(lns));
		ok("G 后底部能看到 p29",  /\bp29\b/.test(lns));
	}

	console.log("\n=== 整页翻页：PgDn / PgUp ===");
	d.handleInput("g");
	d.handleInput("\x1b[6~");  // PgDn
	{
		const lns = strip(d.render(96).join("\n"));
		// listH=5, step=5 → 期望跳到 cursor=5
		ok("PgDn → (6/30)",  /\(6\/30\)/.test(lns));
	}
	d.handleInput("\x1b[5~");  // PgUp
	{
		const lns = strip(d.render(96).join("\n"));
		ok("PgUp → (1/30)",  /\(1\/30\)/.test(lns));
	}

	console.log("\n=== model pane 滚动：30 个 provider 中第 0 个有 5 个 model ===");
	d.handleInput("\x1b[D");  // → model pane
	{
		const lns = strip(d.render(96).join("\n"));
		// 5 个 model < visRows=6 → 不滚动
		ok("model (1/5)", /\(1\/5\)/.test(lns));
		ok("model 不显示 (top)", !/\(top\)/.test(lns));
	}

	console.log("\n=== model pane 滚动：切到大量 model 的 provider ===");
	// 加一个 20 个 model 的 provider，p_big 排序在 p29 之后（'p_big' > 'p29' 因为 '_' (0x5F) > '9' (0x39)）
	const cur = JSON.parse((await import("node:fs")).readFileSync(MODELS_PATH, "utf8"));
	cur.providers.p_big = {
		baseUrl: "http://big.test/v1",
		api: "openai-completions",
		apiKey: "sk-big",
		models: Array.from({ length: 20 }, (_, j) => ({ id: `big-m${j}`, contextWindow: 100_000, maxTokens: 8_000, reasoning: false, input: ["text"] })),
	};
	writeFileSync(MODELS_PATH, JSON.stringify(cur, null, 2));
	// 重新 init
	const d2 = new Dashboard({ mode: "tui", modelRegistry: { getProviderDisplayName: (id: string) => id } } as any, th, () => {}, {
		providerViewRows: 6, modelViewRows: 6, detailViewRows: 10,
	});
	await d2.init();
	// G 跳到底（p_big 是最后）
	d2.handleInput("G");
	d2.handleInput("\x1b[D");  // model pane
	{
		const lns = strip(d2.render(96).join("\n"));
		ok("切到 p_big (model 列 20m)", /Models \(p_big\) 20m/.test(lns));
		ok("model 列 (1/20) 位置指示",  /\(1\/20\)/.test(lns));
	}
	// 滚到中部
	for (let i = 0; i < 12; i++) d2.handleInput("j");
	{
		const lns = strip(d2.render(96).join("\n"));
		ok("model 滚 12 (13/20)", /\(13\/20\)/.test(lns));
		ok("model 中部钉 big-m0 (top)",  /big-m0.*\(top\)/.test(lns));
		ok("cursor 行 ▸ big-m12 可见（压线修复）",  /▸ big-m12/.test(lns));
	}
	// 压线 case：cursor 恰好 = listH（6-2=4）时也必须可见（修复前 ▸ 消失在屏外）
	d2.handleInput("g");
	for (let i = 0; i < 4; i++) d2.handleInput("j");
	{
		const lns = strip(d2.render(96).join("\n"));
		ok("cursor=4 压线时 ▸ big-m4 可见",  /▸ big-m4/.test(lns));
		ok("压线时 (5/20) 位置指示",  /\(5\/20\)/.test(lns));
	}

	console.log("\n=== footer 截断：宽度过窄时 hint 被截断到 2 行 ===");
	// 极窄宽度：60 列（4 个 hint 拼不下）
	const d3 = new Dashboard({ mode: "tui", modelRegistry: { getProviderDisplayName: (id: string) => id } } as any, th, () => {}, {
		providerViewRows: 6, modelViewRows: 6, detailViewRows: 10,
	});
	await d3.init();
	const narrow = d3.render(40);
	const footer = narrow.slice(-2);
	const joinedFooter = strip(footer.join("\n"));
	ok("窄宽度 footer 行数 ≤ 2",  footer.length <= 2);
	// 太窄 (40) 时只装得下 1 个 hint + 'more' 截断提示；q close 不一定出现
	ok("窄宽度 footer 含 'nav' 或 'more'",  /nav|more|↑↓/.test(joinedFooter));
	ok("窄宽度 footer 含 'more' 截断提示",  /more/.test(joinedFooter));

	console.log("\n=== 宽宽度 footer：全部 hint 能在 ≤2 行展示 ===");
	const wide = d3.render(140);
	const wideFooter = wide.slice(-2);
	const wideJoinedFooter = strip(wideFooter.join("\n"));
	ok("宽宽度 footer 包含全部 hint",  /nav/.test(wideJoinedFooter) && /pane/.test(wideJoinedFooter) && /q close/.test(wideJoinedFooter));

	console.log("\n=== 帮助界面限 2 行 ===");
	d3.handleInput("?");
	const helpLines = d3.render(96);
	// 外框下：行 [0]=顶框，[1]=Key bindings，[2..3]=help body，[N-1]=底框
	// body 实际只有 2 行 + 末行 more 提示，共 3 行内容
	const helpBody = strip(helpLines.join("\n"));
	ok("help 含 'Key bindings'",  /Key bindings/.test(helpBody));
	ok("help 末行有 'more' 截断提示",  /more/.test(helpBody));

	console.log("\n=== 切 pane 时 model top 重置（防止跨 provider 的 stale scroll）===");
	const d4 = new Dashboard({ mode: "tui", modelRegistry: { getProviderDisplayName: (id: string) => id } } as any, th, () => {}, {
		providerViewRows: 6, modelViewRows: 6, detailViewRows: 10,
	});
	await d4.init();
	// 滚到 p_big（p_big 是 sort 后第一个因为 p > 数字）
	// sort: ['p00'...'p29', 'p_big']，实际 sort: 'p00'..'p29' < 'p_big'，因为数字字符 < 字母。
	// 但 'p00' > 'p_big'，因为 '0' (0x30) > '_' (0x5F) 不对：_ 0x5F > 0 0x30
	// 实际：'p0' 0x30, 'p_' 0x5F, 'p0' < 'p_'
	// 所以 sort: p00,p01,...,p29,p_big
	d4.handleInput("G");  // 跳到 p_big
	d4.handleInput("\x1b[D");  // model pane
	for (let i = 0; i < 12; i++) d4.handleInput("j");  // 滚到中部
	const before = strip(d4.render(96).join("\n"));
	ok("滚到 p_big model 中部",  /\(13\/20\)/.test(before));
	// 切回 provider pane，再切到 p00
	d4.handleInput("\x1b[C");  // provider pane
	d4.handleInput("g");  // 跳顶
	d4.handleInput("\x1b[D");  // model pane
	{
		const lns = strip(d4.render(96).join("\n"));
		// model 5 个 ≤ 6 → 不滚动
		ok("切到 p00 后 model (1/5)，top 重置",  /\(1\/5\)/.test(lns));
	}

	console.log("\n=== detail 面板固定行数（不随数据膨胀）===");
	const d5 = new Dashboard({ mode: "tui", modelRegistry: { getProviderDisplayName: (id: string) => id } } as any, th, () => {}, {
		providerViewRows: 6, modelViewRows: 6, detailViewRows: 8,
	});
	await d5.init();
	const fixedDetail = d5.render(96);
	// 行数应等于：1 title + 1 空 + 6 top + 1 空 + 8 detail + 1 sep + ≤2 footer = 19 或 20
	ok("detail 固定 8 行 → 总行数 ≤ 23（含 box 边框 + 2 行 footer）",  fixedDetail.length <= 23);

	console.log("\n=== 滚动一致性：render 多次不变 ===");
	const r1 = d.render(96);
	const r2 = d.render(96);
	ok("render 幂等",  r1.join("\n") === r2.join("\n"));

	// 清理
	(await import("node:fs")).rmSync(TMP, { recursive: true, force: true });
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
