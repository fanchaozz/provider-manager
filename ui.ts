/**
 * ui.ts — TUI Dashboard
 *
 * 双面板（Providers | Models）+ 详情面板 + 底部键位提示。
 * 渲染层纯字符串，零外部 TUI 依赖。
 *
 * 1.2+ 阶段：CRUD + sync + 详情面板；内置 provider 不覆盖（走 pi 的 /model）。
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { readModelsJson, getModelsJsonPath, maskApiKey, type ModelsJson, type ProviderConfig, type ModelConfig } from "./store.ts";
import {
	addProviderFlow,
	editProviderFlow,
	deleteProviderFlow,
	addModelFlow,
	editModelFlow,
	deleteModelFlow,
	syncFlow,
} from "./forms.ts";
import { testModel, testProvider, formatTestResult, getCached, type TestResult } from "./test.ts";

// ============================================================================
// 类型
// ============================================================================

type ModelRow = {
	id: string;
	provider: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning: boolean;
	input: string[];
	hasApiKey: boolean;
};

type ProviderRow = {
	id: string;
	displayName: string;
	models: ModelRow[];
};

// ============================================================================
// 工具
// ============================================================================

/** 匹配 pi 风格的 key 字符串：escape / ctrl+c / up / down / enter / tab 等 */
function matchesKey(data: string, key: string): boolean {
	const k = key.toLowerCase();
	// ctrl+X
	if (k.startsWith("ctrl+")) {
		const ch = k.slice(5);
		return data === `\x1b${ch}` || (ch.length === 1 && data === ch && data.charCodeAt(0) < 32);
	}
	switch (k) {
		case "escape":
			return data === "\x1b" || data === "\x1b\x1b";
		case "enter":
		case "return":
			return data === "\r" || data === "\n";
		case "tab":
			return data === "\t";
		case "backspace":
			return data === "\x7f" || data === "\b";
		case "up":
			return data === "\x1b[A" || data === "\x1bOA";
		case "down":
			return data === "\x1b[B" || data === "\x1bOB";
		case "left":
			return data === "\x1b[D" || data === "\x1bOD";
		case "right":
			return data === "\x1b[C" || data === "\x1bOC";
		case "home":
			return data === "\x1b[H" || data === "\x1bOH";
		case "end":
			return data === "\x1b[F" || data === "\x1bOF";
		case "pageup":
			return data === "\x1b[5~";
		case "pagedown":
			return data === "\x1b[6~";
	}
	// 单字符
	if (k.length === 1) return data === k;
	return false;
}

/** 按视觉宽度截断（中文算 2） */
function truncateToWidth(s: string, max: number, ellipsis = "…"): string {
	if (max <= 0) return "";
	let w = 0;
	let out = "";
	for (const ch of s) {
		const cw = isWide(ch) ? 2 : 1;
		if (w + cw > max) return out + (ellipsis && w + 1 <= max ? ellipsis : "");
		out += ch;
		w += cw;
	}
	return out;
}

function isWide(ch: string): boolean {
	const code = ch.codePointAt(0) ?? 0;
	return code > 0x1100 && (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0x9fff) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6)
	);
}

function pad(s: string, width: number): string {
	let w = visualWidth(s);
	if (w >= width) return s;
	return s + " ".repeat(width - w);
}

/** 主题感知的 pad：把 [tag]...[/tag] 标记当作零宽，padding 补到目标可见宽度 */
function visiblePad(s: string, width: number): string {
	const w = visibleWidthStrippingTheme(s);
	if (w >= width) return s;
	return s + " ".repeat(width - w);
}

/** 跳过 ANSI 转义序列和已知主题标签后算视觉宽度
 * - ANSI: \x1b[...m（零宽颜色码）
 * - 旧格式: [tag]...[/tag]（只跳过白名单内的；其他 [..] 按字面文本计）
 */
