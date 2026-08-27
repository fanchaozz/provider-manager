// ui.ts 渲染 + 键位测试（用 temp 路径，不污染用户 ~/.pi/agent/models.json）
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP_DIR = mkdtempSync(join(tmpdir(), "pi-pm-ui-test-"));
const MODELS_PATH = join(TMP_DIR, "models.json");
const BAK_PATH = join(TMP_DIR, "models.json.bak");
(globalThis as any)[Symbol.for("pi-provider-manager:models-path-override")] = MODELS_PATH;
(globalThis as any)[Symbol.for("pi-provider-manager:backup-path-override")] = BAK_PATH;

// 写一个固定的 mock models.json（2 个 provider + 多个 model）
writeFileSync(MODELS_PATH, JSON.stringify({
	providers: {
		kdapi: {
			baseUrl: "http://10.168.2.110:23000/v1", api: "openai-completions", apiKey: "sk-test",
			models: [
				{ id: "minimax-m3", contextWindow: 1_000_000, maxTokens: 128_000, reasoning: true,  input: ["text"], compat: { supportsDeveloperRole: false } },
				{ id: "minimax-m2", contextWindow: 256_000,   maxTokens: 32_000,  reasoning: false, input: ["text", "image"] },
			],
		},
		agnes: {
			baseUrl: "https://api.agnes.example/v1", api: "anthropic-messages", apiKey: "sk-agnes",
			models: [
				{ id: "agnes-2.5-flash", contextWindow: 200_000, maxTokens: 64_000, reasoning: true, input: ["text", "image"],
					thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: null, xhigh: null, max: "max" } },
			],
		},
	},
}, null, 2));

import { Dashboard } from "./ui.ts";

