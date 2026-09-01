/**
 * components.ts — 可复用的 TUI 组件
 *
 * 纯字符串渲染（仿 ui.ts 的 Dashboard 风格），零外部 pi-tui 依赖。
 * 所有组件用 ctx.ui.custom((_tui, theme, _kb, done) => component) 接入。
 */

// ============================================================================
// Key 匹配工具
// ============================================================================

export function matchesKey(data: string, key: string): boolean {
	const k = key.toLowerCase();
	if (k.startsWith("ctrl+")) {
		const ch = k.slice(5);
		return data === `\x1b${ch}` || (ch.length === 1 && data === ch && data.charCodeAt(0) < 32);
	}
	switch (k) {
		case "escape": return data === "\x1b" || data === "\x1b\x1b";
		case "enter":
		case "return": return data === "\r" || data === "\n";
		case "tab": return data === "\t";  // \x1b[Z = Shift+Tab，走 shift+tab
		case "backspace": return data === "\x7f" || data === "\b";
		case "shift+tab": return data === "\x1b[Z" || data === "\x1b[10;5~";
		case "up": return data === "\x1b[A" || data === "\x1bOA";
		case "down": return data === "\x1b[B" || data === "\x1bOB";
		case "left": return data === "\x1b[D" || data === "\x1bOD";
		case "right": return data === "\x1b[C" || data === "\x1bOC";
		case "home": return data === "\x1b[H" || data === "\x1bOH";
		case "end": return data === "\x1b[F" || data === "\x1bOF";
		case "pageup": return data === "\x1b[5~";
		case "pagedown": return data === "\x1b[6~";
	}
	if (k.length === 1) return data === k;
	return false;
}

// ============================================================================
// ModelChecklist — 多选 checklist（sync 用）
// ============================================================================

export type ChecklistItem = {
	id: string;
	label?: string;     // 副标题/备注
	disabled?: boolean;  // true = 显示但不让选
};

/** 视口默认行数（不含 header / summary / search / footer / scroll indicator）。8 和 pi 的 /models 一致。
 *  在 provider-manager.json#syncViewportSize 可调（5-200）。 */
export const CHECKLIST_DEFAULT_MAX_ROWS = 8;
/** syncViewportSize 越界后由这个补齐 */
export const CHECKLIST_MIN_MAX_ROWS = 5;
export const CHECKLIST_MAX_MAX_ROWS = 200;

export class ModelChecklist {
	private items: ChecklistItem[];
	private selected: Set<string>;
	private cursor = 0;
	private top = 0;
	private title: string;
	private theme: any;
	private maxRows: number;
	private onConfirm: (selected: string[]) => void;
	private onCancel: () => void;
	private cachedWidth = -1;
	private cachedLines: string[] = [];
	/** search 输入框的当前内容。同步起作用、可被全打印字符 / Backspace 修改。 */
	private query = "";

	constructor(opts: {
		title: string;
		items: ChecklistItem[];
		theme: any;
		preSelect?: (item: ChecklistItem) => boolean;  // 默认全选时筛掉不想要的
		maxRows?: number;
		onConfirm: (selected: string[]) => void;
		onCancel: () => void;
	}) {
		this.title = opts.title;
		this.items = opts.items;
		this.theme = opts.theme;
		const m = opts.maxRows ?? CHECKLIST_DEFAULT_MAX_ROWS;
		this.maxRows = Math.max(CHECKLIST_MIN_MAX_ROWS, Math.min(CHECKLIST_MAX_MAX_ROWS, m));
		this.onConfirm = opts.onConfirm;
		this.onCancel = opts.onCancel;
		this.selected = new Set();
		for (const it of opts.items) {
			if (it.disabled) continue;
			if (opts.preSelect && !opts.preSelect(it)) continue;
			this.selected.add(it.id);
		}
	}

	/** query 作用后的可见项列表。空 query ＝全量；disabled 始终隐藏。 */
	private visibleItems(): ChecklistItem[] {
		if (!this.query) return this.items;
		const q = this.query.toLowerCase();
		return this.items.filter((it) => {
			if (it.disabled) return false;
			const id = (it.id ?? "").toLowerCase();
			const lbl = (it.label ?? "").toLowerCase();
			return id.includes(q) || lbl.includes(q);
		});
	}

