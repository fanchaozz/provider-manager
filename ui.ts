/**
 * ui.ts — TUI Dashboard (overlay window)
 *
 * 浮窗式 3 区固定布局（不占对话窗口）：
 *  ┌─────────────────────── /─────────── /──────────────────────┐
 *  │  Providers   2·2✓ 6m  │ Models (kdapi)         2m · 1R · 1I│  <- 顶区（左/右两列）
 *  │  ▸ kdapi  ✓ 2m       │  ▸ minimax-m3  [RI] 1.0Mc 128km     │
 *  │    agnes  ✓ 4m       │    minimax-m2  [--] 256kc 32km       │
 *  │  ⋮ 0 more            │  ⋮ 0 more                             │
 *  │  (1/2)               │  (1/2)                                │
 *  ├───────────────────────┴────────────────────────────────────┤
 *  │  Detail: provider or model info                            │  <- 底区
 *  │  ...                                                       │
 *  ├────────────────────────────────────────────────────────────┤
 *  │  ↑↓ nav · ←→ pane · n new · Enter edit · y sync · ? help   │  <- footer（≤2 行）
 *  └────────────────────────────────────────────────────────────┘
 *
 * 关键约束（按用户要求）：
 *  - 3 个主要区域都使用固定可视行数（PROVIDER_VIEW_ROWS / MODEL_VIEW_ROWS = 8），数据多时滚动。
 *  - 滚动时显示 (current/total)；与 ModelChecklist 一致。
 *  - footer 限制在 2 行内（hint 太长就加 "… [+N]" 截断），永远不撑爆宽度。
 *  - 整个浮窗通过 ctx.ui.custom({ overlay: true }) 打开；表单子流程同样以 overlay 形式打开。
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { readModelsJson, getModelsJsonPath, maskApiKey, type ModelsJson, type ProviderConfig, type ModelConfig } from "./store.ts";
import {
	addProviderFlow,
	addModelFlow,
	editProviderFlow,
	deleteProviderFlow,
	editModelFlow,
	deleteModelFlow,
	syncFlow,
} from "./forms.ts";
import { testModel, testProvider, formatTestResult, type TestMode, type TestResult } from "./test.ts";
import { box, truncateForRender } from "./components.ts";

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
	thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	compat?: Record<string, unknown>;
};

type ProviderRow = {
	id: string;
	displayName: string;
	models: ModelRow[];
};

// ============================================================================
// 布局常量（fixed-height panes）
// ============================================================================

/** Provider 列可视行数（含 header + list + (current/total) 指示）。
 *  列表区 = VIEW_ROWS - 1（header 占 1 行）；超过则滚动并钉住首项。 */
export const PROVIDER_VIEW_ROWS = 8;

/** Model 列可视行数。逻辑同 PROVIDER_VIEW_ROWS。 */
export const MODEL_VIEW_ROWS = 8;

/** Detail 面板可视行数（含分隔 + header + 内容）。超过则滚动；底部 footer 不被顶掉。
 *  12 行对大多数 provider 够用（Identity 4 + Endpoint 3 + Auth 4 = 11 + 间隔）；model 详情更短。
 *  实际取 16：覆盖典型 provider（Identity + Endpoint + Auth，~13 行）和 model（caps+limits+thinking，~10 行）。
 *  仍有超出时截断底部 + "⋮ N more"。 */
export const DETAIL_VIEW_ROWS = 16;

/** Footer 允许的最多行数。hint 拼接后超过此值则加 "+N" 截断。 */
export const FOOTER_MAX_LINES = 2;

/** 浮窗最大宽度（terminal 宽度不足时会被 overlayOptions 折算）。 */
export const OVERLAY_MAX_WIDTH = 100;

/** 浮窗目标宽度。 */
export const OVERLAY_WIDTH = 96;

// ============================================================================
// 工具
// ============================================================================

