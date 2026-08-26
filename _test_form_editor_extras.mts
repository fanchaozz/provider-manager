// FormEditor 扩展测试：backspace、levelmap、multiselect、j/k、循环
// 统一 view/edit 两态模型：view 模式只响应 Enter/↑↓/j/k/s/Esc/q，edit 模式才接受字符
import { FormEditor, PI_LEVELS, matchesKey, type FormField } from "./components.ts";

const ok = (label: string, cond: boolean) => {
	const tag = cond ? "✓" : "✗";
	console.log(`${tag} ${label}`);
	if (!cond) process.exitCode = 1;
};

const theme = {
	fg: (c: string, s: string) => `[${c}]${s}[/${c}]`,
	bold: (s: string) => `*${s}*`,
	bg: () => "",
};

function make<T extends Record<string, unknown>>(fields: FormField[], initial: T) {
	let saved: T | null = null;
	let cancelled = false;
	const comp = new FormEditor({
		title: "t",
		fields,
		initial,
		theme,
		onSave: (v) => { saved = v; },
		onCancel: () => { cancelled = true; },
	});
	return {
		comp,
		send: (d: string) => comp.handleInput(d),
		get: () => saved as T | null,
		isCancelled: () => cancelled,
		getValues: () => (comp as any).values as T,
		getEditing: () => (comp as any).editing as boolean,
	};
}