	/** 调 top 使 cursor 在视口内。视口高度不含 (top) 钉住额外占的那几行。 */
	private adjustTop(viewportH: number): void {
		if (viewportH <= 0) return;
		if (this.cursor < this.top) this.top = this.cursor;
		if (this.cursor >= this.top + viewportH) this.top = this.cursor - viewportH + 1;
		if (this.top < 0) this.top = 0;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			this.onCancel();
			return;
		}
		if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
			this.onConfirm([...this.selected]);
			return;
		}
		const visible = this.visibleItems();
		if (visible.length === 0) {
			// 空 list 下只认 search / 退出键
			if (matchesKey(data, "backspace")) {
				if (this.query.length > 0) {
					this.query = this.query.slice(0, -1);
					this.cursor = 0;
					this.top = 0;
					this.invalidate();
				}
				return;
			}
			if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) < 127) {
				this.query += data;
				this.cursor = 0;
				this.top = 0;
				this.invalidate();
			}
			return;
		}
		if (data === " ") {
			const it = visible[this.cursor];
			if (it && !it.disabled) {
				if (this.selected.has(it.id)) this.selected.delete(it.id);
				else this.selected.add(it.id);
				this.invalidate();
			}
			return;
		}
		// wrap-around：顶部 ↑ 跳到末项、底部 ↓ 跳回首项（和 pi 的 /models 一致）
		if (matchesKey(data, "down") || data === "j") {
			this.cursor = (this.cursor + 1) % visible.length;
			this.invalidate();
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.cursor = (this.cursor - 1 + visible.length) % visible.length;
			this.invalidate();
			return;
		}
		if (matchesKey(data, "backspace")) {
			// 优先删 search 字；query 空时退化为 no-op（不动 cursor）
			if (this.query.length > 0) {
				this.query = this.query.slice(0, -1);
				// query 变了，重新算 visible 与 cursor
				const v2 = this.visibleItems();
				if (this.cursor >= v2.length) this.cursor = Math.max(0, v2.length - 1);
				this.top = 0;
				this.invalidate();
			}
			return;
		}
		// 其他可打印字符：进 search（不设 a/g/i 等快捷键了 — search-first 约定）
		if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) < 127) {
			this.query += data;
			// query 变了重算
			const v2 = this.visibleItems();
			if (this.cursor >= v2.length) this.cursor = Math.max(0, v2.length - 1);
			this.top = 0;
			this.invalidate();
		}
	}

	invalidate(): void { this.cachedWidth = -1; this.cachedLines = []; }

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines.length > 0) return this.cachedLines;
		const th = this.theme;
		const lines: string[] = [];

		const total = this.items.length;
		const sel = this.selected.size;
		const disabled = this.items.filter((it) => it.disabled).length;
		const visible = this.visibleItems();
		const visCount = visible.length;

		// Header：title + 上划线
		const head = th.fg("accent", th.bold(` ${this.title} `)) + th.fg("borderMuted", "─".repeat(Math.max(0, width - this.title.length - 4)));
		lines.push(head);
		// 顶部 selected / total 状态
		const summary = ` ${sel}/${total} selected${disabled ? ` (${disabled} existing, skipped)` : ""} `;
		lines.push(th.fg("dim", summary));
		// search 输入框（始终显示）
		const queryW = Math.max(0, width - 4);
		const queryShown = this.query.length > queryW ? this.query.slice(0, queryW) : this.query;
		// pi 的 /models 风格："> " 作为 prompt，"|" 是 cursor。query 末尾加 "▏" 作为 placeholder 提示。
		const queryLine = th.fg("accent", " > ") + (this.query ? th.fg("text", queryShown) : th.fg("muted", "▏"));
		lines.push(truncateForRender(queryLine, width));
		lines.push("");

		// 列表区
		// 布局：visible.length > maxRows 时顶部钉住首项 + (top)，多占 2 行。
		// 这样 mid-list 滚动也能看到 “列表起点是谁” 。
		const itemLines: string[] = [];
		let moreBelow: string | null = null;
		if (visCount === 0) {
			itemLines.push(th.fg("dim", this.query
				? `  (no models match "${this.query}")`
				: "  (no models to choose from)"));
		} else {
			const needPinOutside = this.cursor >= this.maxRows;
			// 钉住首项占 1 行。有效视口 = maxRows - 1（未钉住时 = maxRows）
			const effectiveViewport = Math.max(1, this.maxRows - (needPinOutside ? 1 : 0));
			this.adjustTop(effectiveViewport);
			const viewStart = this.top;
			const viewEnd = Math.min(visCount, viewStart + effectiveViewport);

			if (needPinOutside) {
				const first = visible[0];
				const box = first.disabled ? th.fg("dim", "[skip]")
					: this.selected.has(first.id) ? th.fg("success", "[√]")
					: th.fg("dim", "[ ]");
				itemLines.push(truncateForRender(`  ${box} ${first.id}  ${th.fg("dim", "(top)")}`, width));
				// hidden 计数：剩下未在钉住首项 / viewport 中展示的项
				// = total - (1 pinned + viewport) = total - maxRows
				const hiddenTotal = visCount - 1 - (viewEnd - viewStart);
				if (hiddenTotal > 0) {
					itemLines.push(th.fg("dim", `  ⋮ ${hiddenTotal} hidden`));
				}
			}
			for (let i = viewStart; i < viewEnd; i++) {
				const it = visible[i];
				const isCursor = i === this.cursor;
				const arrow = isCursor ? th.fg("accent", "▶ ") : "  ";
				const box = it.disabled ? th.fg("dim", "[skip]")
					: this.selected.has(it.id) ? th.fg("success", "[√]")
					: th.fg("dim", "[ ]");
				const id = isCursor ? th.bold(it.id) : it.id;
				const topLabel = (i === 0 && !needPinOutside) ? th.fg("dim", "  (top)") : "";
				const sub = it.label ? "  " + th.fg("muted", it.label) : "";
				itemLines.push(truncateForRender(`${arrow}${box} ${id}${topLabel}${sub}`, width));
			}
			if (viewEnd < visCount) {
				const nextId = visible[viewEnd]?.id ?? "";
				moreBelow = `  ⋮ ${visCount - viewEnd} more below (${nextId} …)`;
			}
		}

		// items 先
		for (const l of itemLines) lines.push(l);
		if (moreBelow) lines.push(moreBelow);

		// 位置指示：i / visCount，与 pi 的 /models 一致
		// 注意：query 为空时 visCount = total，仍能告知总长度；query 非空时为过滤后位置
		if (visCount > 0) {
			lines.push(th.fg("muted", `  (${this.cursor + 1}/${visCount})`));
		}

		// chrome 置底
		lines.push("");
		lines.push(th.fg("borderMuted", "─".repeat(width)));
		// 底部提示词：search 始终是首选，所以 a/i/g/G 不再是快捷键。
		lines.push(th.fg("dim", " type to filter · Space toggle · ↑↓/jk nav (wrap) · Backspace del · Enter apply · Esc cancel"));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

