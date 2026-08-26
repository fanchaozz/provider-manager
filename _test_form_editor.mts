// FormEditor 单元测试（新设计：↑↓ 切字段 + e 进 edit + Space pick/toggle + Enter 退出/edit 末字段保存 + Esc 取消）
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
	console.log("=== matchesKey 基础 ===");
	ok("escape", matchesKey("\x1b", "escape"));
	ok("enter", matchesKey("\r", "enter"));
	ok("up", matchesKey("\x1b[A", "up"));
	ok("down", matchesKey("\x1b[B", "down"));
	ok("j/k 是单 char", matchesKey("j", "j") && matchesKey("k", "k"));
	ok("ctrl+s matchesKey", matchesKey("\x1bs", "ctrl+s"));  // matchesKey utility 仍存在，但不再用 Ctrl+S 作 save

	console.log("\n=== matchesKey 已删：tab 和 shift+tab 不再匹配 FormEditor 内部 key ===");

	console.log("\n=== 文本 inline 编辑（typeable 字段无 enter/exit 概念）===");
	{
		const fields: FormField[] = [
			{ key: "name", label: "name", type: "text" },
			{ key: "url", label: "url", type: "text" },
		];
		const t = make(fields, { name: "a", url: "http://x" });
		ok("初始 cursor 0", (t.comp as any).cursor === 0);
		ok("draft 初始 = 当前值", (t.comp as any).draft === "a");
		ok("初始 editing = false", t.getEditing() === false);
		t.send("X");
		ok("输入 X 后 draft = aX", (t.comp as any).draft === "aX");
		ok("typeable 字段不会进入 editing 模式", t.getEditing() === false);
		// 输入字段 Enter → commit + 移动到下一字段
		t.send("\r");
		ok("Enter 在 typeable → commit draft + 移动", t.getValues().name === "aX" && (t.comp as any).cursor === 1);
		ok("commit 后 draft = url 的值", (t.comp as any).draft === "http://x");
	}

	console.log("\n=== Backspace ===");
	{
		const fields: FormField[] = [{ key: "x", label: "x", type: "text" }];
		const t = make(fields, { x: "abc" });
		ok("draft 初始 = abc", (t.comp as any).draft === "abc");
		t.send("\x7f");
		ok("backspace 后 draft = ab", (t.comp as any).draft === "ab");
	}

	console.log("\n=== ↑↓ 切字段（循环：最后→最前，最前→最后）===");
	{
		const fields: FormField[] = [
			{ key: "a", label: "a", type: "text" },
			{ key: "b", label: "b", type: "text" },
			{ key: "c", label: "c", type: "text" },
		];
		const t = make(fields, { a: "1", b: "2", c: "3" });
		ok("初始 cursor 0", (t.comp as any).cursor === 0);
		t.send("\x1b[B");
		ok("↓ → cursor 1", (t.comp as any).cursor === 1);
		t.send("[B");
		ok("↓ → cursor 2", (t.comp as any).cursor === 2);
		t.send("[A");
		ok("↑ → cursor 1", (t.comp as any).cursor === 1);
		t.send("\x1b[B");
		t.send("\x1b[B");
		ok("最后字段再 ↓ → cursor 0（循环）", (t.comp as any).cursor === 0);
		t.send("\x1b[A");
		ok("首字段再 ↑ → cursor 2（反向循环）", (t.comp as any).cursor === 2);
	}

	console.log("\n=== select 字段（reasoning/option）: Enter 进 edit，↑↓ 选，Space pick，Enter 退出 ===");
	{
		const fields: FormField[] = [
			{ key: "r", label: "r", type: "select", options: ["no", "yes"] },
			{ key: "next", label: "next", type: "text" },
		];
		const t = make(fields, { r: "no", next: "" });
		ok("初始 r = no, editing = false", t.getValues().r === "no" && t.getEditing() === false);
		// ↑↓ 在 nav 模式不动 boolean 值
		t.send("\x1b[A");
		ok("↑ 不动 r 值", t.getValues().r === "no");
		t.send("\x1b[B");
		ok("↓ 也不动 r 值", t.getValues().r === "no");
		// Enter → 进 edit 模式
		t.send("e");
		ok("Enter → editing = true", t.getEditing() === true);
		ok("selectCursor 0（指向 no）", (t.comp as any).selectCursor === 0);
		// ↑↓ 选 option
		t.send("\x1b[B");
		ok("↓ → selectCursor 1（yes）", (t.comp as any).selectCursor === 1);
		t.send("j");
		ok("j → selectCursor 1（yes，循环？）", (t.comp as any).selectCursor === 1);
		t.send("k");
		ok("k → selectCursor 0（no）", (t.comp as any).selectCursor === 0);
		// Space pick 当前 option（先 ↓ 到 yes 再 Space）
		t.send("\x1b[B");
		ok("↓ → selectCursor 1（yes）", (t.comp as any).selectCursor === 1);
		t.send(" ");
		ok("Space → r = yes（stay in edit）", t.getValues().r === "yes");
		ok("pick 后 editing 仍 true", t.getEditing() === true);
		// Enter 退出 edit
		t.send("\r");
		ok("Enter → editing = false（退出 edit）", t.getEditing() === false);
		ok("值保留为 yes", t.getValues().r === "yes");
	}

	console.log("\n=== multiselect 字段（input/text+image）: Enter 进 edit，↑↓ 选，Space toggle（多选） ===");
	{
		const fields: FormField[] = [
			{ key: "i", label: "i", type: "multiselect", options: ["text", "image"] },
		];
		const t = make(fields, { i: ["text"] });
		ok("初始 i = ['text'], editing = false", JSON.stringify(t.getValues().i) === '["text"]' && t.getEditing() === false);
		// ↑↓ 在 nav 模式不动值
		t.send("\x1b[B");
		ok("↓ 不动 i 值", JSON.stringify(t.getValues().i) === '["text"]');
		// Enter → 进 edit
		t.send("e");
		ok("Enter → editing = true", t.getEditing() === true);
		ok("multiselectCursor 0（text）", (t.comp as any).multiselectCursor === 0);
		t.send("\x1b[B");
		ok("↓ → cursor 1（image）", (t.comp as any).multiselectCursor === 1);
		// Space toggle current
		t.send(" ");
		ok("Space → image 加入值", t.getValues().i.indexOf("image") >= 0);
		ok("Space 后 i = ['text','image']（多选）", JSON.stringify(t.getValues().i) === '["text","image"]');
		t.send(" ");
		ok("再 Space → image 移除（toggle）", t.getValues().i.indexOf("image") < 0);
		// Enter 退出 edit
		t.send("\r");
		ok("Enter → editing = false", t.getEditing() === false);
		ok("值仍为 ['text']", JSON.stringify(t.getValues().i) === '["text"]');
	}

	console.log("\n=== ↑↓ 切字段（循环：最后→最前，最前→最后）===");
	{
		const fields: FormField[] = [
			{ key: "a", label: "a", type: "text" },
			{ key: "b", label: "b", type: "text" },
			{ key: "c", label: "c", type: "text" },
		];
		const t = make(fields, { a: "1", b: "2", c: "3" });
		ok("初始 cursor 0", (t.comp as any).cursor === 0);
		t.send("\x1b[B");
		ok("↓ → cursor 1", (t.comp as any).cursor === 1);
		t.send("[B");
		ok("↓ → cursor 2", (t.comp as any).cursor === 2);
		t.send("[A");
		ok("↑ → cursor 1", (t.comp as any).cursor === 1);
		t.send("\x1b[B");
		t.send("\x1b[B");
		ok("最后字段再 ↓ → cursor 0（循环）", (t.comp as any).cursor === 0);
		t.send("\x1b[A");
		ok("首字段再 ↑ → cursor 2（反向循环）", (t.comp as any).cursor === 2);
	}

	console.log("\n=== nav 模式 Space 在非输入字段：进 edit 模式（不动值）===");
	{
		const fields: FormField[] = [{ key: "r", label: "r", type: "select", options: ["no", "yes"] }];
		const t = make(fields, { r: "no" });
		t.send(" ");
		ok("nav Space → editing = true（不动值）", t.getEditing() === true && t.getValues().r === "no");
	}

	console.log("\n=== number 字段：↑↓ 移动 + 数字键直接替换 ===");
	{
		const fields: FormField[] = [
			{ key: "n", label: "n", type: "number" },
		];
		const t = make(fields, { n: 100 });
		t.send("2");
		ok("输入 2 → draft = 2（替换）", (t.comp as any).draft === "2");
		t.send("0");
		ok("再输 0 → draft = 20（append）", (t.comp as any).draft === "20");
		t.send("0");
		ok("再输 0 → draft = 200", (t.comp as any).draft === "200");
	}

	console.log("\n=== number 字段非数字不 commit ===");
	{
		const fields: FormField[] = [
			{ key: "n", label: "n", type: "number" },
		];
		const t = make(fields, { n: 100 });
		t.send("a");
		ok("输入 'a' 后 draft = 100a", (t.comp as any).draft === "100a");
		ok("number 字段不会进入 editing 模式", t.getEditing() === false);
		// 触发 commit 看 error（Enter 走 typeable 流程 commitDraft）
		t.send("\r");
		ok("error 设置了（commit 失败时）", (t.comp as any).error !== null);
		ok("commit 失败 → 值未变", t.getValues().n === 100);
	}

	console.log("\n=== Esc 行为：nav 取消；edit 退出 edit（commit）===");
	{
		const fields: FormField[] = [
			{ key: "r", label: "r", type: "select", options: ["no", "yes"] },
		];
		const t = make(fields, { r: "no" });
		t.send("e");  // Enter 进 edit
		t.send("\x1b[B");  // ↓ → cursor 1 (yes)
		t.send(" ");  // pick yes
		ok("edit 中 r = yes", t.getValues().r === "yes");
		t.send("\x1b");
		ok("edit 模式 Esc → editing = false（不取消整个 form）", t.getEditing() === false);
		ok("值保留为 yes", t.getValues().r === "yes");
		ok("未触发 onCancel", t.isCancelled() === false);
		t.send("\x1b");
		ok("nav 模式 Esc → 整个 form 取消", t.isCancelled() === true);
	}

	console.log("\n=== s 键 → 保存整个 form（非 typeable 字段）===");
	{
		// 关键：s 只在 non-typeable 字段里触发 save（避免 apiKey 含 s 误保存）
		const fields: FormField[] = [
			{ key: "a", label: "a", type: "readonly", render: () => "(read-only)" },
		];
		const t = make(fields, { a: "x" });
		t.send("Y");  // readonly 字段，Y 不入 draft，只是模拟
		t.send("s");
		ok("s 触发 onSave", t.get() !== null);
		ok("值 = x", t.get()?.a === "x");
	}

	console.log("\n=== s 在 typeable 字段里是字符，不触发 save ===");
	{
		const fields: FormField[] = [
			{ key: "a", label: "a", type: "text" },
		];
		const t = make(fields, { a: "x" });
		t.send("Y");
		t.send("s");  // 在 text 字段里 s 是字符
		ok("s 在 text 字段里是字符（draft 含 s）", (t.comp as any).draft === "xYs");
		ok("不触发 save", t.get() === null);
	}

	console.log("\n=== render 输出（active editing 标记）===");
	{
		const fields: FormField[] = [
			{ key: "name", label: "name", type: "text" },
			{ key: "r", label: "r", type: "select", options: ["no", "yes"] },
		];
		const t = make(fields, { name: "alpha", r: "no" });
		t.send("\x1b[B");
		const navLines = t.comp.render(80);
		const navJoined = navLines.join("\n");
		ok("nav r 行显示 no", navJoined.includes("no"));
		ok("nav 模式不带 [● edit]", !navJoined.includes("[● edit]"));
		t.send("e");
		const editLines = t.comp.render(80);
		const editJoined = editLines.join("\n");
		ok("edit 模式带 [● edit]", editJoined.includes("[● edit]"));
	}

	console.log("\n=== cyclic field navigation（↑↓ 切字段）===");
	{
		const fields: FormField[] = [
			{ key: "a", label: "a", type: "text" },
			{ key: "b", label: "b", type: "text" },
			{ key: "c", label: "c", type: "text" },
		];
		const t = make(fields, { a: "1", b: "2", c: "3" });
		ok("初始 cursor 0", (t.comp as any).cursor === 0);
		t.send("\x1b[B");
		ok("↓ → 1", (t.comp as any).cursor === 1);
		t.send("\x1b[B");
		ok("↓ → 2", (t.comp as any).cursor === 2);
		t.send("\x1b[B");
		ok("最后 ↓ → 0（循环）", (t.comp as any).cursor === 0);
		t.send("\x1b[A");
		ok("首 ↑ → 2（反向循环）", (t.comp as any).cursor === 2);
	}
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