function visibleWidthStrippingTheme(s: string): number {
	let w = 0;
	let i = 0;
	while (i < s.length) {
		// ANSI 转义序列：\x1b[ ... m 或 \x1b[ ... <字母>
		if (s[i] === "\x1b" && i + 1 < s.length && s[i + 1] === "[") {
			const close = s.indexOf("m", i + 2);
			if (close !== -1) { i = close + 1; continue; }
			// 其他 CSI 序列：结尾是某个字母
			const csiEnd = s.slice(i + 2).search(/[A-Za-z]/);
			if (csiEnd !== -1) { i = i + 2 + csiEnd + 1; continue; }
		}
		// 旧主题标签 [tag]
		if (s[i] === "[") {
			const close = s.indexOf("]", i + 1);
			if (close !== -1) {
				const inner = s.slice(i + 1, close);
				if (KNOWN_THEME_TAGS.has(inner) || (inner.startsWith("/") && KNOWN_THEME_TAGS.has(inner.slice(1)))) {
					i = close + 1;
					continue;
				}
			}
		}
		w += isWide(s[i]!) ? 2 : 1;
		i++;
	}
	return w;
}

/** 已知主题标签名集合。渲染器在 [name] 找不到主题色时会把整个 [name] 当字面文本输出 */
const KNOWN_THEME_TAGS = new Set<string>([
	"accent", "warning", "dim", "success", "error", "muted", "text",
	"borderMuted", "border", "borderAccent",
	"background", "primary", "secondary",
	"toolTitle", "toolOutput", "toolBg",
	"customMessageBg", "userMessageBg", "thinking",
	"bold", "italic", "underline", "inverse",
	"selection", "comment", "keyword", "string", "number", "function",
	"variable", "type", "operator", "punctuation", "property",
]);

function visualWidth(s: string): number {
	let w = 0;
	for (const ch of s) w += isWide(ch) ? 2 : 1;
	return w;
}

// ============================================================================
// 数据加载
// ============================================================================

function buildProviders(ctx: ExtensionCommandContext, json: ModelsJson): { providers: ProviderRow[]; auth: Map<string, { hasKey: boolean; source?: string }> } {
	// 只看 models.json 里的自定义 provider；内置 provider 走 pi 的 /model，不在插件覆盖范围
	const customIds = Object.keys(json.providers).sort();

	const auth = new Map<string, { hasKey: boolean; source?: string }>();
	const authStatus = (ctx.modelRegistry as any).getProviderAuthStatus;
	if (typeof authStatus === "function") {
		for (const pid of customIds) {
			try {
				const s = authStatus(pid);
				auth.set(pid, { hasKey: !!s?.ok, source: s?.source });
			} catch {
				auth.set(pid, { hasKey: false });
			}
		}
	}

	const providers: ProviderRow[] = customIds.map((pid) => {
		const customModels = (json.providers[pid]?.models ?? []) as ModelConfig[];
		return {
			id: pid,
			displayName: ctx.modelRegistry.getProviderDisplayName(pid) ?? pid,
			models: customModels.map((m): ModelRow => ({
				id: m.id,
				provider: pid,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				reasoning: !!m.reasoning,
				input: m.input ?? ["text"],
				hasApiKey: auth.get(pid)?.hasKey ?? false,
			})),
		};
	});
	return { providers, auth };
}

// ============================================================================
// Dashboard 组件
// ============================================================================

type Pane = "provider" | "model";

class Dashboard {
	// exposed for testing
	static __test = true;
	private providers: ProviderRow[] = [];
	private auth = new Map<string, { hasKey: boolean; source?: string }>();
	private providerIndex = 0;
	private modelIndex = 0;
	private pane: Pane = "provider";
	private help = false;
	private initError?: string;
	private cachedWidth = -1;
	private cachedLines: string[] = [];
	private onClose: () => void;
	private theme: any;
	private ctx: ExtensionCommandContext;
	private json: ModelsJson = { providers: {} };

	constructor(
		ctx: ExtensionCommandContext,
		theme: any,
		onClose: () => void,
	) {
		this.ctx = ctx;
		this.theme = theme;
		this.onClose = onClose;
	}