/** 给 render 用的截断。计算宽度时跳过 ANSI 转义序列 + 已知主题标签，避免裁到一半丢颜色。 */
function truncateForRender(s: string, width: number): string {
	if (width <= 0) return "";
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
	let w = 0;
	let out = "";
	let i = 0;
	while (i < s.length) {
		// ANSI 转义序列：\x1b[ ... m（零宽）
		if (s[i] === "\x1b" && i + 1 < s.length && s[i + 1] === "[") {
			const close = s.indexOf("m", i + 2);
			if (close !== -1) {
				out += s.slice(i, close + 1);
				i = close + 1;
				continue;
			}
			// 其他 CSI 序列：结尾是某个字母
			const tail = s.slice(i + 2).search(/[A-Za-z]/);
			if (tail !== -1) {
				out += s.slice(i, i + 2 + tail + 1);
				i = i + 2 + tail + 1;
				continue;
			}
		}
		// 旧主题标签 [tag] / [/tag]：仅白名单内的零宽
		if (s[i] === "[") {
			const close = s.indexOf("]", i + 1);
			if (close !== -1) {
				const inner = s.slice(i + 1, close);
				if (KNOWN_THEME_TAGS.has(inner) || (inner.startsWith("/") && KNOWN_THEME_TAGS.has(inner.slice(1)))) {
					out += s.slice(i, close + 1);
					i = close + 1;
					continue;
				}
			}
		}
		const ch = s[i]!;
		const cw = isWideChar(ch) ? 2 : 1;
		if (w + cw > width) return out + (w + 1 <= width ? "…" : "");
		out += ch;
		w += cw;
		i++;
	}
	return out;
}

function isWideChar(ch: string): boolean {
	const code = ch.codePointAt(0) ?? 0;
	return code > 0x1100 && (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0x9fff) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6)
	);
}

// ============================================================================
// FormEditor — 通用 TUI 单页表单编辑器
// ============================================================================

export type FormFieldType = "text" | "secret" | "select" | "number" | "readonly" | "json" | "levelmap" | "multiselect";

/** pi 的 thinking level 列表。levelmap 字段的勾选/取消就按这个顺序。 */
export const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type FormField = {
	key: string;
	label: string;
	type: FormFieldType;
	options?: string[];         // for select
	placeholder?: string;
	hint?: string;              // 显示在 value 后面的小提示
	validate?: (value: unknown) => string | null;  // 返回错误信息
	render?: (value: unknown) => string;  // 自定义显示（覆盖默认）
};