async function main() {
	console.log("=== backspace：仅 edit + typeable 生效 ===");
	ok("matchesKey '\\x7f' = backspace", matchesKey("\x7f", "backspace"));
	ok("matchesKey '\\b' = backspace", matchesKey("\b", "backspace"));
	{
		const t = make([{ key: "x", label: "x", type: "text" }], { x: "abc" });
		// view 模式：字符 + backspace 都不响应
		t.send("X");
		t.send("Y");
		ok("view 模式 X/Y 不入 draft", (t.comp as any).draft === "abc");
		t.send("\x7f");
		ok("view 模式 backspace 不删", (t.comp as any).draft === "abc");
		// Enter 进 edit
		t.send("\r");
		t.send("X");
		t.send("Y");
		ok("edit 模式 X/Y → draft = abcXY", (t.comp as any).draft === "abcXY");
		t.send("\x7f");
		ok("edit 模式 \\x7f backspace 删 Y", (t.comp as any).draft === "abcX");
		t.send("\b");
		ok("edit 模式 \\b backspace 删 X", (t.comp as any).draft === "abc");
	}

	console.log("\n=== levelmap：默认空 + 渲染 ===");
	{
		const fields: FormField[] = [
			{ key: "tlm", label: "thinkingLevelMap", type: "levelmap" },
		];
		const t = make(fields, { tlm: null });
		ok("initial draft = ''（null）", (t.comp as any).draft === "");
		ok("levelmapCursor = 0", (t.comp as any).levelmapCursor === 0);
		// 未 edit：render 1 行
		const lines0 = t.comp.render(100);
		ok("未 edit 时不含 level 展开", lines0.filter((l) => /off|minimal|low|medium|high|xhigh|max/.test(l)).length === 0);
		ok("未 edit 时 value 显示为 (none)", lines0.some((l) => l.includes("(none)")));
		// Enter 进 edit
		t.send("\r");
		const lines = t.comp.render(100);
		ok("edit render 含 7 个 level 名", PI_LEVELS.every((l) => lines.some((ln) => ln.includes(l))));
		ok("edit render 7 行带 box（√/[ ]）", lines.filter((l) => /\[[\u221a ]\]/.test(l)).length === 7);
	}

	console.log("\n=== levelmap：edit 模式 Space 勾选 + ↑↓/j/k 切行 ===");
	{
		const fields: FormField[] = [
			{ key: "tlm", label: "thinkingLevelMap", type: "levelmap" },
		];
		const t = make(fields, { tlm: null });
		t.send("\r");  // Enter 进 edit
		t.send(" ");  // 勾选 off (row 0)
		ok("Space 后 cursor 仍 0", (t.comp as any).levelmapCursor === 0);
		ok("values.tlm 含 off", (t.comp as any).values.tlm.off === "off");
		t.send("\x1b[B");  // ↓
		ok("↓ 后 cursor 1", (t.comp as any).levelmapCursor === 1);
		t.send(" ");  // 勾选 minimal
		ok("values.tlm 含 minimal", (t.comp as any).values.tlm.minimal === "minimal");
		t.send("j");  // ↓
		ok("j 后 cursor 2", (t.comp as any).levelmapCursor === 2);
		t.send("k");  // ↑
		ok("k 后 cursor 1", (t.comp as any).levelmapCursor === 1);
	}

	console.log("\n=== levelmap：再次 Space 取消勾选 ===");
	{
		const t2 = make([{ key: "tlm", label: "tlm", type: "levelmap" }], { tlm: { low: "low" } });
		t2.send("\r");  // Enter 进 edit
		t2.send("\x1b[B");  // cursor 1 (minimal)
		t2.send("\x1b[B");  // cursor 2 (low)
		ok("cursor 2 在 low", (t2.comp as any).levelmapCursor === 2);
		t2.send(" ");  // 取消 low
		ok("取消后 values.tlm.low = null", (t2.getValues().tlm as any).low === null);
		ok("其它 level 保持（为 null）", (t2.getValues().tlm as any).minimal === null);
	}

	console.log("\n=== levelmap：toggle 后 7 个 level 全部进 values（未勾选 = null）===");
	{
		const t = make([{ key: "tlm", label: "tlm", type: "levelmap" }], { tlm: null });
		ok("初始 tlm = null", t.getValues().tlm === null);
		t.send("\r");
		t.send("\x1b[B");  // minimal
		t.send("\x1b[B");  // low
		t.send(" ");  // 勾 low
		const v = t.getValues().tlm as Record<string, string | null>;
		ok("low 启用", v.low === "low");
		ok("off 被补为 null", v.off === null);
		ok("minimal 被补为 null", v.minimal === null);
		ok("medium 被补为 null", v.medium === null);
		ok("high 被补为 null", v.high === null);
		ok("xhigh 被补为 null", v.xhigh === null);
		ok("max 被补为 null", v.max === null);
		ok("7 个 level 都在", Object.keys(v).length === 7);
		// 再勾一个 max
		t.send("\x1b[B"); t.send("\x1b[B"); t.send("\x1b[B"); t.send("\x1b[B");
		t.send(" ");  // 勾 max
		const v2 = t.getValues().tlm as Record<string, string | null>;
		ok("勾两个: low + max", v2.low === "low" && v2.max === "max");
		ok("其余仍是 null", v2.off === null && v2.minimal === null && v2.medium === null && v2.high === null && v2.xhigh === null);
		// 取消勾选 low
		t.send("\x1b[A"); t.send("\x1b[A"); t.send("\x1b[A"); t.send("\x1b[A");
		t.send(" ");  // 取消 low
		const v3 = t.getValues().tlm as Record<string, string | null>;
		ok("取消勾选 → low 写 null", v3.low === null);
		ok("max 仍启用", v3.max === "max");
	}

	console.log("\n=== levelmap：edit ↑↓ 切行 + Enter 退出 + ↓ 切下一字段 ===");
	{
		const fields: FormField[] = [
			{ key: "tlm", label: "tlm", type: "levelmap" },
			{ key: "next", label: "next", type: "text" },
		];
		const t = make(fields, { tlm: { low: "low" }, next: "" });
		ok("cursor 0（tlm）", (t.comp as any).cursor === 0);
		t.send("\r");  // Enter 进 edit
		t.send(" ");  // off 勾选
		t.send("\x1b[B");  // ↓ → cursor 1 (minimal)
		ok("↓ 0→1", (t.comp as any).levelmapCursor === 1);
		t.send("\x1b[B");  // ↓ → cursor 2 (low)
		ok("↓ 1→2", (t.comp as any).levelmapCursor === 2);
		for (let i = 0; i < 4; i++) t.send("\x1b[B");
		ok("↓ 4 次后 cursor 6（max）", (t.comp as any).levelmapCursor === 6);
		ok("cursor 还在 tlm 字段", (t.comp as any).cursor === 0);
		t.send("\r");  // Enter 退出 edit
		t.send("\x1b[B");  // ↓ → next 字段
		ok("↓ 切 next 字段 → cursor 1", (t.comp as any).cursor === 1);
		ok("切走后 levelmapCursor 重置为 0", (t.comp as any).levelmapCursor === 0);
	}

	console.log("\n=== levelmap：s 键保存 ===");
	{
		const fields: FormField[] = [
			{ key: "tlm", label: "tlm", type: "levelmap" },
		];
		const t = make(fields, { tlm: { off: "off" } });
		t.send("\r");
		t.send(" ");  // 取消 off
		t.send("\x1b[B");
		t.send(" ");  // 勾 minimal
		t.send("\r");  // Enter 退出 edit
		t.send("s");  // s 保存
		ok("s 触发", t.get() !== null);
		ok("saved tlm.off 不存在", !(t.get()!.tlm as any).off);
		ok("saved tlm.minimal = minimal", (t.get()!.tlm as any).minimal === "minimal");
	}

	console.log("\n=== levelmap：formatValue 非 active 时 ===");
	{
		const fields: FormField[] = [
			{ key: "a", label: "a", type: "text" },
			{ key: "tlm", label: "tlm", type: "levelmap" },
		];
		const t = make(fields, { a: "x", tlm: { off: "off", low: "low", max: "max" } });
		const lines = t.comp.render(80);
		const tlmLine = lines.find((l) => l.includes("tlm"));
		ok("找到 tlm 行", !!tlmLine);
		ok("非 active tlm 行含 enabled list", tlmLine?.includes("off") && tlmLine?.includes("low") && tlmLine?.includes("max"));
	}

	console.log("\n=== text 字段：view 模式 j/k 是 nav；edit 模式是字符 ===");
	{
		const fields: FormField[] = [
			{ key: "x", label: "x", type: "text" },
			{ key: "y", label: "y", type: "text" },
		];
		const t = make(fields, { x: "ab", y: "yy" });
		// view 模式
		t.send("j");
		ok("view 模式 j → cursor 1（不是字符）", (t.comp as any).cursor === 1);
		ok("y 字段 draft = yy（未受 j 影响）", (t.comp as any).draft === "yy");
		t.send("\r");
		ok("Enter 进 edit", t.getEditing() === true);
		t.send("j");
		ok("edit 模式 j → draft = yyj", (t.comp as any).draft === "yyj");
		t.send("k");
		ok("edit 模式 k → draft = yyjk", (t.comp as any).draft === "yyjk");
	}

	console.log("\n=== select 字段 ↑↓ + Space 选 ===");
	{
		const fields: FormField[] = [
			{ key: "api", label: "api", type: "select", options: ["openai-completions", "anthropic-messages", "google-generative-ai"] },
		];
		const t = make(fields, { api: "openai-completions" });
		ok("selectCursor 初始 0", (t.comp as any).selectCursor === 0);
		t.send("\r");  // Enter 进 edit
		t.send("j");
		ok("j 下移 cursor 1", (t.comp as any).selectCursor === 1);
		t.send(" ");
		ok("Space 选 index 1 = anthropic-messages", t.getValues().api === "anthropic-messages");
		t.send("\r");  // Enter 退出 edit
		t.send("2");
		ok("nav 模式 2（数字）不响应 → api 仍是 anthropic-messages", t.getValues().api === "anthropic-messages");
	}

	console.log("\n=== levelmap 第一行 ↓ 在 view 模式切字段（不是行内 nav）===");
	{
		const fields: FormField[] = [
			{ key: "tlm", label: "tlm", type: "levelmap" },
			{ key: "next", label: "next", type: "text" },
		];
		const t = make(fields, { tlm: null, next: "" });
		t.send("\x1b[B");  // ↓ 在 nav 模式切 next 字段（不是行内 nav）
		ok("↓ 在 nav 模式 → cursor 1（切字段）", (t.comp as any).cursor === 1);
	}

	console.log("\n=== select 字段：Enter 进 edit，↑↓ 选，Space pick，Enter 退出 ===");
	{
		const fields: FormField[] = [
			{ key: "r", label: "r", type: "select", options: ["no", "yes"] },
		];
		const t = make(fields, { r: "no" });
		t.send("\r");  // Enter 进 edit
		ok("Enter → editing = true", t.getEditing() === true);
		t.send("\x1b[B");  // ↓ → cursor 1 (yes)
		t.send(" ");  // Space pick yes
		ok("Space → r = yes", t.getValues().r === "yes");
		t.send("\r");  // Enter 退出 edit
		ok("Enter → editing = false", t.getEditing() === false);
		ok("值保留为 yes", t.getValues().r === "yes");
	}
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