/** 匹配 pi 风格的 key 字符串：escape / ctrl+c / up / down / enter / tab 等 */
function matchesKey(data: string, key: string): boolean {
	const k = key.toLowerCase();
	if (k.startsWith("ctrl+")) {
		const ch = k.slice(5);
		return data === `\x1b${ch}` || (ch.length === 1 && data === ch && data.charCodeAt(0) < 32);
	}
	switch (k) {
		case "escape": return data === "\x1b" || data === "\x1b\x1b";
		case "enter":
		case "return":  return data === "\r" || data === "\n";
		case "tab":     return data === "\t";
		case "backspace": return data === "\x7f" || data === "\b";
		case "up":      return data === "\x1b[A" || data === "\x1bOA";
		case "down":    return data === "\x1b[B" || data === "\x1bOB";
		case "left":    return data === "\x1b[D" || data === "\x1bOD";
		case "right":   return data === "\x1b[C" || data === "\x1bOC";
		case "home":    return data === "\x1b[H" || data === "\x1bOH";
		case "end":     return data === "\x1b[F" || data === "\x1bOF";
		case "pageup":  return data === "\x1b[5~";
		case "pagedown":return data === "\x1b[6~";
	}
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

/** 主题感知的 pad：把 ANSI 和已知主题标签当作零宽，padding 补到目标可见宽度 */
function visiblePad(s: string, width: number): string {
	const w = visibleWidthStrippingTheme(s);
	if (w >= width) return s;
	return s + " ".repeat(width - w);
}

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

function visibleWidthStrippingTheme(s: string): number {
	let w = 0;
	let i = 0;
	while (i < s.length) {
		if (s[i] === "\x1b" && i + 1 < s.length && s[i + 1] === "[") {
			const close = s.indexOf("m", i + 2);
			if (close !== -1) { i = close + 1; continue; }
			const csiEnd = s.slice(i + 2).search(/[A-Za-z]/);
			if (csiEnd !== -1) { i = i + 2 + csiEnd + 1; continue; }
		}
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

function visualWidth(s: string): number {
	let w = 0;
	for (const ch of s) w += isWide(ch) ? 2 : 1;
	return w;
}

// ============================================================================
// 数据加载
// ============================================================================

function buildProviders(ctx: ExtensionCommandContext, json: ModelsJson): { providers: ProviderRow[]; auth: Map<string, { hasKey: boolean; source?: string }> } {
	const customIds = Object.keys(json.providers).sort();
	const auth = new Map<string, { hasKey: boolean; source?: string }>();
	for (const pid of customIds) {
		const apiKey = json.providers[pid]?.apiKey;
		auth.set(pid, inspectApiKey(apiKey));
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
				thinkingLevelMap: m.thinkingLevelMap,
				cost: m.cost,
				compat: m.compat,
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
	static __test = true;
	private providers: ProviderRow[] = [];
	private auth = new Map<string, { hasKey: boolean; source?: string }>();
	private providerIndex = 0;
	private modelIndex = 0;
	/** provider 列的滚动 offset（顶部可见项在 all providers 中的索引） */
	private providerTop = 0;
	/** model 列的滚动 offset */
	private modelTop = 0;
	private pane: Pane = "provider";
	private help = false;
	private initError?: string;
	private cachedWidth = -1;
	private cachedLines: string[] = [];
	private onClose: () => void;
	private theme: any;
	private ctx: ExtensionCommandContext;
	private json: ModelsJson = { providers: {} };
	/** providerViewRows / modelViewRows 可由构造器覆盖（用于测试窄宽度场景） */
	private providerViewRows: number;
	private modelViewRows: number;
	private detailViewRows: number;

	constructor(
		ctx: ExtensionCommandContext,
		theme: any,
		onClose: () => void,
		opts: { providerViewRows?: number; modelViewRows?: number; detailViewRows?: number } = {},
	) {
		this.ctx = ctx;
		this.theme = theme;
		this.onClose = onClose;
		this.providerViewRows = opts.providerViewRows ?? PROVIDER_VIEW_ROWS;
		this.modelViewRows = opts.modelViewRows ?? MODEL_VIEW_ROWS;
		this.detailViewRows = opts.detailViewRows ?? DETAIL_VIEW_ROWS;
	}

	/** 同步初始化：首帧就有数据，避免 "(no providers found)" 闪烁 */
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
		this.adjustProviderTop();
		this.adjustModelTop();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			this.onClose();
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "right")) {
			this.pane = this.pane === "provider" ? "model" : "provider";
			// 切到 model pane 时重置 model top（避免上一个 provider 的滚动位置传过来）
			if (this.pane === "model") this.modelTop = 0;
			this.invalidate();
			return;
		}
		if (data === "?") {
			this.help = !this.help;
			this.invalidate();
			return;
		}
		// 空列表下 "新增" 是唯一动作，必须在导航块之前判定（避免被吞）
		if (data === "n") {
			if (this.pane === "provider") {
				void this.runForm(addProviderFlow);
			} else {
				const sel = this.providers[this.providerIndex];
				if (sel) void this.runForm(addModelFlow, sel.id);
				else this.ctx.ui.notify("No provider selected", "warning");
			}
			return;
		}
		// 滚动 page up/down：翻整页
		if (matchesKey(data, "pageup")) {
			this.pageJump(-1);
			return;
		}
		if (matchesKey(data, "pagedown")) {
			this.pageJump(+1);
			return;
		}
		const items = this.pane === "provider"
			? this.providers
			: (this.providers[this.providerIndex]?.models ?? []);
		if (items.length === 0) {
			// 空列表：什么都不做（n 已在上面处理）
		} else if (matchesKey(data, "up") || data === "k") {
			if (this.pane === "model") {
				// model pane: 调 setIndex 走 adjustModelTop
				this.setIndex(this.index() === 0 ? items.length - 1 : this.index() - 1);
			} else {
				// provider pane: 换 provider 时重置 model 状态
				if (items.length > 0) {
					const newProvIdx = this.providerIndex === 0 ? items.length - 1 : this.providerIndex - 1;
					this.switchProvider(newProvIdx);
				}
			}
		} else if (matchesKey(data, "down") || data === "j") {
			if (this.pane === "model") {
				this.setIndex((this.index() + 1) % items.length);
			} else {
				if (items.length > 0) {
					const newProvIdx = (this.providerIndex + 1) % items.length;
					this.switchProvider(newProvIdx);
				}
			}
		} else if (data === "g") {
			if (this.pane === "model") {
				this.setIndex(0);
			} else {
				this.switchProvider(0);
			}
		} else if (data === "G") {
			if (this.pane === "model") {
				this.setIndex(items.length - 1);
			} else {
				this.switchProvider(items.length - 1);
			}
		} else if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
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
				void this.runForm(deleteProviderFlow, prov.id);
			} else if (prov && prov.models[this.modelIndex]) {
				const id = prov.models[this.modelIndex].id;
				void this.runForm(deleteModelFlow, prov.id, id);
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
		if (this.pane === "provider") {
			this.providerIndex = i;
			this.adjustProviderTop();
		} else {
			this.modelIndex = i;
			this.adjustModelTop();
		}
		this.invalidate();
	}

	/** 把 providerTop 调整为让 providerIndex 在可视区内的合法值。
	 *  listH 必须与 renderProviderColumn 一致：rows - 2（header + (current/total) 各占 1 行）。 */
	private adjustProviderTop(): void {
		const total = this.providers.length;
		const rows = this.providerViewRows;
		const listH = Math.max(1, rows - 2);
		const needPin = total > listH && this.providerIndex >= listH;
		const viewport = Math.max(1, listH - (needPin ? 1 : 0));
		if (this.providerIndex < this.providerTop) this.providerTop = this.providerIndex;
		if (this.providerIndex >= this.providerTop + viewport) this.providerTop = this.providerIndex - viewport + 1;
		const maxTop = Math.max(0, total - viewport);
		if (this.providerTop > maxTop) this.providerTop = maxTop;
		if (this.providerTop < 0) this.providerTop = 0;
	}

	private adjustModelTop(): void {
		const total = this.providers[this.providerIndex]?.models.length ?? 0;
		const rows = this.modelViewRows;
		const listH = Math.max(1, rows - 2);
		const needPin = total > listH && this.modelIndex >= listH;
		const viewport = Math.max(1, listH - (needPin ? 1 : 0));
		if (this.modelIndex < this.modelTop) this.modelTop = this.modelIndex;
		if (this.modelIndex >= this.modelTop + viewport) this.modelTop = this.modelIndex - viewport + 1;
		const maxTop = Math.max(0, total - viewport);
		if (this.modelTop > maxTop) this.modelTop = maxTop;
		if (this.modelTop < 0) this.modelTop = 0;
	}

	/** 整页翻页（PgUp / PgDn） */
	private pageJump(direction: 1 | -1): void {
		if (this.pane === "provider") {
			const step = Math.max(1, this.providerViewRows - 1);
			const total = this.providers.length;
			if (total === 0) return;
			const next = Math.max(0, Math.min(total - 1, this.providerIndex + direction * step));
			this.setIndex(next);
		} else {
			const total = this.providers[this.providerIndex]?.models.length ?? 0;
			if (total === 0) return;
			const step = Math.max(1, this.modelViewRows - 1);
			const next = Math.max(0, Math.min(total - 1, this.modelIndex + direction * step));
			this.setIndex(next);
		}
	}

	/** 切到某 provider 后，重置 model 索引到合法范围并调整滚动 */
	private setProviderIndex(i: number): void {
		this.switchProvider(i);
	}

	/** 切换 provider：重置 modelIndex/modelTop 到该 provider 合法范围 */
	private switchProvider(i: number): void {
		this.providerIndex = Math.max(0, Math.min(this.providers.length - 1, i));
		const mlen = this.providers[this.providerIndex]?.models.length ?? 0;
		this.modelIndex = Math.max(0, Math.min(mlen - 1, 0));
		this.modelTop = 0;
		this.adjustProviderTop();
		this.adjustModelTop();
		this.invalidate();
	}

	/** 重新从磁盘读 models.json 并刷新（保留选择，如果 provider 还在） */
	private async invalidateAndReload(): Promise<void> {
		const json = await readModelsJson();
		this.json = json;
		this.auth = new Map();
		for (const pid of Object.keys(json.providers)) {
			this.auth.set(pid, inspectApiKey(json.providers[pid]?.apiKey));
		}
		// 重建 provider 列表（保留 selection）
		const newIds = Object.keys(json.providers).sort();
		const stillThere = newIds.includes(this.providers[this.providerIndex]?.id ?? "");
		const built = buildProviders(this.ctx, json);
		this.providers = built.providers;
		if (stillThere) {
			this.providerIndex = this.providers.findIndex(p => p.id === this.providers[this.providerIndex]?.id);
			if (this.providerIndex < 0) this.providerIndex = 0;
		} else {
			this.providerIndex = Math.min(this.providerIndex, Math.max(0, this.providers.length - 1));
		}
		const mlen = this.providers[this.providerIndex]?.models.length ?? 0;
		if (this.modelIndex >= mlen) this.modelIndex = Math.max(0, mlen - 1);
		this.adjustProviderTop();
		this.adjustModelTop();
		this.invalidate();
	}

	/** 统一处理表单：先关掉当前 dashboard 让 form editor 出来，form 跑完再重开。
	 *  关键：ctx.ui.custom() 是 modal dialog，dashboard 的 custom() 会顶住 editor，
	 *  所以必须先 onClose()，等 custom() resolve 后才能正常跑 dialog。
	 *  现在的 form editor 也是 overlay，所以再次打开时是浮窗式编辑。 */
	private async runForm(
		formFn: (ctx: ExtensionCommandContext, ...args: any[]) => Promise<void>,
		...args: any[]
	): Promise<void> {
		const ctx = this.ctx;
		this.onClose();
		await Promise.resolve();
		// 表单可能早 return（Esc）不调 onDone；用 ensureReopen 标志保证只重开一次
		let reopened = false;
		const ensureReopen = () => {
			if (reopened) return;
			reopened = true;
			void openDashboard(ctx);
		};
		try {
			await (formFn as any)(ctx, ...args, ensureReopen);
			// 写盘后（add/edit/delete 完成）重新读盘刷新 dashboard 数据
			await this.refreshFromDisk();
		} catch (err) {
			ctx.ui.notify(`表单异常: ${err instanceof Error ? err.message : err}`, "error");
		} finally {
			// form 早 return（Esc 中途取消）onDone 不会被调用，dashboard 永远不重开。finally 兜底
			ensureReopen();
		}
	}

	private async runSync(sourceProviderId: string): Promise<void> {
		const ctx = this.ctx;
		this.onClose();
		await Promise.resolve();
		let reopened = false;
		const ensureReopen = () => {
			if (reopened) return;
			reopened = true;
			void openDashboard(ctx);
		};
		try {
			await syncFlow(ctx, { sourceProviderId, onDone: ensureReopen });
			await this.refreshFromDisk();
		} catch (err) {
			ctx.ui.notify(`Sync error: ${err instanceof Error ? err.message : err}`, "error");
		} finally {
			ensureReopen();
		}
	}

	/** test 调测：t 测当前 model，T 测当前 provider 全部 model。
	 * 与 edit/sync 统一：关掉 dashboard → TestPanel 浮窗 → 关闭后重开 dashboard。 */
	private async runTest(testAll: boolean): Promise<void> {
		const ctx = this.ctx;
		const provider = this.providers[this.providerIndex];
		if (!provider) {
			ctx.ui.notify("No provider selected", "warning");
			return;
		}
		let modelIds: string[];
		if (testAll) {
			modelIds = provider.models.map((m) => m.id);
			if (modelIds.length === 0) { ctx.ui.notify(`${provider.id} 无 model`, "warning"); return; }
		} else {
			// t: 测当前 pane 的 model（provider pane 测第一个 model；model pane 测当前 model）
			let modelId: string | undefined;
			if (this.pane === "model") modelId = provider.models[this.modelIndex]?.id;
			else modelId = provider.models[0]?.id;
			if (!modelId) { ctx.ui.notify(`${provider.id} 无 model`, "warning"); return; }
			modelIds = [modelId];
		}
		this.onClose();
		await Promise.resolve();
		try {
			await openTestPanel(ctx, { provider: provider.id, modelIds, mode: "full", concurrency: 3 });
		} catch (err) {
			ctx.ui.notify(`Test error: ${err instanceof Error ? err.message : err}`, "error");
		} finally {
			void openDashboard(ctx);
		}
	}

	/** 重新从磁盘读（用于 form 写盘后刷新） */
	private async refreshFromDisk(): Promise<void> {
		try { await this.invalidateAndReload(); } catch { /* 静默：UI 仍展示旧数据 */ }
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedLines = [];
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines.length > 0) return this.cachedLines;
		const th = this.theme;
		const body: string[] = [];

		// box 外边框占 4 列（│×2 + 内边距×2），内容按 width-4 布局避免套框超宽
		const cw = Math.max(20, width - 4);

		// 1. Header (title + stats)
		body.push(this.renderTitleBar(cw, th));

		if (this.initError) {
			body.push(th.fg("error", `  ⚠ ${this.initError}`));
			body.push(th.fg("dim", "  按 q 退出，修复 models.json 后 /providers 重开"));
		} else if (this.providers.length === 0) {
			body.push(...this.renderEmptyState(cw, th));
		} else {
			// 2. Top region: 左 providers | 右 models（固定列宽 = cw/2 - sep）
			body.push(...this.renderTopRegion(cw, th));

			// 3. Bottom region: detail panel（固定高度 = detailViewRows）
			body.push(...this.renderDetailRegion(cw, th));
		}

		// 4. Footer（hint 拼接 + wrap，限 2 行）
		body.push(th.fg("borderMuted", "─".repeat(cw)));
		if (this.help) {
			body.push(...this.renderHelp(cw, th));
		} else {
			body.push(...this.renderFooter(cw, th));
		}

		// 外边框：浮窗加 box，让 tui 里的 overlay 看起来不糊。title 用 " provider-manager "
		const lines = box(th, width, "provider-manager", body);
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	// ------------------------------------------------------------------------
	// Title bar
	// ------------------------------------------------------------------------

	private renderTitleBar(width: number, th: any): string {
		const totalModels = this.providers.reduce((s, p) => s + p.models.length, 0);
		const authed = Array.from(this.auth.values()).filter(a => a?.hasKey).length;
		const stats = this.providers.length === 0
			? "no providers"
			: `${this.providers.length}P · ${totalModels}M${authed > 0 ? ` · ${authed}✓` : ""}`;
		const title = th.fg("accent", th.bold(" provider-manager "));
		const right = th.fg("dim", " " + stats + " ");
		const titleW = 18;
		const rightW = visibleWidthStrippingTheme(right);
		const fill = Math.max(2, width - titleW - rightW);
		return title + th.fg("borderMuted", "─".repeat(fill)) + right;
	}

	// ------------------------------------------------------------------------
	// Empty state
	// ------------------------------------------------------------------------

	private renderEmptyState(width: number, th: any): string[] {
		const out: string[] = [];
		const w = Math.max(20, width - 4);
		const top = "┌" + "─".repeat(w - 2) + "┐";
		const bot = "└" + "─".repeat(w - 2) + "┘";
		const box = (s: string) => th.fg("dim", "│") + th.fg("dim", padBox(s, w - 2)) + th.fg("dim", "│");
		out.push("");
		out.push(th.fg("dim", "  " + top));
		out.push("  " + box("  (no providers found)"));
		out.push("  " + box(""));
		out.push("  " + box("  Press " + "[accent]n[/accent] to add the first provider."));
		out.push("  " + box("  Or check ~/.pi/agent/models.json."));
		out.push("  " + th.fg("dim", bot));
		return out;
	}

	// ------------------------------------------------------------------------
	// Top region (providers | models)
	// ------------------------------------------------------------------------

	private renderTopRegion(width: number, th: any): string[] {
		const sep = th.fg("borderMuted", " │ ");
		const sepW = visibleWidthStrippingTheme(sep);
		const colWidth = Math.max(20, Math.floor((width - sepW) / 2));
		// 左列固定 providerViewRows，右列固定 modelViewRows，取大者作为区域高度
		const leftLines = this.renderProviderColumn(colWidth, th);
		const rightLines = this.renderModelColumn(colWidth, th);
		const targetRows = Math.max(this.providerViewRows, this.modelViewRows);
		const merged: string[] = [];
		for (let r = 0; r < targetRows; r++) {
			const l = (leftLines[r] ?? "").padEnd(colWidth, " ");
			const rr = rightLines[r] ?? "";
			// 主题标签感知的 pad
			merged.push(visiblePad(l, colWidth) + sep + rr);
		}
		// 区域顶部空 1 行
		return ["", ...merged];
	}

	private renderProviderColumn(width: number, th: any): string[] {
		const lines: string[] = [];
		const totalModels = this.providers.reduce((s, p) => s + p.models.length, 0);
		const authed = Array.from(this.auth.values()).filter(a => a?.hasKey).length;
		const stats = ` ${this.providers.length}·${authed}✓ ${totalModels}m `;
		const headActive = this.pane === "provider";
		const headPrefix = headActive ? "▸ " : "  ";
		const headBase = "Providers";
		const headPlain = truncateToWidth(headPrefix + headBase + stats, width);
		const head = headActive ? th.fg("accent", th.bold(headPlain)) : th.fg("muted", th.bold(headPlain));
		lines.push(head);

		const total = this.providers.length;
		// 列总高 = viewRows；listH = viewRows - 2（header + (current/total) 各 1 行）
		const listH = Math.max(1, this.providerViewRows - 2);
		const needPin = total > listH && this.providerIndex >= listH;
		const viewport = Math.max(1, listH - (needPin ? 1 : 0));
		const startIdx = this.providerTop;
		const endIdx = Math.min(total, startIdx + viewport);

		// pin-first 行：列表>listH 且 cursor 移出可视区时
		if (needPin && total > 0) {
			const first = this.providers[0]!;
			const auth = this.auth.get(first.id);
			const authIcon = auth?.hasKey ? th.fg("success", "✓ ") : th.fg("error", "✗ ");
			const cnt = th.fg("dim", ` ${first.models.length}m`);
			const line = "  " + th.bold(first.id) + authIcon + cnt + th.fg("muted", " (top)");
			lines.push(visiblePad(line, width));
		}

		// 列表项
		for (let i = startIdx; i < endIdx; i++) {
			const p = this.providers[i]!;
			const sel = i === this.providerIndex;
			const isActivePane = sel && this.pane === "provider";
			const arrow = isActivePane ? th.fg("accent", "▸ ") : "  ";
			const nameTh = sel ? th.bold(p.id) : p.id;
			const auth = this.auth.get(p.id);
			let authIcon = "  ";
			if (auth) authIcon = auth.hasKey ? th.fg("success", "✓ ") : th.fg("error", "✗ ");
			const cnt = th.fg("dim", ` ${p.models.length}m`);
			const warn = p.models.length === 0 ? th.fg("warning", " ⚠") : "";
			const line = arrow + nameTh + authIcon + cnt + warn;
			lines.push(visiblePad(line, width));
		}

		// 补齐空白：行数到 (viewRows - 1) = listH + pin
		const usedRows = lines.length;
		const listUsed = usedRows - 1;  // 不含 header
		const listMax = needPin ? listH : Math.max(listH, listUsed);
		for (let i = listUsed; i < listMax; i++) {
			lines.push(" ".repeat(width));
		}

		// 位置指示 (current/total)：固定最后 1 行
		if (total > 0) {
			lines.push(th.fg("muted", `  (${this.providerIndex + 1}/${total})`));
		} else {
			lines.push(th.fg("muted", "  (0/0)"));
		}

		return lines;
	}

	private renderModelColumn(width: number, th: any): string[] {
		const lines: string[] = [];
		const provider = this.providers[this.providerIndex];
		const models = provider?.models ?? [];
		const rCount = models.filter(m => m.reasoning).length;
		const iCount = models.filter(m => m.input.includes("image")).length;
		const stats = models.length > 0 ? ` ${models.length}m · ${rCount}R · ${iCount}I ` : " 0m ";
		const isHeadActive = this.pane === "model" && !!provider;
		const headPrefix = isHeadActive ? "▸ " : "  ";
		const headBase = provider ? `Models (${provider.id})` : "Models";
		const headPlain = truncateToWidth(headPrefix + headBase + stats, width);
		const headColored = isHeadActive ? th.fg("accent", th.bold(headPlain)) : th.fg("muted", th.bold(headPlain));
		lines.push(headColored);

		// listH = viewRows - 2（header + (current/total)）
		const listH = Math.max(1, this.modelViewRows - 2);

		if (models.length === 0) {
			lines.push(th.fg("dim", "  (no models)"));
			lines.push(th.fg("dim", "  Press y to sync from remote"));
			// 补齐到 listH 行
			for (let i = lines.length - 1; i < listH; i++) lines.push(" ".repeat(width));
			lines.push(th.fg("muted", "  (0/0)"));
			return lines;
		}

		const total = models.length;
		const needPin = total > listH && this.modelIndex >= listH;
		const viewport = Math.max(1, listH - (needPin ? 1 : 0));
		const startIdx = this.modelTop;
		const endIdx = Math.min(total, startIdx + viewport);

		if (needPin) {
			const first = models[0]!;
			const arrow = "  ";
			const rFlag = first.reasoning ? "R" : "-";
			const iFlag = first.input.includes("image") ? "I" : "-";
			const flagStr = ` [${rFlag}${iFlag}]`;
			const ctx2 = first.contextWindow ? ` ${formatNum(first.contextWindow)}c` : "";
			const max2 = first.maxTokens ? ` ${formatNum(first.maxTokens)}m` : "";
			const raw = arrow + first.id + flagStr + ctx2 + max2 + th.fg("muted", " (top)");
			lines.push(truncateToWidth(raw, width));
		}

		for (let i = startIdx; i < endIdx; i++) {
			const m = models[i]!;
			const sel = i === this.modelIndex;
			const isActivePane = sel && this.pane === "model";
			const arrow = isActivePane ? "▸ " : "  ";
			const rFlag = m.reasoning ? "R" : "-";
			const iFlag = m.input.includes("image") ? "I" : "-";
			const flagStr = ` [${rFlag}${iFlag}]`;
			const ctx2 = m.contextWindow ? ` ${formatNum(m.contextWindow)}c` : "";
			const max2 = m.maxTokens ? ` ${formatNum(m.maxTokens)}m` : "";
			const raw = arrow + m.id + flagStr + ctx2 + max2;
			const line = truncateToWidth(raw, width);
			lines.push(sel ? th.fg("accent", line) : line);
		}

		// 补齐到 listH 行
		const listUsed = lines.length - 1;
		const listMax = needPin ? listH : Math.max(listH, listUsed);
		for (let i = listUsed; i < listMax; i++) lines.push(" ".repeat(width));

		// 位置指示
		lines.push(th.fg("muted", `  (${this.modelIndex + 1}/${total})`));
		return lines;
	}

	// ------------------------------------------------------------------------
	// Detail region (固定高度)
	// ------------------------------------------------------------------------

	private renderDetailRegion(width: number, th: any): string[] {
		const out: string[] = [];
		// 区域分隔：top region 末尾已有 1 空行 + 1 行内容；detail 顶部再补 1 空行 + 1 行 title
		out.push("");

		let content: string[] = [];
		if (this.pane === "provider") {
			content = this.renderProviderDetail(width, th);
		} else {
			content = this.renderModelDetail(width, th);
		}

		// 限高：超出则截断底部 + 加 "⋮ N more"
		if (content.length > this.detailViewRows) {
			content = content.slice(0, this.detailViewRows - 1);
			content.push(th.fg("muted", `  ⋮ ${content.length - this.detailViewRows + 1} more (use ↑↓ for navigation, ? for help)`));
		}
		while (content.length < this.detailViewRows) {
			content.push(" ".repeat(width));
		}
		out.push(...content);
		return out;
	}

	private renderProviderDetail(width: number, th: any): string[] {
		const lines: string[] = [];
		const p = this.providers[this.providerIndex];
		if (!p) return [th.fg("dim", " (no provider selected)")];
		const auth = this.auth.get(p.id);
		const authIcon = auth
			? (auth.hasKey ? th.fg("success", "✓ ") : th.fg("error", "✗ "))
			: th.fg("dim", "  ");
		lines.push(th.fg("accent", th.bold(`  ${authIcon} Provider: `)) + th.bold(p.id));
		lines.push("");
		lines.push(th.fg("muted", "  Identity"));
		lines.push(`    displayName:   ${p.displayName || th.fg("dim", "(unset)")}`);
		lines.push(`    source:        models.json (custom)`);
		lines.push(`    models:        ${p.models.length}`);
		const raw = this.json?.providers?.[p.id] as any;
		if (raw) {
			lines.push("");
			lines.push(th.fg("muted", "  Endpoint"));
			lines.push(`    baseUrl:       ${raw.baseUrl || th.fg("dim", "(unset)")}`);
			lines.push(`    api:           ${raw.api || th.fg("dim", "(unset)")}`);
			if (raw.proxy) lines.push(`    proxy:         ${raw.proxy}`);
			lines.push("");
			lines.push(th.fg("muted", "  Auth"));
			lines.push(`    apiKey:        ${maskApiKey(raw.apiKey)}`);
			lines.push(`    authHeader:    ${raw.authHeader ? "yes" : "no"}`);
			if (auth) {
				const statusColor = auth.hasKey ? th.fg("success", "✓ set") : th.fg("warning", "✗ empty");
				lines.push(`    apiKey status: ${statusColor}${auth.source && auth.source !== "empty" ? th.fg("dim", " (" + auth.source + ")") : ""}`);
			}
		}
		return lines.map((l) => truncateToWidth(l, width));
	}

	private renderModelDetail(width: number, th: any): string[] {
		const lines: string[] = [];
		const p = this.providers[this.providerIndex];
		const m = p?.models[this.modelIndex];
		if (!m) return [th.fg("dim", " (no model selected)")];
		lines.push(th.fg("accent", th.bold(`  Model: `)) + `${p.id} / ${m.id}`);
		lines.push("");
		lines.push(th.fg("muted", "  Capabilities"));
		lines.push(`    reasoning:     ${m.reasoning ? th.fg("accent", "yes") : th.fg("dim", "no")}`);
		lines.push(`    input:         ${m.input.join(", ") || th.fg("dim", "(none)")}`);
		lines.push("");
		lines.push(th.fg("muted", "  Limits"));
		lines.push(`    context:       ${m.contextWindow?.toLocaleString() ?? th.fg("dim", "?")}`);
		lines.push(`    max output:    ${m.maxTokens?.toLocaleString() ?? th.fg("dim", "?")}`);
		const tlm = m.thinkingLevelMap;
		if (tlm && typeof tlm === "object") {
			const enabled = (Object.entries(tlm) as [string, string | null][])
				.filter(([, v]) => v !== null && v !== undefined)
				.map(([k]) => k);
			if (enabled.length) {
				lines.push("");
				lines.push(`  Thinking levels:  ${th.fg("text", enabled.join(", "))}`);
			}
		}
		const cost = m.cost;
		if (cost) {
			lines.push("");
			lines.push(th.fg("muted", "  Cost"));
			lines.push(`    input:        $${cost.input}/M`);
			lines.push(`    output:       $${cost.output}/M`);
			if (cost.cacheRead) lines.push(`    cache read:   $${cost.cacheRead}/M`);
			if (cost.cacheWrite) lines.push(`    cache write:  $${cost.cacheWrite}/M`);
		}
		const compat = m.compat;
		if (compat && typeof compat === "object") {
			lines.push("");
			lines.push(th.fg("muted", "  Compat"));
			if (typeof (compat as any).supportsDeveloperRole === "boolean") {
				const sdr = (compat as any).supportsDeveloperRole;
				lines.push(`    supportsDeveloperRole: ${sdr ? th.fg("success", "yes") : th.fg("warning", "no")}`);
			}
		}
		return lines.map((l) => truncateToWidth(l, width));
	}

	// ------------------------------------------------------------------------
	// Footer (wrap & cap at FOOTER_MAX_LINES)
	// ------------------------------------------------------------------------

	private renderFooter(width: number, th: any): string[] {
		// 空态：只保留 add 动作
		if (this.providers.length === 0) {
			const line = " n add first provider · ? help · q close";
			return [th.fg("dim", truncateToWidth(line, width))];
		}
		const parts: string[] = ["↑↓/jk nav", "←→ pane", "PgUp/PgDn scroll"];
		if (this.pane === "provider") {
			parts.push("n new", "Enter edit", "y sync");
		} else {
			parts.push("n new", "Enter edit", "t test", "T test-all");
		}
		parts.push("d del", "? help", "q close");

		// 用 " · " 拼接，然后按 width 软 wrap（每段后尝试换行）
		const innerW = Math.max(20, width - 1);  // 留 1 个 leading 空格
		const sep = " · ";
		const out: string[] = [];
		let cur = "";
		let curW = 0;
		for (const p of parts) {
			const w = visualWidth(p);
			const need = cur.length === 0 ? w : curW + sep.length + w;
			if (need > innerW && cur.length > 0) {
				out.push(th.fg("dim", " " + cur));
				cur = p;
				curW = w;
			} else {
				cur = cur.length === 0 ? p : cur + sep + p;
				curW = need;
			}
		}
		if (cur.length > 0) out.push(th.fg("dim", " " + cur));

		// 截断到 FOOTER_MAX_LINES：超出则末行后加 "+N more" 提示
		if (out.length > FOOTER_MAX_LINES) {
			const kept = out.slice(0, FOOTER_MAX_LINES - 1);
			const remain = out.length - kept.length;
			kept.push(th.fg("dim", ` ⋮ +${remain} more (press ? for full help)`));
			return kept;
		}
		return out;
	}

	private renderHelp(width: number, th: any): string[] {
		const lines: string[] = [
			th.fg("accent", "Key bindings"),
			"  ↑/↓ or j/k    navigate in current pane",
			"  g / G          jump to top / bottom",
			"  PgUp/PgDn      page scroll",
			"  ← / →          switch between Providers and Models pane",
			"  Enter          edit selected provider / model",
			"  d              delete (with confirm)",
			"  y              sync — fetch remote models for selected provider",
			"  ?              toggle this help",
			"  q / Esc        close dashboard",
		];
		if (this.pane === "provider") {
			lines.splice(5, 0, "  n              new provider (model 仍走 sync)");
		} else {
			lines.splice(5, 0, "  n              new model manually (sync 拉不到时；走 defaultModel 模板)", "  t / T          test current model / test all in provider");
		}
		// help 也限 2 行（实际内容比较多，截到 2 行 + "…" 提示，避免无界增长）
		const head = lines[0]!;
		const body = lines.slice(1, FOOTER_MAX_LINES);
		const more = lines.length - 1 - body.length;
		return [head, ...body, th.fg("muted", `  ⋮ +${more} more (press any key to dismiss)`)];
	}
}

// ============================================================================
// 工具
// ============================================================================

function padBox(s: string, width: number): string {
	// strip theme tags for width measurement
	const w = visibleWidthStrippingTheme(s);
	if (w >= width) return s + " ".repeat(Math.max(0, width - w));
	return s + " ".repeat(width - w);
}

function formatNum(n: number): string {
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + "M";
	if (n >= 1_000) return (n / 1_000).toFixed(0) + "k";
	return String(n);
}

function inspectApiKey(apiKey: unknown): { hasKey: boolean; source?: string } {
	if (typeof apiKey !== "string" || apiKey.length === 0) return { hasKey: false, source: "empty" };
	if (apiKey.startsWith("!")) return { hasKey: true, source: "models.json_command" };
	if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(apiKey)) return { hasKey: true, source: "models.json_env" };
	return { hasKey: true, source: "models_json_key" };
}

