// commands.ts 单元测试：mock ctx，调用 registerCommands，触发 /providers ls/help
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP_DIR = mkdtempSync(join(tmpdir(), "pi-pm-cmd-test-"));
const MODELS_PATH = join(TMP_DIR, "models.json");
const BAK_PATH = join(TMP_DIR, "models.json.bak");
(globalThis as any)[Symbol.for("pi-provider-manager:models-path-override")] = MODELS_PATH;
(globalThis as any)[Symbol.for("pi-provider-manager:backup-path-override")] = BAK_PATH;

// 写一个固定的 mock models.json
writeFileSync(MODELS_PATH, JSON.stringify({
	providers: {
		kdapi: { baseUrl: "http://10.168.2.110:23000/v1", api: "openai-completions", apiKey: "sk-test",
			models: [{ id: "minimax-m3", contextWindow: 1_000_000, maxTokens: 128_000, reasoning: true, input: ["text"] }] },
		agnes: { baseUrl: "https://api.agnes.example/v1", api: "anthropic-messages", apiKey: "sk-agnes",
			models: [{ id: "agnes-2.5-flash", contextWindow: 200_000, maxTokens: 64_000, reasoning: true, input: ["text", "image"] }] },
	},
}, null, 2));

import { registerCommands } from "./commands.ts";

const mockProviderNames: Record<string, string> = {
	kdapi: "kdapi (custom)",
	agnes: "Agnes",
};

const mockCtx = {
	mode: "print",
	modelRegistry: {
		getProviderDisplayName: (id: string) => mockProviderNames[id] ?? id,
		getProvider: (id: string) => (mockProviderNames[id] ? { id, name: mockProviderNames[id] } : undefined),
	},
	ui: {
		notify: (msg: string, level?: string) => console.log(`[notify:${level ?? "info"}] ${msg}`),
		select: async (title: string, items: string[]) => { console.log(`[select:${title}] ${items.length} items`); return undefined; },
		confirm: async () => true,
		input: async () => "",
	},
};

let captured: { name: string; description: string; handler: (args: string, ctx: any) => Promise<void> } | null = null;
const mockPi: any = {
	registerCommand: (name: string, opts: any) => {
		if (name === "providers") captured = { name, ...opts };
	},
};

registerCommands(mockPi);

if (!captured) {
	console.error("FAIL: /providers command not registered");
	process.exit(1);
}

const ok = (label: string, cond: boolean) => console.log((cond ? "✓ " : "✗ ") + label);

console.log("=== /providers ls ===");
await captured.handler("ls", mockCtx);
ok("description 提到 models.json", captured.description.toLowerCase().includes("models.json"));

console.log("\n=== /providers ls kdapi ===");
await captured.handler("ls kdapi", mockCtx);

console.log("\n=== /providers help ===");
await captured.handler("help", mockCtx);

console.log("\n=== /providers unknown ===");
await captured.handler("frobnicate", mockCtx);

console.log("\n=== /providers sync (needs TUI) ===");
await captured.handler("sync", mockCtx);

console.log("\n=== /providers (no args) ===");
await captured.handler("", mockCtx);

console.log("\n=== completions ===");
const completions = captured.getArgumentCompletions ? captured.getArgumentCompletions("") : null;
ok("completions 包含 ls",        Array.isArray(completions) && completions.some((c: any) => c.value === "ls"));
ok("completions 包含 sync",      Array.isArray(completions) && completions.some((c: any) => c.value === "sync"));
ok("completions 不含 refresh",   Array.isArray(completions) && !completions.some((c: any) => c.value === "refresh"));

console.log("\n=== ls drill-down：按 provider 行 → 弹只该 provider 的 models ===");
// 重写 ctx 为 TUI + mock select 返 provider 概要行
let selectCalls: Array<{ title: string; lines: string[] }> = [];
const tuiCtx: any = {
	mode: "tui",
	modelRegistry: {
		getProviderDisplayName: (id: string) => mockProviderNames[id] ?? id,
		getProvider: (id: string) => (mockProviderNames[id] ? { id, name: mockProviderNames[id] } : undefined),
	},
	ui: {
		notify: (msg: string, level?: string) => { /* swallow */ },
		select: async (title: string, opts: string[]) => {
			selectCalls.push({ title, lines: opts });
			// 返回 provider 概要行（"  kdapi  — 3 model(s)"）
			const providerLine = opts.find((l) => /^\s+kdapi\s+—\s+\d+\s+model\(s\)\s*$/.test(l));
			return providerLine;
		},
		confirm: async () => true,
		input: async () => "",
		custom: async () => undefined,
	},
};
selectCalls = [];
await captured.handler("ls", tuiCtx);
ok("调用了 select 2 次（主列表 + drill-down）", selectCalls.length === 2);
ok("第 2 次 select title 含 models of", selectCalls[1]?.title.includes("models of"));
ok("drill-down 内容只含 kdapi 的 models", selectCalls[1]?.lines.some((l) => l.includes("minimax-m3")) && !selectCalls[1]?.lines.some((l) => l.includes("agnes-2.5-flash")));

console.log("\n=== ls drill-down：按 model 行 → 只关闭，不动作 ===");
selectCalls = [];
tuiCtx.ui.select = async (title: string, opts: string[]) => {
	selectCalls.push({ title, lines: opts });
	// 返回 model bullet 行
	const modelLine = opts.find((l) => /^\s+•\s+\S+/.test(l));
	return modelLine;
};
await captured.handler("ls", tuiCtx);
ok("model 行只调用 select 1 次（不 drill-down）", selectCalls.length === 1);

console.log("\n=== ls drill-down：按 provider section header → drill-down ===");
selectCalls = [];
tuiCtx.ui.select = async (title: string, opts: string[]) => {
	selectCalls.push({ title, lines: opts });
	// 返回 provider section header： "  kdapi:"
	const sectionLine = opts.find((l) => /^\s+kdapi:\s*$/.test(l));
	return sectionLine;
};
await captured.handler("ls", tuiCtx);
ok("section header 触发 drill-down", selectCalls.length === 2 && selectCalls[1]?.title.includes("models of"));