export class FormEditor<T extends Record<string, unknown>> {
	private fields: FormField[];
	private values: T;
	private original: T;
	private draft = "";
	private draftIsOriginal = true;  // draft == currentValue，未编辑过
	private cursor = 0;
	private levelmapCursor = 0;  // levelmap 字段内的 row 位置（0-6）
	private selectCursor = 0;  // select 字段内的 options 位置
	private multiselectCursor = 0;  // multiselect 字段内的 options 位置
	private editing = false;  // 当前非输入字段是否在 edit 模式（Enter 进入、Enter/Space 退出）
	private error: string | null = null;
	private theme: any;
	private title: string;
	private onSave: (values: T) => void;
	private onCancel: () => void;
	private cachedWidth = -1;
	private cachedLines: string[] = [];

	constructor(opts: {
		title: string;
		fields: FormField[];
		initial: T;
		theme: any;
		onSave: (values: T) => void;
		onCancel: () => void;
	}) {
		this.title = opts.title;
		this.fields = opts.fields;
		this.values = JSON.parse(JSON.stringify(opts.initial)) as T;
		this.original = JSON.parse(JSON.stringify(opts.initial)) as T;
		this.theme = opts.theme;
		this.onSave = opts.onSave;
		this.onCancel = opts.onCancel;
		this.draft = this.currentValueAsString();
		this.draftIsOriginal = true;
	}

	private currentValueAsString(): string {
		const f = this.fields[this.cursor];
		const v = this.values[f.key];
		if (v === undefined || v === null) return "";
		if (f.type === "secret") return v ? "••••" + String(v).slice(-2) : "";
		if (f.type === "json") return v === null ? "" : JSON.stringify(v);
		if (f.type === "levelmap") {
			const m = (v && typeof v === "object") ? v as Record<string, string | null> : {};
			const enabled = PI_LEVELS.filter((l) => m[l] != null);
			return enabled.length ? enabled.join(", ") : "(none)";
		}
		if (f.type === "multiselect") {
			const arr = Array.isArray(v) ? v as string[] : [];
			return arr.length ? arr.join(", ") : "(none)";
		}
		return String(v);
	}

	private commitDraft(): { ok: boolean } {
		const f = this.fields[this.cursor];
		if (f.type === "readonly") return { ok: true };
		if (f.type === "levelmap") {
			// 保证 7 个 level 都写进 values：勾选的写 level 名，未勾选的写 null（避岀 cycle）
			const cur = ((this.values as any)[f.key] ?? {}) as Record<string, string | null>;
			const normalized: Record<string, string | null> = {};
			for (const lv of PI_LEVELS) {
				const v = cur[lv];
				normalized[lv] = v === undefined ? null : v;
			}
			(this.values as any)[f.key] = normalized;
			return { ok: true };
		}
		if (f.type === "multiselect") return { ok: true };  // 直接操作 values，不需 draft
		const raw = this.draft;
		if (f.type === "number") {
			// 严格校验：draft 必须全数字（或空 → 走默认值 0）
			if (!/^\d+$/.test(raw)) { this.error = `${f.label}: must be a non-negative integer`; return { ok: false }; }
			const n = parseInt(raw, 10);
			if (f.validate) {
				const err = f.validate(n);
				if (err) { this.error = `${f.label}: ${err}`; return { ok: false }; }
			}
			(this.values as any)[f.key] = n;
		} else if (f.type === "json") {
			try {
				const parsed = raw.trim() ? JSON.parse(raw) : null;
				if (f.validate) {
					const err = f.validate(parsed);
					if (err) { this.error = `${f.label}: ${err}`; return { ok: false }; }
				}
				(this.values as any)[f.key] = parsed;
			} catch (err) {
				this.error = `${f.label}: invalid JSON (${err instanceof Error ? err.message : err})`;
				return { ok: false };
			}
		} else if (f.type === "select") {
			if (raw && !f.options?.includes(raw)) {
				// 宽松容错：true/yes → options 中的"yes"；false/no → "no"；其它字符串报错
				if (raw === "true" || raw === "yes") { (this.values as any)[f.key] = (f.options ?? []).find((o) => o === "yes") ?? raw; }
				else if (raw === "false" || raw === "no") { (this.values as any)[f.key] = (f.options ?? []).find((o) => o === "no") ?? raw; }
				else { this.error = `${f.label}: must be one of ${(f.options ?? []).join(", ")}`; return { ok: false }; }
			} else if (raw) { (this.values as any)[f.key] = raw; }
			if (f.validate) { const err = f.validate(raw); if (err) { this.error = `${f.label}: ${err}`; return { ok: false }; } }
		} else {  // text, secret
			if (f.validate) { const err = f.validate(raw); if (err) { this.error = `${f.label}: ${err}`; return { ok: false }; } }
			// secret: 避免覆写原值。draft 是 masked display ("••••Xn")，如果用户没改（draftIsOriginal=true），
			// 切 field / Enter 退出 edit 都会调 commitDraft，不跳这会写回 masked 字符串覆盖真 key。
			if (f.type === "secret" && this.draftIsOriginal) {
				// no-op，保持 values[f.key] 原值
			} else {
				(this.values as any)[f.key] = raw;
			}
		}
		this.error = null;
		return { ok: true };
	}

