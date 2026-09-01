// 空 providers 状态下：n 必须能触发 addProviderFlow（修复前 n 被导航的 if/else 链吞掉）
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP_DIR = mkdtempSync(join(tmpdir(), "pi-pm-empty-"));
const MODELS_PATH = join(TMP_DIR, "models.json");
const BAK_PATH = join(TMP_DIR, "models.json.bak");
(globalThis as any)[Symbol.for("pi-provider-manager:models-path-override")] = MODELS_PATH;
(globalThis as any)[Symbol.for("pi-provider-manager:backup-path-override")] = BAK_PATH;

// 故意写空 providers
writeFileSync(MODELS_PATH, JSON.stringify({ providers: {} }, null, 2));

import { Dashboard } from "./ui.ts";
import { readModelsJson } from "./store.ts";

const ok = (label: string, cond: boolean) => console.log((cond ? "✓ " : "✗ ") + label);

const th = {
	fg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	bg: (_c: string, s: string) => s,
};

const ok2 = (label: string, cond: boolean) => console.log((cond ? "✓ " : "✗ ") + label);

// 模拟 addProviderFlow 内部 form editor 的 custom() 调用。
// addProviderFlow 走 runFormEditor -> ctx.ui.custom(() => form editor TUI)，
// 不会直接调 ctx.ui.input（input 是 model 用的单字段对话框）。
let customCalls = 0;
let inputCalls = 0;
const mockCtx: any = {
	mode: "tui",
	modelRegistry: {
		getProviderDisplayName: (id: string) => id,
	},
	ui: {
		notify: (msg: string) => { /* 调试时打开：console.log("[notify]", msg); */ },
		input: async (_title: string, _placeholder?: string) => {
			inputCalls++;
			return "";
		},
		select: async () => "",
		confirm: async () => true,
		custom: async <T>(_factory: any): Promise<T | undefined> => {
			customCalls++;
			return undefined;
		},
	},
};

console.log("=== 空 providers 状态下按 n ===");
let closed = false;
const dash = new Dashboard(mockCtx, th, () => { closed = true; });
await dash.init();

// 校验渲染：空态框 + 简化 footer
const lines = dash.render(100);
const text = lines.join("\n");
ok2("显示 (no providers found) 空态",         text.includes("(no providers found)"));
ok2("空态 footer 提示 'n add first provider'", text.includes("n add first provider"));
ok2("空态 footer 不再误导显示 'nav'/'Enter'", !text.includes("↑↓/jk nav") && !text.includes("Enter edit"));
ok2("providers 实际为空",                       (dash as any).providers.length === 0);

await dash.handleInput("n");

// 兜点延迟，让 runForm 的 microtask 跑完
await new Promise((r) => setTimeout(r, 50));

ok2("按 n 触发了 form custom()（addProviderFlow 启动）", customCalls > 0);
ok2("onClose 被调用（dashboard 关闭让位 form）",          closed === true);

console.log("\n=== 空态下其他键不崩 ===");
const dash2 = new Dashboard(mockCtx, th, () => {});
await dash2.init();
dash2.handleInput("j"); ok2("j 在空态不崩", true);
dash2.handleInput("k"); ok2("k 在空态不崩", true);
dash2.handleInput("d"); ok2("d 在空态不崩", true);
dash2.handleInput("y"); ok2("y 在空态不崩", true);
dash2.handleInput("\x1b[D"); ok2("← 在空态不崩", true);
dash2.handleInput("?");   ok2("? 在空态切换 help", (dash2 as any).help === true);

console.log("\n=== n 在 pane=model 时调 addModelFlow（添加新 model）===");
const dash3 = new Dashboard(mockCtx, th, () => {});
await dash3.init();
// 预先写一个 provider + 1 个 model，让 n 走 addModelFlow
await writeFileSync(MODELS_PATH, JSON.stringify({ providers: { prov1: { baseUrl: "x", api: "openai-completions", models: [{ id: "m1" }] } } }));
await dash3.init();
(dash3 as any).pane = "model";
let notifySeen = "";
(dash3 as any).ctx.ui.notify = (msg: string) => { notifySeen = msg; };
let addModelFlowCalled = false;
const origRunForm = (dash3 as any).runForm.bind(dash3);
(dash3 as any).runForm = async (formFn: any, ...args: any[]) => {
	if (formFn.name === "addModelFlow") addModelFlowCalled = true;
	return origRunForm(formFn, ...args);
};
dash3.handleInput("n");
ok2("pane=model 按 n → 触发 addModelFlow（恢复后 sync 不到也可用）", addModelFlowCalled);
ok2("pane=model 按 n → 不再提示 sync（改为 addModelFlow）", !notifySeen.includes("sync") || notifySeen === "");