// ============================================================================
// TestPanel — t/T 测试结果浮窗（与 dashboard / form / checklist 同为 overlay）
// ============================================================================

/** TestPanel 结果区可视行数（固定高度；多 model 走紧凑 1 行/model，超出滚动） */
export const TEST_RESULT_VIEW_ROWS = 12;

export type TestPanelOpts = {
	ctx: ExtensionCommandContext;
	provider: string;
	modelIds: string[];
	mode?: TestMode;
	concurrency?: number;
};

class TestPanel {
	static __test = true;
	private ctx: ExtensionCommandContext;
	private provider: string;
	private modelIds: string[];
	private mode: TestMode;
	private concurrency: number;
	private results: (TestResult | undefined)[] = [];
	private doneCount = 0;
	private finished = false;
	private closed = false;
	private top = 0;
	private tui: { requestRender(): void };
	private theme: any;
	private done: () => void;
	private cachedWidth = -1;
	private cachedLines: string[] = [];

	constructor(opts: TestPanelOpts & { tui: { requestRender(): void }; theme: any; done: () => void }) {
		this.ctx = opts.ctx;
		this.provider = opts.provider;
		this.modelIds = opts.modelIds;
		this.mode = opts.mode ?? "full";
		this.concurrency = opts.concurrency ?? 3;
		this.tui = opts.tui;
		this.theme = opts.theme;
		this.done = opts.done;
		void this.run();
	}