	private move(delta: number): void {
		const result = this.commitDraft();
		this.cursor = (this.cursor + delta + this.fields.length) % this.fields.length;
		// levelmap/select 字段专用的 sub-cursor：进入/离开都重置
		// levelmap 始终 0；select 设为当前 value 在 options 里的 index（找不到则 0）
		this.levelmapCursor = 0;
		const f = this.fields[this.cursor];
		if (f?.type === "select" && f.options) {
			const cur = this.values[f.key] as string | undefined;
			const idx = cur ? f.options.indexOf(cur) : -1;
			this.selectCursor = idx >= 0 ? idx : 0;
		} else {
			this.selectCursor = 0;
		}
		this.draft = this.currentValueAsString();
		this.draftIsOriginal = true;
		// 仅在 commit 成功时清 error；失败时保留让用户看到
		if (result.ok) this.error = null;
		this.invalidate();
	}

	/** levelmap 字段：切换当前 row 的 enable/disable。enable 用 level 名做 value，disable 写 null（避免该 level 进入 cycle）。 */
	private toggleLevelmapRow(key: string): void {
		const level = PI_LEVELS[this.levelmapCursor];
		const cur = ((this.values as any)[key] ?? {}) as Record<string, string | null>;
		const next: Record<string, string | null> = { ...cur };
		// 保证所有 7 个 level 都有 key（未勾选的全部以 null 补上，进不了 cycle）
		for (const lv of PI_LEVELS) {
			if (next[lv] === undefined) next[lv] = null;
		}
		if (cur[level]) next[level] = null;        // 当前 enabled → 写 null（退出 cycle）
		else next[level] = level;                 // 当前 disabled → enable，value = level 名
		(this.values as any)[key] = next;
		this.draftIsOriginal = false;
		this.invalidate();
	}

	handleInput(data: string): void {
		const f0 = this.fields[this.cursor];
		const isNonInput = f0?.type === "select" || f0?.type === "levelmap" || f0?.type === "multiselect";
		const isTypeable = f0 && (f0.type === "text" || f0.type === "secret" || f0.type === "number" || f0.type === "json");
		const isReadonly = f0?.type === "readonly";

		// 统一模型：所有字段都遵 view / edit 两态。
		//   view（editing=false，默认）：只响应 Enter（进 edit）、↑↓/j/k（切字段）、s（保存）、Esc/q（取消）
		//   edit（editing=true）：可修改（typeable 输字符 / non-typeable 按 Space/↑↓）、Enter（提交+退出）、Esc（退出）、↑↓（提交+切字段）

		// 1. Esc / q → edit 中退出（commit）；view 模式取消整个 form
		if (matchesKey(data, "escape") || data === "q") {
			if (this.editing) {
				this.commitDraft();
				this.editing = false;
				this.invalidate();
				return;
			}
			this.onCancel();
			return;
		}

		// 2. s → 保存整个 form（仅在 view 模式；edit 模式下 s 是字符 / no-op）
		if (data === "s" && !this.editing) {
			const result = this.commitDraft();
			if (!result.ok) { this.invalidate(); return; }
			this.onSave(this.values);
			return;
		}

		// 3. Enter → toggle edit（readonly 不响应）
		//   view: 进 edit（所有 typeable / non-typeable）
		//   edit: commit + 退出 edit（不走下一字段，留在原字段；用户用 ↑↓ 切）
		if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
			if (isReadonly) return;
			if (this.editing) {
				this.commitDraft();
				this.editing = false;
				this.invalidate();
				return;
			}
			// 进 edit。secret field：draft = 原值（不是 masked 显示），用户可看/可改真 key；
			// commitDraft 会配合 draftIsOriginal 避免覆写未改的原值。
			if (f0?.type === "secret") {
				const orig = (this.values as any)[f0.key];
				this.draft = (orig === undefined || orig === null) ? "" : String(orig);
				this.draftIsOriginal = true;
			}
			this.editing = true;
			this.invalidate();
			return;
		}

