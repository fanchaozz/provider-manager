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
	// 详情面板需要从 raw ModelConfig 透传
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

	// 本插件只管理 models.json 里的 url+apiKey 自定义 provider（无 OAuth）。
	// 直接从 json.providers[pid].apiKey 自检，避开 pi runtime 的多路径判断。
	// source 标识 key 来源：models.json_key（明文）、models.json_env（$ENV）、models.json_command（!cmd）、empty（未设）。
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
				// 详情面板需要这些字段
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
		if (matchesKey(data, "left") || matchesKey(data, "right")) {
			this.pane = this.pane === "provider" ? "model" : "provider";
			this.invalidate();
			return;
		}
		if (data === "?") {
			this.help = !this.help;
			this.invalidate();
			return;
		}
		// 空列表下"新增 provider"是唯一可执行动作，必须在导航块之前判定。
		// 否则 n 会落到 else if 链外的 if (items.length === 0) 分支被吞掉。
		if (data === "n") {
			if (this.pane === "provider") {
				void this.runForm(addProviderFlow);
			} else {
				this.ctx.ui.notify("model 不能直接新增，请用 sync（按 y）", "info");
			}
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
		} else if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
			// Enter → 选中项的编辑（与原 'e' 行为一致）。model 仅允许 edit，不允许 new。
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
		for (const pid of Object.keys(json.providers)) {
			this.auth.set(pid, inspectApiKey(json.providers[pid]?.apiKey));
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
			}
			// 批量结果拼成一条 notify：逐条 notify 会被 showStatus 原地覆盖，只残留汇总行
			const summary = results.map((r) => formatTestResult(r)).join("\n\n") + `\n${provider.id}: ${okCount}/${results.length} ok`;
			ctx.ui.notify(summary, "info");
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
			// 同上：统一 info 避免滞留
			ctx.ui.notify(formatTestResult(r), "info");
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

		// 1. Header (title + stats)
		lines.push(this.renderTitleBar(width, th));

		if (this.initError) {
			lines.push(th.fg("error", `  ⚠ ${this.initError}`));
			lines.push(th.fg("dim", "  按 q 退出，修复 models.json 后 /providers 重开"));
		} else if (this.providers.length === 0) {
			lines.push(...this.renderEmptyState(th));
		} else {
			// 2. Body: 两栏
			lines.push("");
			const colWidth = Math.max(24, Math.floor((width - 3) / 2));
			const leftLines = this.renderProviderColumn(colWidth, th);
			const rightLines = this.renderModelColumn(colWidth, th);
			const rows = Math.max(leftLines.length, rightLines.length);
			const sep = th.fg("borderMuted", " │ ");
			for (let r = 0; r < rows; r++) {
				const l = leftLines[r] ?? "";
				const rr = rightLines[r] ?? "";
				lines.push(visiblePad(l, colWidth) + sep + rr);
			}

			// 3. Detail
			lines.push("");
			lines.push(...this.renderDetail(width, th));
		}

		// 4. Footer
		lines.push(th.fg("borderMuted", "─".repeat(width)));
		if (this.help) {
			lines.push(...this.renderHelp(width, th));
		} else if (this.providers.length === 0) {
			// 空态：导航/编辑/同步/删除 均无意义，只保留有效动作
			lines.push(th.fg("dim", " n add first provider · ? help · q close"));
		} else {
			const parts = ["↑↓/jk nav", "←→ pane"];
			if (this.pane === "provider") parts.push("n new", "Enter edit", "y sync");
			else parts.push("Enter edit", "y sync", "t test", "T test-all");
			parts.push("d del", "? help", "q close");
			lines.push(th.fg("dim", " " + parts.join(" · ")));
		}
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	/** title bar：左侧包名+粗体，右侧 stats（providers/models/authed） */
	private renderTitleBar(width: number, th: any): string {
		const totalModels = this.providers.reduce((s, p) => s + p.models.length, 0);
		const authed = Array.from(this.auth.values()).filter(a => a?.hasKey).length;
		const stats = this.providers.length === 0
			? "no providers"
			: `${this.providers.length}P · ${totalModels}M${authed > 0 ? ` · ${authed}✓` : ""}`;
		const title = th.fg("accent", th.bold(" provider-manager "));
		const right = th.fg("dim", " " + stats + " ");
		const titleW = 18;  //  " provider-manager " visible length
		const rightW = visibleWidthStrippingTheme(right);
		const fill = Math.max(2, width - titleW - rightW);
		return title + th.fg("borderMuted", "─".repeat(fill)) + right;
	}

	/** 无 provider 时的空态提示 */
	private renderEmptyState(th: any): string[] {
		const out: string[] = [];
		out.push("");
		out.push(th.fg("dim", "  ┌──────────────────────────────────────────────────┐"));
		out.push(th.fg("dim", "  │  (no providers found)                            │"));
		out.push(th.fg("dim", "  │                                                  │"));
		out.push(th.fg("dim", "  │  Press ") + th.fg("accent", "n") + th.fg("dim", " to add the first provider.            │"));
		out.push(th.fg("dim", "  │  Or check ~/.pi/agent/models.json.               │"));
		out.push(th.fg("dim", "  └──────────────────────────────────────────────────┘"));
		return out;
	}

	private renderProviderColumn(width: number, th: any): string[] {
		const lines: string[] = [];
		const totalModels = this.providers.reduce((s, p) => s + p.models.length, 0);
		const authed = Array.from(this.auth.values()).filter(a => a?.hasKey).length;
		const stats = ` ${this.providers.length}·${authed}✓ ${totalModels}m `;
		// ▸ 之前硬编码在 headText 里，inactive 时 trimStart() 不能去掉它（不是空白），导致头部 2 空格+▸ 与下面
		// 非 cursor 行的 2 空格+内容 错 1 个字符。现在按 pane 动态生成。
		const headActive = this.pane === "provider";
		const headPrefix = headActive ? "▸ " : "  ";
		const headBase = "Providers";
		// 先按 plain 文本 truncate，再 th.fg 整行包色（同 model 列）
		const headPlain = truncateToWidth(headPrefix + headBase + stats, width);
		const head = (headActive ? th.fg("accent", th.bold(headPlain)) : th.fg("muted", th.bold(headPlain)));
		lines.push(head);
		// 下划线长度 = head 实际可见宽度
		lines.push(th.fg("borderMuted", "─".repeat(Math.min(width, headPrefix.length + headBase.length + stats.length))));
		this.providers.forEach((p, i) => {
			const sel = i === this.providerIndex;
			const isActivePane = sel && this.pane === "provider";
			const arrow = isActivePane ? th.fg("accent", "▸ ") : "  ";
			const nameTh = sel ? th.bold(p.id) : p.id;
			// 认证状态图标：✓ (有 key) / ✗ (无 key) / 空格 (无 status)
			const auth = this.auth.get(p.id);
			let authIcon = "  ";
			if (auth) authIcon = auth.hasKey ? th.fg("success", "✓ ") : th.fg("error", "✗ ");
			// model 数量
			const cnt = th.fg("dim", ` ${p.models.length}m`);
			// 0 model 提示
			const warn = p.models.length === 0 ? th.fg("warning", " ⚠") : "";
			const line = arrow + nameTh + authIcon + cnt + warn;
			lines.push(visiblePad(line, width));
		});
		return lines;
	}

	private renderModelColumn(width: number, th: any): string[] {
		const lines: string[] = [];
		const provider = this.providers[this.providerIndex];
		const models = provider?.models ?? [];
		const rCount = models.filter(m => m.reasoning).length;
		const iCount = models.filter(m => m.input.includes("image")).length;
		const stats = models.length > 0 ? ` ${models.length}m · ${rCount}R · ${iCount}I ` : " 0m ";
		// ▸ 由 pane 决定，不在 headPlain 里。同 provider 列。
		const isHeadActive = this.pane === "model" && !!provider;
		const headPrefix = isHeadActive ? "▸ " : "  ";
		const headBase = provider ? `Models (${provider.id})` : "Models";
		// 先按 plain 文本 truncate（避免 ANSI 字符撑爆宽度），最后整行包色
		const headPlain = truncateToWidth(headPrefix + headBase + stats, width);
		const headColored = isHeadActive ? th.fg("accent", th.bold(headPlain)) : th.fg("muted", th.bold(headPlain));
		lines.push(headColored);
		// 下划线长度 = head 可见宽度
		lines.push(th.fg("borderMuted", "─".repeat(Math.min(width, headPrefix.length + headBase.length + stats.length))));

		if (models.length === 0) {
			lines.push(th.fg("dim", "  (no models)"));
			lines.push(th.fg("dim", "  Press ") + th.fg("accent", "y") + th.fg("dim", " to sync from remote"));
			return lines;
		}
		models.forEach((m, i) => {
			const sel = i === this.modelIndex;
			const isActivePane = sel && this.pane === "model";
			// 全 plain text，末尾才 th.fg 整行包色（避免 ANSI 被 truncateToWidth 计入宽度）
			const arrow = isActivePane ? "▸ " : "  ";
			const rFlag = m.reasoning ? "R" : "-";
			const iFlag = m.input.includes("image") ? "I" : "-";
			const flagStr = ` [${rFlag}${iFlag}]`;
			const ctx2 = m.contextWindow ? ` ${formatNum(m.contextWindow)}c` : "";
			const max2 = m.maxTokens ? ` ${formatNum(m.maxTokens)}m` : "";
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
			const auth = this.auth.get(p.id);
			const authIcon = auth
				? (auth.hasKey ? th.fg("success", "✓ ") : th.fg("error", "✗ "))
				: th.fg("dim", "  ");
			// 大标题
			lines.push(th.fg("accent", th.bold(`  ${authIcon} Provider: `)) + th.bold(p.id));
			lines.push("");
			// Identity
			lines.push(th.fg("muted", "  Identity"));
			lines.push(`    displayName:   ${p.displayName || th.fg("dim", "(unset)")}`);
			lines.push(`    source:        models.json (custom)`);
			lines.push(`    models:        ${p.models.length}`);
			// raw config
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
					// 自检：仅描述 models.json 里 apiKey 字段状态（不是 pi 的认证是否有效；那是 t/T 测的）
					const statusText = auth.hasKey ? "set" : "empty";
					const statusColor = auth.hasKey ? th.fg("success", "✓ set") : th.fg("warning", "✗ empty");
					lines.push(`    apiKey status: ${statusColor}${auth.source && auth.source !== "empty" ? th.fg("dim", " (" + auth.source + ")") : ""}`);
				}
			}
		} else {
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
			// thinking level map：单行显示 enabled 的 level 名字（`low, medium, max`）。无任何 enabled 时跳过
			// 详情面板真值来自 m.thinkingLevelMap（buildProviders 已从 ModelConfig 透传）
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
			// cost
			const cost = m.cost;
			if (cost) {
				lines.push("");
				lines.push(th.fg("muted", "  Cost"));
				lines.push(`    input:        $${cost.input}/M`);
				lines.push(`    output:       $${cost.output}/M`);
				if (cost.cacheRead) lines.push(`    cache read:   $${cost.cacheRead}/M`);
				if (cost.cacheWrite) lines.push(`    cache write:  $${cost.cacheWrite}/M`);
			}
			// compat：Zhipu GLM 等 OpenAI-compat 网关拒收 role:"developer"（会返 422）。为 false 时 pi 用 system role。
			const compat = m.compat;
			if (compat && typeof compat === "object") {
				lines.push("");
				lines.push(th.fg("muted", "  Compat"));
				if (typeof (compat as any).supportsDeveloperRole === "boolean") {
					const sdr = (compat as any).supportsDeveloperRole;
					lines.push(`    supportsDeveloperRole: ${sdr ? th.fg("success", "yes") : th.fg("warning", "no")}`);
				}
			}
		}
		return lines.map((l) => truncateToWidth(l, width));
	}

	private renderHelp(width: number, th: any): string[] {
		const lines: string[] = [
			th.fg("accent", "Key bindings"),
			"  ↑/↓ or j/k    navigate in current pane",
			"  g / G          jump to top / bottom",
			"  ← / →          switch between Providers and Models pane",
			"  Enter          edit selected provider / model",
			"  d              delete (with confirm)",
			"  y              sync — fetch remote models for selected provider",
			"  ?              toggle this help",
			"  q / Esc        close dashboard",
		];
		// 按面板增补特有项
		if (this.pane === "provider") {
			lines.splice(5, 0, "  n              new provider (models are added via sync)");
		} else {
			lines.splice(5, 0, "  t / T          test current model / test all in provider");
		}
		lines.push("", th.fg("dim", " y sync"));
		return lines.map((l) => truncateToWidth(l, width));
	}
}

function formatNum(n: number): string {
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + "M";
	if (n >= 1_000) return (n / 1_000).toFixed(0) + "k";
	return String(n);
}

/**
 * 检查 models.json 里 provider.apiKey 的状态。
 * 返回 { hasKey, source }：source 标识 key 的来源类型。
 *   - "models_json_key"   明文 API key
 *   - "models_json_env"    $ENV_VAR 或 ${ENV_VAR} 插值
 *   - "models.json_command" !shell-command 动态取 key
 *   - "empty"             未设
 */
function inspectApiKey(apiKey: unknown): { hasKey: boolean; source?: string } {
	if (typeof apiKey !== "string" || apiKey.length === 0) {
		return { hasKey: false, source: "empty" };
	}
	// !command 动态取 key
	if (apiKey.startsWith("!")) {
		return { hasKey: true, source: "models.json_command" };
	}
	// $ENV 或 ${ENV}
	if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(apiKey)) {
		return { hasKey: true, source: "models.json_env" };
	}
	return { hasKey: true, source: "models_json_key" };
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