	/** 同步初始化：custom() 返回前必须先有数据，避免首帧 "(no providers found)" 闪烁 */
	init(): void {
		const path = getModelsJsonPath();
		let json: ModelsJson = { providers: {} };
		if (existsSync(path)) {
			try {
				const text = readFileSync(path, "utf8");
				const parsed = JSON.parse(text);
				if (parsed && typeof parsed === "object" && parsed.providers && typeof parsed.providers === "object") {
					json = parsed as ModelsJson;
				}
			} catch (err) {
				this.initError = `models.json 解析失败: ${err instanceof Error ? err.message : err}`;
				json = { providers: {} };
			}
		}
		this.json = json;
		this.initError = undefined;
		const built = buildProviders(this.ctx, json);
		this.providers = built.providers;
		this.auth = built.auth;
		if (this.providerIndex >= this.providers.length) this.providerIndex = Math.max(0, this.providers.length - 1);
		const curModels = this.providers[this.providerIndex]?.models ?? [];
		if (this.modelIndex >= curModels.length) this.modelIndex = Math.max(0, curModels.length - 1);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			this.onClose();
			return;
		}
		if (matchesKey(data, "tab")) {
			this.pane = this.pane === "provider" ? "model" : "provider";
			this.invalidate();
			return;
		}
		if (data === "?") {
			this.help = !this.help;
			this.invalidate();
			return;
		}
		// 导航（循环：第 1 个按 ↑ 跳最后，最后按 ↓ 跳第 1 个）
		const items = this.pane === "provider" ? this.providers : (this.providers[this.providerIndex]?.models ?? []);
		if (items.length === 0) {
			// 空列表：什么都不做
		} else if (matchesKey(data, "up") || data === "k") {
			this.setIndex(this.index() === 0 ? items.length - 1 : this.index() - 1);
		} else if (matchesKey(data, "down") || data === "j") {
			this.setIndex((this.index() + 1) % items.length);
		} else if (data === "g") {
			this.setIndex(0);
		} else if (data === "G") {
			this.setIndex(items.length - 1);
		} else if (data === "n") {
			// n: 新增。若没 provider 则强制切到 provider pane 走 addProviderFlow。
			if (this.pane === "provider") {
				void this.runForm(addProviderFlow);
			} else {
				const cur = this.providers[this.providerIndex];
				if (cur) {
					void this.runForm(addModelFlow, cur.id);
				} else {
					// 无 provider：切到 provider pane 再走 add
					this.pane = "provider";
					this.invalidate();
					this.ctx.ui.notify("先新建 provider：按 n 添加", "info");
				}
			}
		} else if (data === "e") {
			if (this.pane === "provider" && this.providers[this.providerIndex]) {
				const id = this.providers[this.providerIndex].id;
				void this.runForm(editProviderFlow, id);
			} else {
				const prov = this.providers[this.providerIndex];
				const m = prov?.models[this.modelIndex];
				if (prov && m) void this.runForm(editModelFlow, prov.id, m.id);
			}
		} else if (data === "d") {
			const prov = this.providers[this.providerIndex];
			if (this.pane === "provider" && prov) {
				const id = prov.id;
				void this.runForm(deleteProviderFlow, id);
			} else if (prov && prov.models[this.modelIndex]) {
				const id = prov.models[this.modelIndex].id;
				const pid = prov.id;
				void this.runForm(deleteModelFlow, pid, id);
			}
		} else if (data === "y") {
			const sel = this.providers[this.providerIndex];
			if (sel) void this.runSync(sel.id);
			else this.ctx.ui.notify("No provider selected", "warning");
		} else if (data === "t" || data === "T") {
			void this.runTest(data === "T");
		}
	}

	private index(): number {
		return this.pane === "provider" ? this.providerIndex : this.modelIndex;
	}
	private setIndex(i: number): void {
		if (this.pane === "provider") this.providerIndex = i;
		else this.modelIndex = i;
		this.invalidate();
	}

	private async invalidateAndReload(): Promise<void> {
		// 重新读 models.json 并刷新 auth 缓存（仅自定义 provider）
		const json = await readModelsJson();
		this.json = json;
		this.auth = new Map();
		const authStatus = this.ctx.modelRegistry.getProviderAuthStatus;
		if (typeof authStatus === "function") {
			for (const pid of Object.keys(json.providers)) {
				try {
					const s = (authStatus as any)(pid);
					this.auth.set(pid, { hasKey: !!s?.ok, source: s?.source });
				} catch {
					this.auth.set(pid, { hasKey: false });
				}
			}
		}
		this.invalidate();
	}

	/** 统一处理表单：先关掉当前 dashboard 让 editor 出来，form 跑完再重开。
	 *  关键：ctx.ui.input 是 modal dialog，dashboard 的 custom() 会顶住 editor，
	 *  所以必须先 onClose()，等 custom() resolve 后才能正常跑 dialog。
	 *  form 完成后回调 onDone 重开 dashboard，否则 editor 暴露但用户预期在看 dashboard。
	 *  formFn 的签名是 (ctx, ...formArgs, onDone?)；onDone 可选（缺了不崩，只 notify 不重开）。 */
	private async runForm(
		formFn: (ctx: ExtensionCommandContext, ...args: any[]) => Promise<void>,
		...args: any[]
	): Promise<void> {
		const ctx = this.ctx;
		this.onClose();  // 立刻关掉当前 custom()
		await Promise.resolve();  // 等 custom() resolve
		try {
			await (formFn as any)(ctx, ...args, () => {
				void openDashboard(ctx);
			});
		} catch (err) {
			// 任何异常都不让 pi crash
			ctx.ui.notify(`表单异常: ${err instanceof Error ? err.message : err}`, "error");
			void openDashboard(ctx);
		} finally {
			// form 早 return（Esc 中途取消）时 onDone 不会被调用，dashboard 永远不重开。
			// 用 finally 兜底，确保 dashboard 总是恢复。
			void openDashboard(ctx);
		}
	}

	/** sync 的专用包装：runForm 是 `(ctx, ...args, onDone)` 风格，syncFlow 是 `(ctx, opts)` 风格 */
	private async runSync(sourceProviderId: string): Promise<void> {
		const ctx = this.ctx;
		this.onClose();
		await Promise.resolve();
		try {
			await syncFlow(ctx, { sourceProviderId, onDone: () => { void openDashboard(ctx); } });
		} catch (err) {
			ctx.ui.notify(`Sync error: ${err instanceof Error ? err.message : err}`, "error");
		} finally {
			void openDashboard(ctx);
		}
	}

	/** test 调测：t 测当前 model，T 测当前 provider 全部 model。保持 dashboard 不关，结束后重开。 */
	private async runTest(testAll: boolean): Promise<void> {
		const ctx = this.ctx as any;
		const provider = this.providers[this.providerIndex];
		if (!provider) {
			ctx.ui.notify("No provider selected", "warning");
			return;
		}
		if (testAll) {
			const modelIds = provider.models.map((m) => m.id);
			if (modelIds.length === 0) { ctx.ui.notify(`${provider.id} 无 model`, "warning"); return; }
			ctx.ui.notify(`testing ${modelIds.length} model(s) of ${provider.id}...`, "info");
			const results = await testProvider({ ctx, provider: provider.id, modelIds, mode: "full", concurrency: 3 });
			let okCount = 0;
			for (const r of results) {
				if (r.ok) okCount++;
				ctx.ui.notify(formatTestResult(r), r.ok ? "info" : "warning");
			}
			ctx.ui.notify(`${provider.id}: ${okCount}/${results.length} ok`, okCount === results.length ? "success" : "warning");
		} else {
			// t: 测当前 pane 的 model（provider pane 测第一个 model；model pane 测当前 model）
			let modelId: string | undefined;
			if (this.pane === "model") {
				modelId = provider.models[this.modelIndex]?.id;
			} else {
				modelId = provider.models[0]?.id;
			}
			if (!modelId) { ctx.ui.notify(`${provider.id} 无 model`, "warning"); return; }
			ctx.ui.notify(`testing ${provider.id}/${modelId}...`, "info");
			const r = await testModel({ ctx, provider: provider.id, model: modelId, mode: "full" });
			ctx.ui.notify(formatTestResult(r), r.ok ? "success" : "warning");
		}
		this.invalidate();
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedLines = [];
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines.length > 0) return this.cachedLines;
		const th = this.theme;
		const lines: string[] = [];

		// 1. Header
		lines.push(th.fg("accent", th.bold(" provider-manager ")) + th.fg("borderMuted", "─".repeat(Math.max(0, width - 20))));
		lines.push("");

		if (this.initError) {
			lines.push(th.fg("error", `  ⚠ ${this.initError}`));
			lines.push(th.fg("dim", "  按 q 退出，修复 models.json 后 /providers 重开"));
		} else if (this.providers.length === 0) {
			lines.push(th.fg("dim", "  (no providers found)"));
			lines.push(th.fg("dim", "  按 n 新建 provider，或检查 ~/.pi/agent/models.json"));
		} else {
			// 2. Body: 两栏
			const colWidth = Math.max(20, Math.floor((width - 3) / 2));
			const leftLines = this.renderProviderColumn(colWidth, th);
			const rightLines = this.renderModelColumn(colWidth, th);
			const rows = Math.max(leftLines.length, rightLines.length);
			const sep = th.fg("borderMuted", " │ ");
			for (let r = 0; r < rows; r++) {
				const l = leftLines[r] ?? "";
				const rr = rightLines[r] ?? "";
				// 关键：visiblePad 只看可见宽度（剥掉 [tag]...[/tag]），不再被主题标签吃掉 padding
				lines.push(visiblePad(l, colWidth) + sep + rr);
			}
			lines.push("");

			// 3. Detail
			lines.push(th.fg("borderMuted", "─".repeat(width)));
			lines.push(...this.renderDetail(width, th));
		}

		// 4. Footer
		lines.push(th.fg("borderMuted", "─".repeat(width)));
		if (this.help) {
			lines.push(...this.renderHelp(width, th));
		} else {
			lines.push(th.fg("dim", " ↑↓/jk nav · Tab pane · n new · e edit · d del · y sync · t test · T test-all · ? help · q close"));
		}
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	private renderProviderColumn(width: number, th: any): string[] {
		const lines: string[] = [];
		const headerTag = this.pane === "provider" ? th.fg("accent", th.bold("▸ Providers")) : th.fg("muted", "  Providers");
		lines.push(truncateToWidth(headerTag, width));
		lines.push("");
		this.providers.forEach((p, i) => {
			const sel = i === this.providerIndex;
			const arrow = sel && this.pane === "provider" ? th.fg("accent", "▸ ") : "  ";
			const nameTh = sel ? th.bold(p.id) : p.id;
			const cntThemed = th.fg("dim", ` (${p.models.length})`);
			lines.push(visiblePad(arrow + nameTh + cntThemed, width));
		});
		return lines;
	}

	private renderModelColumn(width: number, th: any): string[] {
		const lines: string[] = [];
		const provider = this.providers[this.providerIndex];
		const models = provider?.models ?? [];
		const headerTag = this.pane === "model" ? th.fg("accent", th.bold(`▸ Models (${provider?.id ?? "?"})`)) : th.fg("muted", `  Models (${provider?.id ?? "?"})`);
		lines.push(truncateToWidth(headerTag, width));
		lines.push("");
		if (models.length === 0) {
			lines.push(th.fg("dim", "  (no models)"));
		}
		models.forEach((m, i) => {
			const sel = i === this.modelIndex;
			const arrow = sel ? (this.pane === "model" ? "▸ " : "  ") : "  ";
			const flags = [m.reasoning && "R", m.input.includes("image") && "I"].filter(Boolean).join("");
			const ctx2 = m.contextWindow ? ` ${formatNum(m.contextWindow)}c` : "";
			const max2 = m.maxTokens ? ` ${formatNum(m.maxTokens)}m` : "";
			const flagStr = flags ? ` [${flags}]` : "";
			const raw = arrow + m.id + flagStr + ctx2 + max2;
			const line = truncateToWidth(raw, width);
			lines.push(sel ? th.fg("accent", line) : line);
		});
		return lines;
	}

	private renderDetail(width: number, th: any): string[] {
		const lines: string[] = [];
		if (this.pane === "provider") {
			const p = this.providers[this.providerIndex];
			if (!p) return [th.fg("dim", " (no provider selected)")];
			lines.push(th.fg("accent", th.bold("Provider: ")) + p.id);
			lines.push(`  displayName: ${p.displayName}`);
			lines.push(`  source:      models.json (custom)`);
			lines.push(`  models:      ${p.models.length}`);
			const auth = this.auth.get(p.id);
			if (auth) lines.push(`  auth:        ${auth.hasKey ? th.fg("success", "✓ ") + (auth.source ?? "ok") : th.fg("error", "✗ no key")}`);
			// 原始 json（来自 models.json 的话）
			const raw = this.json?.providers?.[p.id];
			if (raw) {
				lines.push(th.fg("muted", "  raw (from models.json):"));
				const summary = summarizeProviderRaw(raw);
				lines.push(...summary.map((l) => th.fg("dim", "    " + l)));
			}
		} else {
			const p = this.providers[this.providerIndex];
			const m = p?.models[this.modelIndex];
			if (!m) return [th.fg("dim", " (no model selected)")];
			lines.push(th.fg("accent", th.bold("Model: ")) + `${p.id} / ${m.id}`);
			lines.push(`  reasoning:    ${m.reasoning ? "yes" : "no"}`);
			lines.push(`  input:        ${m.input.join(", ") || "(none)"}`);
			lines.push(`  context:      ${m.contextWindow?.toLocaleString() ?? "?"}`);
			lines.push(`  max output:   ${m.maxTokens?.toLocaleString() ?? "?"}`);
			// raw
			const rawModel = this.json?.providers?.[p.id]?.models?.find((mm: any) => mm.id === m.id);
			if (rawModel) {
				lines.push(th.fg("muted", "  raw (from models.json):"));
				lines.push(...summarizeModelRaw(rawModel).map((l) => th.fg("dim", "    " + l)));
			}
		}
		return lines.map((l) => truncateToWidth(l, width));
	}

	private renderHelp(width: number, th: any): string[] {
		return [
			th.fg("accent", "Key bindings"),
			"  ↑/↓ or j/k    navigate in current pane",
			"  g / G          jump to top / bottom",
			"  Tab            switch between Providers and Models pane",
			"  n              new provider (or model on model pane)",
			"  e              edit selected provider / model",
			"  d              delete (with confirm)",
			"  y              sync — fetch remote models for selected provider",
			"  ?              toggle this help",
			"  q / Esc        close dashboard",
			"",
			th.fg("dim", " y sync · t test current model · T test all in provider"),
		].map((l) => truncateToWidth(l, width));
	}
}