		// 4. ↑↓：
		//   view / edit + typeable：切字段（edit 模式下 commit + 退 edit）
		//   edit + non-typeable：在 step 7 处理（options 内 nav）
		if (matchesKey(data, "down") || matchesKey(data, "up")) {
			if (!(this.editing && isNonInput)) {
				this.commitDraft();
				this.move(matchesKey(data, "up") ? -1 : 1);
				this.editing = false;
				return;
			}
		}

		// 5. j/k：
		//   view：切字段
		//   edit + typeable：字符（下面 printable 处理）
		//   edit + non-typeable：options 内 nav（在 step 7 处理）
		if ((data === "j" || data === "k") && !this.editing) {
			this.move(data === "j" ? 1 : -1);
			return;
		}

		// 6. Space：view + non-typeable 快捷进 edit（与 Enter 等价）
		if (data === " " && isNonInput && !this.editing) {
			this.editing = true;
			this.invalidate();
			return;
		}

		// 7. edit + non-typeable：↑↓/j/k 在 options 内移动，Space pick
		if (this.editing && isNonInput) {
			if (f0!.type === "levelmap") {
				if (matchesKey(data, "down") || data === "j") {
					if (this.levelmapCursor < 6) { this.levelmapCursor++; this.invalidate(); }
					return;
				}
				if (matchesKey(data, "up") || data === "k") {
					if (this.levelmapCursor > 0) { this.levelmapCursor--; this.invalidate(); }
					return;
				}
				if (data === " ") {
					this.toggleLevelmapRow(f0!.key);
					return;
				}
				return;  // edit 模式下其他键不响应
			}
			if (f0!.type === "select" && f0!.options) {
				if (matchesKey(data, "down") || data === "j") {
					this.selectCursor = Math.min(this.selectCursor + 1, f0!.options.length - 1);
					this.invalidate();
					return;
				}
				if (matchesKey(data, "up") || data === "k") {
					this.selectCursor = Math.max(this.selectCursor - 1, 0);
					this.invalidate();
					return;
				}
				if (data === " ") {
					(this.values as any)[f0!.key] = f0!.options[this.selectCursor];
					this.draft = f0!.options[this.selectCursor];
					this.draftIsOriginal = true;
					this.invalidate();
					return;
				}
				return;  // edit 模式下其他键不响应
			}
			// multiselect 字段：↑↓/j/k 选 option，Space toggle（在值里加/去）
			if (f0!.type === "multiselect" && f0!.options) {
				const opts = f0!.options;
				if (matchesKey(data, "down") || data === "j") {
					this.multiselectCursor = Math.min(this.multiselectCursor + 1, opts.length - 1);
					this.invalidate();
					return;
				}
				if (matchesKey(data, "up") || data === "k") {
					this.multiselectCursor = Math.max(this.multiselectCursor - 1, 0);
					this.invalidate();
					return;
				}
				if (data === " ") {
					const opt = opts[this.multiselectCursor];
					const cur = (this.values[f0!.key] && Array.isArray(this.values[f0!.key])) ? this.values[f0!.key] as string[] : [];
					const idx = cur.indexOf(opt);
					const next = idx >= 0 ? cur.filter((_, i) => i !== idx) : [...cur, opt];
					(this.values as any)[f0!.key] = next;
					this.draftIsOriginal = false;
					this.invalidate();
					return;
				}
				return;
			}
		}

		// 8. readonly：后续输入不响应
		if (isReadonly) return;

		// 9. view 模式：不接受任何字符输入（需先 Enter 进 edit）
		if (!this.editing) return;

		// 10. Backspace：仅在 edit + typeable 删除 draft
		if (matchesKey(data, "backspace")) {
			if (!isTypeable) return;
			if (this.draft.length > 0) this.draft = this.draft.slice(0, -1);
			this.draftIsOriginal = false;
			this.invalidate();
			return;
		}