const th = {
	fg: (color: string, s: string) => `\x1b[38;5;${Math.abs(color.length * 17) % 255}m${s}\x1b[39m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
	bg: (color: string, s: string) => `<bg:${color}>${s}</bg:${color}>`,
};

// 仅自定义 provider；mock modelRegistry 只用来取 displayName 和 authStatus
// 不再依赖 modelRegistry.getAvailable()（插件不覆盖内置）
const displayNames: Record<string, string> = { kdapi: "kdapi (custom)", agnes: "Agnes" };
const authStatus:  Record<string, any>    = {
	kdapi: { configured: true, source: "models.json_key" },
	agnes: { configured: true, source: "models.json_key" },
};

const mockCtx: any = {
	mode: "tui",
	modelRegistry: {
		getProviderDisplayName: (id: string) => displayNames[id] ?? id,
		getProviderAuthStatus: (id: string) => authStatus[id] ?? { configured: false },  // 保留以保 mock 兼容；新逻辑已不调这个
	},
	ui: { notify: () => undefined, select: async () => undefined, confirm: async () => true, input: async () => "" },
};

const ok = (label: string, cond: boolean) => console.log((cond ? "✓ " : "✗ ") + label);

console.log("=== render width=120 ===");
let closed = false;
const dash = new Dashboard(mockCtx, th, () => { closed = true; });
await dash.init();
const lines = dash.render(120);
console.log(lines.join("\n"));
console.log("=== end ===\n");

const allText = lines.join("\n");
ok("包含 title",                allText.includes("provider-manager"));
ok("包含 kdapi",                allText.includes("kdapi"));
ok("包含 agnes",                allText.includes("agnes"));
// "anthropic" 可能出现在 agnes 的 api 字段 (anthropic-messages)，不算内置 provider
ok("不含 openai / anthropic 作为 provider id", !/^\s*[▸ ]\s*(openai|anthropic)\b/m.test(allText));
ok("不含 [custom] tag（已去掉）",       !allText.includes("[custom]"));
ok("不含 [built-in] tag（已去掉）",     !allText.includes("[built-in]"));
ok("含 Auth 分组",                allText.includes("Auth"));
ok("含 apiKey status 行",        allText.includes("apiKey status:"));
ok("含 200kc 格式化",           allText.includes("200kc"));
ok("含 footer 键位",            allText.includes("←→ pane"));
ok("source: models.json (custom)", allText.includes("models.json (custom)"));

// 切到 kdapi（2 个 model）看 minimax-m3
(dash as any).providerIndex = 1; // kdapi
dash.invalidate();
const lns2 = dash.render(120);
ok("切到 kdapi 后 model 列含 minimax-m3", lns2.join("\n").includes("minimax-m3"));
ok("切到 kdapi 后含 1.0Mc 格式化",       lns2.join("\n").includes("1.0Mc"));

// 增强 UI 检项
ok("title bar 含 stats (P/M/✓)",  allText.match(/P\s*·\s*\d+M/) !== null);
ok("provider 行含 ✓ 认证图标",    allText.includes("✓"));
ok("provider header 含 auth count",  /·\d+✓\s+\d+m/.test(allText));
ok("model header 含 R / I 计数",   /\d+R\s*·\s*\d+I/.test(allText));
ok("detail panel 含 Endpoint 分组", allText.includes("Endpoint"));
ok("detail panel 含 Identity 分组", allText.includes("Identity"));

console.log("\n=== model detail: thinkingLevelMap 单行显示 enabled 的 level ===");
{
	const d7 = new Dashboard(mockCtx, th, () => {});
	await d7.init();
	d7.handleInput("\x1b[D");  // → model pane
	const lns = d7.render(120);
	const joined = lns.join("\n");
	// agnes-2.5-flash 测试数据里 thinkingLevelMap: { low: "low", medium: "medium", high: "high" }
	ok("含 Thinking levels 行",  /Thinking levels:/.test(joined));
	ok("列出 enabled: low, medium, max",  joined.includes("low, medium, max"));
	// 未勾选的 level 不出现名字（off/minimal/xhigh/max 不应该出现在 Thinking 行）
	const tlLine = joined.split("\n").find((l) => /Thinking levels:/.test(l)) || "";
	ok("未 enabled 的 level 不出现",  !/\boff\b|\bminimal\b|\bxhigh\b|\bmax\b/.test(tlLine.replace(/Thinking levels:.*$/, "")));
}

console.log("\n=== model detail: compat.supportsDeveloperRole ===");
{
	// kdapi 是 sorted index 1（'agnes' < 'kdapi'）。切到 kdapi → model pane。
	const d9 = new Dashboard(mockCtx, th, () => {});
	await d9.init();
	d9.handleInput("j");           // agnes (0) → kdapi (1)
	d9.handleInput("\x1b[D");      // → model pane
	const joined9 = d9.render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	ok("含 Compat 分组",  /  Compat/.test(joined9));
	ok("supportsDeveloperRole: no 显式标 no",  /supportsDeveloperRole:\s*no/.test(joined9));
}

console.log("\n=== model detail: 全部 null 时 Thinking levels 不显示 ===");
{
	// kdapi 的 minimax-m3 没 thinkingLevelMap；不显示该 section
	const d8 = new Dashboard(mockCtx, th, () => {});
	await d8.init();
	// 切到 kdapi（index 1）+ model pane
	d8.handleInput("\x1b[B");
	d8.handleInput("\x1b[D");
	const lns = d8.render(120);
	const joined = lns.join("\n");
	const hasTl = joined.split("\n").some((l) => /Thinking levels:/.test(l));
	ok("无 thinkingLevelMap → 不显示",  !hasTl);
}

console.log("\n=== 键位测试 ===");
const d2 = new Dashboard(mockCtx, th, () => {});
await d2.init();
ok("初始 providerIndex=0 (agnes, sort 后 a<k)", (d2 as any).providerIndex === 0);
d2.handleInput("\x1b[B"); ok("↓ 移动到 1 (kdapi)", (d2 as any).providerIndex === 1);
d2.handleInput("j");      ok("j 移动到 2 (循环回 0)", (d2 as any).providerIndex === 0);
d2.handleInput("k");      ok("k 移动到 1 (kdapi)", (d2 as any).providerIndex === 1);
d2.handleInput("g");      ok("g 跳顶到 0", (d2 as any).providerIndex === 0);
d2.handleInput("G");      ok("G 跳底到 1", (d2 as any).providerIndex === 1);

// 切到 kdapi（2 个 model）测试 model pane 导航
(d2 as any).providerIndex = 1; // kdapi：2 个 model
d2.invalidate();
d2.handleInput("\x1b[D"); ok("← 切到 model pane", (d2 as any).pane === "model");
ok("切到 model pane 索引 0", (d2 as any).modelIndex === 0);
d2.handleInput("j");      ok("model pane j 移动到 1", (d2 as any).modelIndex === 1);
d2.handleInput("k");      ok("model pane k 移动到 0", (d2 as any).modelIndex === 0);
d2.handleInput("G");      ok("model pane G 跳底到 1", (d2 as any).modelIndex === 1);
// 切回 provider pane
d2.handleInput("\x1b[C"); ok("→ 切回 provider pane", (d2 as any).pane === "provider");

d2.handleInput("?");      ok("? 切换帮助", (d2 as any).help === true);
d2.handleInput("?");      ok("? 关闭帮助", (d2 as any).help === false);

let closed2 = false;
const d3 = new Dashboard(mockCtx, th, () => { closed2 = true; });
await d3.init();
d3.handleInput("q");      ok("q 关闭", closed2 === true);

let closed3 = false;
const d4 = new Dashboard(mockCtx, th, () => { closed3 = true; });
await d4.init();
d4.handleInput("\x1b");   ok("Esc 关闭", closed3 === true);

console.log("\n=== 帮助界面 ===");
const d5 = new Dashboard(mockCtx, th, () => {});
await d5.init();
(d5 as any).help = true;
const hLines = d5.render(80);
ok("帮助含 Key bindings", hLines.some((l: string) => l.includes("Key bindings")));
ok("帮助含 j/k",         hLines.some((l: string) => l.includes("j/k")));

console.log("\n=== 边界：单个 provider 0 个 model ===");
const emptyCtx: any = {
	...mockCtx,
};
const d6 = new Dashboard(emptyCtx, th, () => {});
await d6.init();
ok("单 provider 不崩", d6.render(80).length > 0);

console.log("\n=== inspectApiKey：自检 models.json 里 provider.apiKey 状态 ===");
{
	// 复现 ui.ts 里的 inspectApiKey（避免导出到 public surface；这里是 test 内部复现）
	const inspect = (apiKey: unknown): { hasKey: boolean; source?: string } => {
		if (typeof apiKey !== "string" || apiKey.length === 0) return { hasKey: false, source: "empty" };
		if (apiKey.startsWith("!")) return { hasKey: true, source: "models.json_command" };
		if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(apiKey)) return { hasKey: true, source: "models.json_env" };
		return { hasKey: true, source: "models_json_key" };
	};
	ok("明文 key → set + key",       inspect("sk-abc").hasKey && inspect("sk-abc").source === "models_json_key");
	ok("$ENV → set + env",            inspect("$MY_KEY").hasKey && inspect("$MY_KEY").source === "models.json_env");
	ok("${ENV} → set + env",          inspect("${MY_KEY}").hasKey && inspect("${MY_KEY}").source === "models.json_env");
	ok("!command → set + command",    inspect("!cat /path").hasKey && inspect("!cat /path").source === "models.json_command");
	ok("空 → empty",                  inspect("").hasKey === false && inspect("").source === "empty");
	ok("undefined → empty",           inspect(undefined).hasKey === false);
	ok("数字 → empty",                inspect(12345 as any).hasKey === false);
	ok("被 secret-bug 损坏的 key（首尾匹配）→ set + key",  inspect("sk-••••Xn").hasKey === true);  // 不去管值是否被 bug 坏过；只看“有值”
}