	/** 跑测试并实时刷新；q/Esc 关闭后继续在后台跑完（结果进 session cache），不再 render。 */
	private async run(): Promise<void> {
		try {
			if (this.modelIds.length === 1) {
				const r = await testModel({ ctx: this.ctx as any, provider: this.provider, model: this.modelIds[0]!, mode: this.mode });
				if (this.closed) return;
				this.results[0] = r;
				this.doneCount = 1;
			} else {
				await testProvider({
					ctx: this.ctx as any,
					provider: this.provider,
					modelIds: this.modelIds,
					mode: this.mode,
					concurrency: this.concurrency,
					onProgress: (done, _total, result) => {
						if (this.closed) return;
						const idx = this.modelIds.indexOf(result.model);
						if (idx >= 0) this.results[idx] = result;
						this.doneCount = done;
						this.top = Math.max(0, this.resultLines().length - TEST_RESULT_VIEW_ROWS);
						this.invalidate();
						this.tui.requestRender();
					},
				});
			}
		} catch {
			// testModel/testProvider 内部已逐个 catch；这里兜底防面板崩
		}
		if (this.closed) return;
		this.finished = true;
		this.top = Math.max(0, this.resultLines().length - TEST_RESULT_VIEW_ROWS);
		this.invalidate();
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			this.closed = true;
			this.done();
			return;
		}
		if (!this.finished) return;
		const maxTop = Math.max(0, this.resultLines().length - TEST_RESULT_VIEW_ROWS);
		if ((matchesKey(data, "down") || data === "j") && this.top < maxTop) {
			this.top++;
			this.invalidate();
		} else if ((matchesKey(data, "up") || data === "k") && this.top > 0) {
			this.top--;
			this.invalidate();
		}
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedLines = [];
	}

	/** 全部结果行（未截断）。多 model 紧凑：1 行/model + 失败详情；单 model 完整 formatTestResult。 */
	private resultLines(): string[] {
		const th = this.theme;
		const out: string[] = [];
		const compact = this.modelIds.length > 1;
		for (let i = 0; i < this.modelIds.length; i++) {
			const r = this.results[i];
			if (!r) continue;
			if (compact) {
				const icon = r.ok ? th.fg("success", "✓ ") : th.fg("error", "✗ ");
				const id = r.ok ? r.model : th.bold(r.model);
				out.push(`  ${icon}${id}  ${th.fg("dim", `(${r.latencyMs}ms)`)}`);
				if (!r.ok) {
					const err = r.checks.auth.error ?? r.checks.reachable.error ?? r.checks.generated?.error;
					if (err) out.push(`      ${th.fg("error", "✗")} ${th.fg("dim", err)}`);
				}
			} else {
				for (const ln of formatTestResult(r).split("\n")) out.push("  " + ln);
			}
		}
		return out;
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines.length > 0) return this.cachedLines;
		const th = this.theme;
		const body: string[] = [];

		// box 外边框占 4 列（│×2 + 内边距×2），内容按 width-4 布局避免套框超宽
		const cw = Math.max(20, width - 4);
		if (this.finished) {
			const okCount = this.results.filter(r => r?.ok).length;
			const allOk = okCount === this.modelIds.length;
			body.push(th.fg(allOk ? "success" : "warning", `  ${allOk ? "✓" : "✗"} ${this.modelIds.length} tested, ${okCount} ok`));
		} else {
			body.push(th.fg("dim", `  testing ${this.doneCount}/${this.modelIds.length} ...`));
		}
		body.push("");
		const all = this.resultLines();
		const start = this.top;
		const end = Math.min(all.length, start + TEST_RESULT_VIEW_ROWS);
		for (let i = start; i < end; i++) body.push(truncateForRender(all[i]!, cw));
		if (end < all.length) body.push(th.fg("muted", `  ⋮ ${all.length - end} more below (↓)`));
		else if (start > 0) body.push(th.fg("muted", `  ⋮ ${start} above (↑)`));
		body.push("");
		if (this.finished) {
			const okCount = this.results.filter(r => r?.ok).length;
			body.push(`  ${this.provider}: ${okCount}/${this.modelIds.length} ok`);
		}
		body.push(th.fg("borderMuted", "─".repeat(cw)));
		body.push(th.fg("dim", this.finished ? " ↑↓/jk scroll · q/Esc close" : " testing… · q/Esc close"));
		const title = this.modelIds.length === 1
			? `Test ${this.provider}/${this.modelIds[0]}`
			: `Test ${this.provider}: ${this.modelIds.length} models`;
		const lines = box(th, width, title, body);
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