		// 11. 可打印字符：仅在 edit + typeable 追加 draft
		if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) < 127) {
			if (!isTypeable) return;
			// number 字段：第一个数字替换（避免 100 + "2" = 1002），后续 append
			if (f0?.type === "number" && /^\d$/.test(data) && this.draftIsOriginal) {
				this.draft = data;
			} else {
				this.draft += data;
			}
			this.draftIsOriginal = false;
			this.invalidate();
			return;
		}
	}

	invalidate(): void { this.cachedWidth = -1; this.cachedLines = []; }

	private formatValue(f: FormField, v: unknown): string {
		if (f.render) return f.render(v);
		if (v === undefined || v === null) return "";
		if (f.type === "secret") return v ? "••••" + String(v).slice(-2) : "";
		if (f.type === "json") return v === null ? "" : JSON.stringify(v);
		if (f.type === "levelmap") {
			const m = (v && typeof v === "object") ? v as Record<string, string | null> : {};
			const enabled = PI_LEVELS.filter((l) => m[l] != null);
			return enabled.length ? enabled.join(", ") : "(none)";
		}
		if (f.type === "multiselect") {
			const arr = Array.isArray(v) ? v as string[] : [];
			return arr.length ? arr.join(", ") : "(none)";
		}
		return String(v);
	}

	/** 渲染 select 字段：active 时展开所有 options（cursor 行高亮），非 active 时显示当前值 */
	private renderSelect(f: FormField, isActive: boolean, _labelW: number, width: number): string[] {
		const th = this.theme;
		const out: string[] = [];
		const opts = f.options ?? [];
		const cur = this.values[f.key] as string | undefined;
		const label = (f.label + ":").padEnd(_labelW + 2);
		if (!isActive || (isActive && !this.editing)) {
			const valueStr = cur ? th.fg("text", cur) : th.fg("muted", "(unset)");
			const prefix = isActive ? th.fg("accent", "▸ ") : "  ";
			out.push(truncateForRender(prefix + th.bold(label) + valueStr, width));
			return out;
		}
		// active 且 editing：label 行（带 [● edit]）+ options 列表
		const editMarker = th.fg("accent", " [● edit]");
		out.push(truncateForRender(th.fg("accent", "▸ ") + th.bold(label) + editMarker, width));
		for (let i = 0; i < opts.length; i++) {
			const isCursor = i === this.selectCursor;
			const isCurrent = opts[i] === cur;
			const arrow = isCursor ? th.fg("accent", "→ ") : "  ";
			const box = isCurrent ? th.fg("success", "[√]") : th.fg("dim", "[ ]");
			const optStr = isCurrent ? th.fg("text", opts[i]) : (isCursor ? th.bold(opts[i]) : th.fg("muted", opts[i]));
			out.push(truncateForRender("  " + arrow + box + " " + optStr, width));
		}
		return out;
	}

	/** 渲染 multiselect 字段：active 且 editing=true 时展开所有 options（[√/] 标记已选项 + [● edit]），active 但未 editing 时显示单行，non-active 时显示单行 */
	private renderMultiselect(f: FormField, isActive: boolean, label: string, _labelW: number, width: number): string[] {
		const th = this.theme;
		const out: string[] = [];
		const opts = f.options ?? [];
		const cur = (this.values[f.key] && Array.isArray(this.values[f.key])) ? this.values[f.key] as string[] : [];
		if (!isActive || (isActive && !this.editing)) {
			const valueStr = cur.length ? th.fg("text", cur.join(", ")) : th.fg("muted", "(none)");
			const prefix = isActive ? th.fg("accent", "▸ ") : "  ";
			out.push(truncateForRender(prefix + th.bold(label) + valueStr, width));
			return out;
		}
		// active 且 editing：label 行（带 [● edit]）+ options 列表
		const editMarker = th.fg("accent", " [● edit]");
		out.push(truncateForRender(th.fg("accent", "▸ ") + th.bold(label) + editMarker, width));
		for (let i = 0; i < opts.length; i++) {
			const opt = opts[i];
			const isCurrent = cur.indexOf(opt) >= 0;
			const isCursor = i === this.multiselectCursor;
			const arrow = isCursor ? th.fg("accent", "→ ") : "  ";
			const box = isCurrent ? th.fg("success", "[√]") : th.fg("dim", "[ ]");
			const optStr = isCurrent ? th.fg("text", opt) : (isCursor ? th.bold(opt) : th.fg("muted", opt));
			out.push(truncateForRender("  " + arrow + box + " " + optStr, width));
		}
		return out;
	}
	/** 渲染 levelmap 字段：active 时展开 7 行（首行带 label），非 active 时显示当前 enabled 的 level 列表 */
	private renderLevelmap(f: FormField, isActive: boolean, label: string, _labelW: number, width: number): string[] {
		const th = this.theme;
		const out: string[] = [];
		const cur = ((this.values[f.key] ?? {}) as Record<string, string | null>);
		if (!isActive || (isActive && !this.editing)) {
			// 非 active / active 未 edit：单行显示
			const enabled = PI_LEVELS.filter((l) => cur[l] != null);
			const valueStr = enabled.length ? th.fg("text", enabled.join(", ")) : th.fg("muted", "(none)");
			const prefix = isActive ? th.fg("accent", "▸ ") : "  ";
			const line = prefix + th.bold(label) + valueStr;
			out.push(truncateForRender(line, width));
			return out;
		}
		// active 且 editing：label 行（带 [● edit]）+ 7 行 level
		const editMarker = th.fg("accent", " [● edit]");
		out.push(truncateForRender(th.fg("accent", "▸ ") + th.bold(label) + editMarker, width));
		for (let i = 0; i < PI_LEVELS.length; i++) {
			const level = PI_LEVELS[i];
			const isOn = cur[level] != null;
			const box = isOn ? th.fg("success", "[√]") : th.fg("dim", "[ ]");
			const isCursor = i === this.levelmapCursor;
			const arrow = isCursor ? th.fg("accent", "→ ") : "  ";
			const levelStr = isOn ? th.fg("text", level) : (isCursor ? th.bold(level) : th.fg("dim", level));
			const line = "  " + arrow + box + " " + levelStr;
			out.push(truncateForRender(line, width));
		}
		return out;
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines.length > 0) return this.cachedLines;
		const th = this.theme;
		const lines: string[] = [];

		lines.push(th.fg("accent", th.bold(` ${this.title} `)) + th.fg("borderMuted", "─".repeat(Math.max(0, width - this.title.length - 4))));
		if (this.error) lines.push(th.fg("error", ` ⚠ ${this.error}`));
		lines.push("");

		const labelW = Math.max(...this.fields.map((x) => x.label.length));
		for (let i = 0; i < this.fields.length; i++) {
			const f = this.fields[i];
			const isActive = i === this.cursor;
			// levelmap 字段：active 时展开 7 行；其他字段同原来
			if (f.type === "levelmap") {
				const label = (f.label + ":").padEnd(labelW + 2);
				const linesForLevelmap = this.renderLevelmap(f, isActive, label, labelW, width);
				for (const ln of linesForLevelmap) lines.push(ln);
				continue;
			}
			if (f.type === "select" && f.options) {
				const linesForSelect = this.renderSelect(f, isActive, labelW, width);
				for (const ln of linesForSelect) lines.push(ln);
				continue;
			}
			if (f.type === "multiselect" && f.options) {
				const label = (f.label + ":").padEnd(labelW + 2);
				const linesForMulti = this.renderMultiselect(f, isActive, label, labelW, width);
				for (const ln of linesForMulti) lines.push(ln);
				continue;
			}
			const raw = isActive ? this.draft : this.formatValue(f, this.values[f.key]);
			const isEmpty = !raw;
			const label = (f.label + ":").padEnd(labelW + 2);
			const labelStr = isActive ? th.bold(label) : label;
			let valueStr: string;
			if (f.type === "secret" && !isActive) {
				valueStr = isEmpty ? th.fg("dim", "(empty)") : th.fg("dim", raw);
			} else if (isEmpty) {
				valueStr = th.fg("muted", isActive ? "" : "(empty)");
			} else {
				valueStr = isActive ? raw : th.fg("text", raw);
			}
			const prefix = isActive ? th.fg("accent", "▸ ") : "  ";
			const editMarker = isActive && this.editing ? th.fg("accent", " [● edit]") : "";
			const hint = f.hint ? "  " + th.fg("muted", f.hint) : "";
			const line = prefix + labelStr + valueStr + editMarker + hint;
			lines.push(truncateForRender(line, width));
		}

		lines.push("");
		lines.push(th.fg("borderMuted", "─".repeat(width)));
		const f = this.fields[this.cursor];
		const hints: string[] = ["↑↓ field"];
		if (f?.type === "multiselect") hints.push(this.editing ? "↑↓ option · Space toggle · Enter commit" : "Enter edit · Space toggle");
		else if (f?.type === "select") hints.push(this.editing ? "↑↓ option · Space pick · Enter commit" : "Enter edit · Space pick");
		else if (f?.type === "levelmap") hints.push(this.editing ? "↑↓ level · Space toggle · Enter commit" : "Enter edit · Space toggle");
		else if (f?.type === "readonly") hints.push("readonly");
		else hints.push(this.editing ? "type to edit" : "Enter edit · type");
		hints.push(this.editing && f && (f.type === "text" || f.type === "secret" || f.type === "number" || f.type === "json") ? "Backspace del" : "Backspace");
		hints.push(this.editing ? "Enter commit" : "s save");
		hints.push("Esc cancel");
		lines.push(th.fg("dim", " " + hints.join(" · ")));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}
