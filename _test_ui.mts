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
				{ id: "minimax-m3", contextWindow: 1_000_000, maxTokens: 128_000, reasoning: true,  input: ["text"] },
				{ id: "minimax-m2", contextWindow: 256_000,   maxTokens: 32_000,  reasoning: false, input: ["text", "image"] },
			],
		},
		agnes: {
			baseUrl: "https://api.agnes.example/v1", api: "anthropic-messages", apiKey: "sk-agnes",
			models: [
				{ id: "agnes-2.5-flash", contextWindow: 200_000, maxTokens: 64_000, reasoning: true, input: ["text", "image"] },
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
	kdapi: { ok: true, source: "models.json.apiKey" },
	agnes: { ok: true, source: "models.json.apiKey" },
};

const mockCtx: any = {
	mode: "tui",
	modelRegistry: {
		getProviderDisplayName: (id: string) => displayNames[id] ?? id,
		getProviderAuthStatus: (id: string) => authStatus[id] ?? { ok: false },
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
ok("含 auth 行",                allText.includes("auth:"));
ok("含 200kc 格式化",           allText.includes("200kc"));
ok("含 footer 键位",            allText.includes("Tab pane"));
ok("source: models.json (custom)", allText.includes("models.json (custom)"));

// 切到 kdapi（2 个 model）看 minimax-m3
(dash as any).providerIndex = 1; // kdapi
dash.invalidate();
const lns2 = dash.render(120);
ok("切到 kdapi 后 model 列含 minimax-m3", lns2.join("\n").includes("minimax-m3"));
ok("切到 kdapi 后含 1.0Mc 格式化",       lns2.join("\n").includes("1.0Mc"));

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
d2.handleInput("\t");     ok("Tab 切到 model pane", (d2 as any).pane === "model");
ok("切到 model pane 索引 0", (d2 as any).modelIndex === 0);
d2.handleInput("j");      ok("model pane j 移动到 1", (d2 as any).modelIndex === 1);
d2.handleInput("k");      ok("model pane k 移动到 0", (d2 as any).modelIndex === 0);
d2.handleInput("G");      ok("model pane G 跳底到 1", (d2 as any).modelIndex === 1);

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