function formatNum(n: number): string {
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + "M";
	if (n >= 1_000) return (n / 1_000).toFixed(0) + "k";
	return String(n);
}

function summarizeProviderRaw(raw: any): string[] {
	const lines: string[] = [];
	if (raw.baseUrl) lines.push(`baseUrl: ${raw.baseUrl}`);
	if (raw.api) lines.push(`api: ${raw.api}`);
	if (raw.apiKey) lines.push(`apiKey: ${maskApiKey(raw.apiKey)}`);
	if (raw.authHeader) lines.push(`authHeader: ${raw.authHeader}`);
	if (raw.headers && Object.keys(raw.headers).length) lines.push(`headers: ${Object.keys(raw.headers).length} entries`);
	return lines;
}

function summarizeModelRaw(raw: any): string[] {
	const lines: string[] = [];
	if (raw.name) lines.push(`name: ${raw.name}`);
	if (raw.baseUrl) lines.push(`baseUrl: ${raw.baseUrl}`);
	if (raw.api) lines.push(`api: ${raw.api}`);
	if (raw.cost) lines.push(`cost: in ${raw.cost.input} / out ${raw.cost.output}`);
	if (raw.thinkingLevelMap) {
		const keys = Object.keys(raw.thinkingLevelMap);
		lines.push(`thinkingLevelMap: ${keys.length} levels`);
	}
	return lines;
}

// ============================================================================
// 对外 API
// ============================================================================

export { Dashboard }; // for unit tests


/** 打开 Dashboard（TUI 模式）；非 TUI 走 fallback */
export async function openDashboard(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Dashboard requires TUI mode. Try /providers ls in this mode.", "error");
		return;
	}
	await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
		const dash = new Dashboard(ctx, theme, () => done());
		dash.init();  // 同步初始化，首帧就有数据
		return dash;
	});
}