// ============================================================================
// 对外 API
// ============================================================================

export { Dashboard, TestPanel };

/** 打开 Dashboard（TUI 模式）；非 TUI 走 fallback
 *  现在的实现是浮窗：ctx.ui.custom({ overlay: true })。
 *  子流程（add/edit/sync）也以 overlay 形式打开（见 forms.ts runFormEditor 等），整个会话不会被任何 form 顶掉。 */
export async function openDashboard(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Dashboard requires TUI mode. Try /providers ls in this mode.", "error");
		return;
	}
	await ctx.ui.custom<void>(
		(_tui, theme, _kb, done) => {
			const dash = new Dashboard(ctx, theme, () => done());
			dash.init();
			return dash;
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: OVERLAY_WIDTH,
				maxWidth: OVERLAY_MAX_WIDTH,
				// minWidth 给窄终端一个下限（terminal 宽度 < width 时 overlay 框架会自适应）
				minWidth: 60,
			},
		},
	);
}

/** 打开测试浮窗（TUI 模式）；非 TUI 走 notify fallback（跑完一次性展示） */
export async function openTestPanel(ctx: ExtensionCommandContext, opts: TestPanelOpts): Promise<void> {
	if (ctx.mode !== "tui") {
		const mode = opts.mode ?? "full";
		if (opts.modelIds.length === 1) {
			const r = await testModel({ ctx: ctx as any, provider: opts.provider, model: opts.modelIds[0]!, mode });
			ctx.ui.notify(formatTestResult(r), "info");
			return;
		}
		const results = await testProvider({ ctx: ctx as any, provider: opts.provider, modelIds: opts.modelIds, mode, concurrency: opts.concurrency ?? 3 });
		const okCount = results.filter(r => r.ok).length;
		const summary = results.map(r => formatTestResult(r)).join("\n\n") + `\n${opts.provider}: ${okCount}/${results.length} ok`;
		ctx.ui.notify(summary, "info");
		return;
	}
	await ctx.ui.custom<void>(
		(tui, theme, _kb, done) => new TestPanel({ ctx, provider: opts.provider, modelIds: opts.modelIds, mode: opts.mode, concurrency: opts.concurrency, tui, theme, done: () => done() }),
		{ overlay: true, overlayOptions: { anchor: "center", width: 88, minWidth: 60 } },
	);
}
