// FormEditor 单元测试：统一 view/edit 两态模型
//   view（默认）：只响应 Enter（进 edit）、↑↓/j/k（切字段）、s（保存）、Esc/q（取消）
//   edit：可修改（typeable 输字符 / non-typeable 按 Space/↑↓）、Enter（提交+退出）
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

	console.log("\n=== typeable 字段：view 模式不接受字符；Enter 进 edit 才接受 ===");
	{
		const fields: FormField[] = [
			{ key: "name", label: "name", type: "text" },
			{ key: "url", label: "url", type: "text" },
		];
		const t = make(fields, { name: "a", url: "http://x" });
		ok("初始 cursor 0", (t.comp as any).cursor === 0);
		ok("draft 初始 = 当前值", (t.comp as any).draft === "a");
		ok("初始 editing = false", t.getEditing() === false);
		// view 模式：字符不响应
		t.send("X");
		ok("view 模式 X 不改 draft", (t.comp as any).draft === "a");
		ok("view 模式 X 不改 editing", t.getEditing() === false);
		// Enter 进 edit
		t.send("\r");
		ok("Enter → editing = true", t.getEditing() === true);
		t.send("X");
		ok("edit 模式 X → draft = aX", (t.comp as any).draft === "aX");
		t.send("Y");
		ok("edit 模式 Y → draft = aXY", (t.comp as any).draft === "aXY");
		// Enter 退出 edit（commit + stay on same field）
		t.send("\r");
		ok("Enter 退出 → editing = false", t.getEditing() === false);
		ok("Enter 退出 → values.name = aXY", t.getValues().name === "aXY");
		ok("Enter 退出 → cursor 仍 0（不自动移动）", (t.comp as any).cursor === 0);
	}

	console.log("\n=== typeable 字段：view 模式 j/k 是 nav（不是字符）===");
	{
		const fields: FormField[] = [
			{ key: "a", label: "a", type: "text" },
			{ key: "b", label: "b", type: "text" },
		];
		const t = make(fields, { a: "a0", b: "b0" });
		t.send("j");
		ok("view 模式 j → cursor 1（nav，不是字符）", (t.comp as any).cursor === 1);
		ok("draft = b0（不是 b0j）", (t.comp as any).draft === "b0");
	}

	console.log("\n=== typeable 字段：edit 模式 j/k 是字符 ===");
	{
		const fields: FormField[] = [{ key: "x", label: "x", type: "text" }];
		const t = make(fields, { x: "ab" });
		t.send("\r");  // Enter
		t.send("j");
		ok("edit 模式 j → draft = abj", (t.comp as any).draft === "abj");
		t.send("k");
		ok("edit 模式 k → draft = abjk", (t.comp as any).draft === "abjk");
	}

	console.log("\n=== Backspace：仅 edit + typeable 删 draft ===");
	{
		const fields: FormField[] = [{ key: "x", label: "x", type: "text" }];
		const t = make(fields, { x: "abc" });
		t.send("\x7f");
		ok("view 模式 backspace 不改 draft", (t.comp as any).draft === "abc");
		t.send("\r");  // Enter
		t.send("\x7f");
		ok("edit 模式 backspace 删 Y → ab", (t.comp as any).draft === "ab");
		t.send("\b");
		ok("edit 模式 \\b backspace 删 X → a", (t.comp as any).draft === "a");
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
		t.send("\x1b[B");
		ok("↓ → cursor 2", (t.comp as any).cursor === 2);
		t.send("\x1b[B");
		ok("最后 ↓ → cursor 0（循环）", (t.comp as any).cursor === 0);
		t.send("\x1b[A");
		ok("首 ↑ → cursor 2（反向循环）", (t.comp as any).cursor === 2);
	}

	console.log("\n=== select 字段：Enter 进 edit，↑↓/j/k 选，Space pick，Enter 退出 ===");
	{
		const fields: FormField[] = [{ key: "r", label: "r", type: "select", options: ["no", "yes"] }];
		const t = make(fields, { r: "no" });
		ok("初始 r = no, editing = false", t.getValues().r === "no" && t.getEditing() === false);
		// view 模式 ↑↓/j/k：nav fields（仅 1 个 field，不会移）
		t.send("\x1b[A");
		ok("nav 模式 ↑ 不动 r 值", t.getValues().r === "no");
		t.send("\x1b[B");
		ok("nav 模式 ↓ 不动 r 值", t.getValues().r === "no");
		// Enter → 进 edit
		t.send("\r");
		ok("Enter → editing = true", t.getEditing() === true);
		ok("selectCursor 0（指向 no）", (t.comp as any).selectCursor === 0);
		// edit 模式 ↑↓/j/k nav options
		t.send("\x1b[B");
		ok("edit 模式 ↓ → selectCursor 1（yes）", (t.comp as any).selectCursor === 1);
		t.send("j");
		ok("edit 模式 j → selectCursor 1（循环？）", (t.comp as any).selectCursor === 1);
		t.send("k");
		ok("edit 模式 k → selectCursor 0", (t.comp as any).selectCursor === 0);
		// Space pick
		t.send("\x1b[B");
		t.send(" ");
		ok("Space → r = yes", t.getValues().r === "yes");
		// Enter 退出 edit
		t.send("\r");
		ok("Enter → editing = false", t.getEditing() === false);
		ok("值保留为 yes", t.getValues().r === "yes");
	}

	console.log("\n=== multiselect 字段：Enter 进 edit，↑↓ 选，Space toggle ===");
	{
		const fields: FormField[] = [{ key: "i", label: "i", type: "multiselect", options: ["text", "image"] }];
		const t = make(fields, { i: ["text"] });
		ok("初始 i = ['text'], editing = false", JSON.stringify(t.getValues().i) === '["text"]' && t.getEditing() === false);
		// Enter → 进 edit
		t.send("\r");
		ok("Enter → editing = true", t.getEditing() === true);
		ok("multiselectCursor 0（text）", (t.comp as any).multiselectCursor === 0);
		t.send("\x1b[B");
		ok("edit ↓ → cursor 1（image）", (t.comp as any).multiselectCursor === 1);
		t.send(" ");
		ok("Space → image 加入", t.getValues().i.indexOf("image") >= 0);
		ok("i = ['text','image']", JSON.stringify(t.getValues().i) === '["text","image"]');
		t.send(" ");
		ok("再 Space → image 移除（toggle）", t.getValues().i.indexOf("image") < 0);
		t.send("\r");
		ok("Enter → editing = false", t.getEditing() === false);
		ok("值仍为 ['text']", JSON.stringify(t.getValues().i) === '["text"]');
	}

	console.log("\n=== levelmap：Enter 进 edit，↑↓ 选 row，Space toggle ===");
	{
		const fields: FormField[] = [{ key: "tlm", label: "thinkingLevelMap", type: "levelmap" }];
		const t = make(fields, { tlm: { low: "low" } });
		ok("初始 tlm.low 已勾, editing = false", t.getValues().tlm?.low === "low" && t.getEditing() === false);
		t.send("\r");
		ok("Enter → editing = true", t.getEditing() === true);
		ok("levelmapCursor 0（off）", (t.comp as any).levelmapCursor === 0);
		t.send("\x1b[B");
		ok("edit ↓ → cursor 1（minimal）", (t.comp as any).levelmapCursor === 1);
		t.send("\x1b[B");
		ok("edit ↓ → cursor 2（low）", (t.comp as any).levelmapCursor === 2);
		t.send(" ");
		ok("Space → low 取消（toggle）", t.getValues().tlm?.low === null);
		t.send("\r");
		ok("Enter → editing = false", t.getEditing() === false);
	}

	console.log("\n=== ↑↓ 切字段时也退出 edit 模式 ===");
	{
		const fields: FormField[] = [
			{ key: "a", label: "a", type: "text" },
			{ key: "b", label: "b", type: "text" },
		];
		const t = make(fields, { a: "a0", b: "b0" });
		t.send("\r");  // Enter on a
		t.send("X");
		ok("edit a → draft = a0X", (t.comp as any).draft === "a0X");
		t.send("\x1b[B");
		ok("↓ → cursor 1 (b)", (t.comp as any).cursor === 1);
		ok("↓ → editing = false（自动退 edit）", t.getEditing() === false);
		ok("↓ → values.a = a0X（commit）", t.getValues().a === "a0X");
		ok("draft = b0", (t.comp as any).draft === "b0");
	}

	console.log("\n=== nav 模式 Space 在非输入字段：快捷进 edit ===");
	{
		const fields: FormField[] = [{ key: "r", label: "r", type: "select", options: ["no", "yes"] }];
		const t = make(fields, { r: "no" });
		t.send(" ");
		ok("nav Space → editing = true（不动值）", t.getEditing() === true && t.getValues().r === "no");
	}

	console.log("\n=== number 字段：edit 模式 第一个数字替换，后续 append ===");
	{
		const fields: FormField[] = [{ key: "n", label: "n", type: "number" }];
		const t = make(fields, { n: 100 });
		t.send("\r");  // Enter
		t.send("2");
		ok("edit 模式 2 → draft = 2（替换）", (t.comp as any).draft === "2");
		t.send("0");
		ok("edit 模式 0 → draft = 20（append）", (t.comp as any).draft === "20");
		t.send("0");
		ok("edit 模式 0 → draft = 200", (t.comp as any).draft === "200");
	}

	console.log("\n=== number 字段：view 模式不接受数字键 ===");
	{
		const fields: FormField[] = [{ key: "n", label: "n", type: "number" }];
		const t = make(fields, { n: 100 });
		t.send("2");
		ok("view 模式 2 不改 draft", (t.comp as any).draft === "100");
	}

	console.log("\n=== number 字段：edit 模式 commit 失败时 error ===");
	{
		const fields: FormField[] = [{ key: "n", label: "n", type: "number" }];
		const t = make(fields, { n: 100 });
		t.send("\r");
		t.send("a");
		ok("edit 模式 'a' → draft = 100a", (t.comp as any).draft === "100a");
		// Enter 走 commitDraft，number 必须全数字 → 失败
		t.send("\r");
		ok("commit 失败 → error 设置了", (t.comp as any).error !== null);
		ok("commit 失败 → values.n 未变", t.getValues().n === 100);
	}

	console.log("\n=== Esc 行为：edit 退出 edit（commit）；nav 取消整个 form ===");
	{
		const fields: FormField[] = [{ key: "r", label: "r", type: "select", options: ["no", "yes"] }];
		const t = make(fields, { r: "no" });
		t.send("\r");
		t.send("\x1b[B");
		t.send(" ");
		ok("edit 中 r = yes", t.getValues().r === "yes");
		t.send("\x1b");
		ok("edit 模式 Esc → editing = false（不取消 form）", t.getEditing() === false);
		ok("值保留为 yes", t.getValues().r === "yes");
		ok("未触发 onCancel", t.isCancelled() === false);
		t.send("\x1b");
		ok("nav 模式 Esc → 整个 form 取消", t.isCancelled() === true);
	}

	console.log("\n=== q 行为：edit 退出 edit（commit）；nav 取消（任何字段类型统一）===");
	{
		const fields: FormField[] = [{ key: "x", label: "x", type: "text" }];
		const t = make(fields, { x: "abc" });
		t.send("\r");
		t.send("X");
		ok("edit 中 x = abcX", (t.comp as any).draft === "abcX");
		t.send("q");
		ok("edit 模式 q → editing = false（不取消 form）", t.getEditing() === false);
		ok("值保留为 abcX", t.getValues().x === "abcX");
		t.send("q");
		ok("nav 模式 q → 整个 form 取消", t.isCancelled() === true);
	}

	console.log("\n=== secret 字段：进入 edit 后 draft 是原值（不是 masked）===");
	{
		const fields: FormField[] = [{ key: "k", label: "k", type: "secret" }];
		const t = make(fields, { k: "sk-real-key-12345" });
		ok("view 模式 draft = '••••45'（masked）", (t.comp as any).draft === "••••45");
		// Enter 进 edit
		t.send("\r");
		ok("Enter 后 draft = 原值 'sk-real-key-12345'（不是 masked）", (t.comp as any).draft === "sk-real-key-12345");
		ok("Enter 后 draftIsOriginal = true", (t.comp as any).draftIsOriginal === true);
		// Enter 退出 edit（未改）
		t.send("\r");
		ok("Enter 退出（未改）→ values.k = 原值", t.getValues().k === "sk-real-key-12345");
	}

	console.log("\n=== secret 字段：不进 edit，直接切 field，原值保留 ===");
	{
		const fields: FormField[] = [
			{ key: "k", label: "k", type: "secret" },
			{ key: "n", label: "n", type: "text" },
		];
		const t = make(fields, { k: "sk-real-key-12345", n: "x" });
		// ↑↓ 切到 n，commitDraft 会被调，但 secret 未改 → 不写
		t.send("\x1b[B");
		ok("↓ 切到 n 后 values.k = 原值（未被 masked 覆盖）", t.getValues().k === "sk-real-key-12345");
		ok("↓ 切后 cursor = 1（n）", (t.comp as any).cursor === 1);
	}

	console.log("\n=== secret 字段：进 edit + 改值 + 退出 → 写新值 ===");
	{
		const fields: FormField[] = [{ key: "k", label: "k", type: "secret" }];
		const t = make(fields, { k: "sk-old" });
		t.send("\r");
		t.send("\x7f");  // 退一格
		t.send("X");
		ok("edit 后 draft = sk-olX（last char 改 X）", (t.comp as any).draft === "sk-olX");
		t.send("\r");
		ok("Enter 退出 → values.k = sk-olX（用户改的）", t.getValues().k === "sk-olX");
	}

	console.log("\n=== secret 字段：view 模式 draftIsOriginal=true，commitDraft 跳写 ===");
	{
		const fields: FormField[] = [{ key: "k", label: "k", type: "secret" }];
		const t = make(fields, { k: "sk-original" });
		ok("view 模式 draftIsOriginal = true", (t.comp as any).draftIsOriginal === true);
		// 模拟 commitDraft 被调（不调 get 但检查内部状态）
		(t.comp as any).commitDraft();
		ok("commitDraft 跳写 → values.k 保持原值", t.getValues().k === "sk-original");
	}

	console.log("\n=== s 键 → 保存整个 form（任何字段类型，view 模式）===");
	{
		const fields: FormField[] = [
			{ key: "a", label: "a", type: "readonly", render: () => "(read-only)" },
		];
		const t = make(fields, { a: "x" });
		t.send("s");
		ok("s 触发 onSave", t.get() !== null);
		ok("值 = x", t.get()?.a === "x");
	}

	console.log("\n=== s 在 typeable view 模式：view 模式 s 是 save（不是字符）===");
	{
		const fields: FormField[] = [
			{ key: "a", label: "a", type: "text" },
		];
		const t = make(fields, { a: "x" });
		t.send("Y");
		ok("view 模式 Y 不入 draft", (t.comp as any).draft === "x");
		t.send("s");
		ok("view 模式 s → 触发 save", t.get() !== null);
		ok("save 时 draft = x（Y 没入 draft）", t.get()?.a === "x");
	}

	console.log("\n=== s 在 typeable edit 模式：edit 模式 s 是字符（不入 save）===");
	{
		const fields: FormField[] = [
			{ key: "a", label: "a", type: "text" },
		];
		const t = make(fields, { a: "x" });
		t.send("\r");  // Enter
		t.send("Y");
		t.send("s");
		ok("edit 模式 s → draft = xYs", (t.comp as any).draft === "xYs");
		ok("edit 模式 s 不触发 save", t.get() === null);
	}

	console.log("\n=== render：typeable 在 edit 模式也带 [● edit] 标记 ===");
	{
		const fields: FormField[] = [
			{ key: "name", label: "name", type: "text" },
			{ key: "r", label: "r", type: "select", options: ["no", "yes"] },
		];
		const t = make(fields, { name: "alpha", r: "no" });
		t.send("\x1b[B");  // ↓ 到 r
		const navLines = t.comp.render(80);
		const navJoined = navLines.join("\n");
		ok("nav r 行显示 no", navJoined.includes("no"));
		ok("nav 模式不带 [● edit]", !navJoined.includes("[● edit]"));
		t.send("\r");  // Enter on r
		const editLines = t.comp.render(80);
		const editJoined = editLines.join("\n");
		ok("select edit 模式带 [● edit]", editJoined.includes("[● edit]"));
		// typeable edit 模式
		t.send("\r");  // exit edit
		t.send("\x1b[A");  // ↑ 到 name
		t.send("\r");  // Enter on name
		const tEditLines = t.comp.render(80);
		const tEditJoined = tEditLines.join("\n");
		ok("typeable edit 模式也带 [● edit]", tEditJoined.includes("[● edit]"));
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

	console.log("\n=== 括包粘贴（pi Ctrl+V / Alt+V / 右键）===");
	{
		// text 字段：view 模式粘贴自动进 edit + 拼到 draft
		const fields: FormField[] = [
			{ key: "name", label: "name", type: "text" },
			{ key: "n", label: "n", type: "number" },
			{ key: "s", label: "s", type: "select", options: ["x", "y"] },
		];
		const t = make(fields, { name: "orig", n: 0, s: "x" });

		// view 模式粘贴：自动进 edit + 拼到 draft
		t.send("\x1b[200~PASTED\x1b[201~");
		ok("view 模式粘贴 → 自动进 editing=true", t.getEditing() === true);
		ok("view 模式 text 粘贴 → draft = orig + 'PASTED'（拼到末尾）", (t.comp as any).draft === "origPASTED");

		// 继续粘贴：仍在 edit 态 + 拼到 draft
		t.send("\x1b[200~hello world\x1b[201~");
		ok("edit + text 粘贴 → draft += 'hello world'", (t.comp as any).draft === "origPASTEDhello world");

		// 跨多 chunk
		t.send("\x1b[200~part1");
		ok("text 仅 start → draft 不变", (t.comp as any).draft === "origPASTEDhello world");
		t.send("part2\x1b[201~");
		ok("text 结束合并 → draft += part1part2", (t.comp as any).draft === "origPASTEDhello worldpart1part2");

		// 换行被清理
		t.send("\x1b[200~li\nne\x1b[201~");
		ok("text 换行被去掉", (t.comp as any).draft === "origPASTEDhello worldpart1part2line");

		// number 字段：过滤非数字
		t.send("\r");  // exit edit name
		t.send("\x1b[B");  // ↓ 到 number
		t.send("\x1b[200~42abc99\x1b[201~");
		ok("number 粘贴 → 过滤非数字", (t.comp as any).draft === "4299");

		// select 字段：粘贴被忽略（非 typeable）
		t.send("\r");  // exit edit number
		t.send("\x1b[B");  // ↓ 到 select
		const draftBeforeSelect = (t.comp as any).draft;
		t.send("\x1b[200~anything\x1b[201~");
		ok("select 字段粘贴 → draft 不变（不是 typeable）", (t.comp as any).draft === draftBeforeSelect);

		// secret 字段：粘贴与单 char 走同路径（append）。要全替换需先 Backspace 清空。
		const secretFields: FormField[] = [
			{ key: "apiKey", label: "apiKey", type: "secret" },
		];
		const t2 = make(secretFields, { apiKey: "oldkey" });
		t2.send("\x1b[200~newkey\x1b[201~");
		ok("secret 粘贴 → draft = oldkey + newkey（与单 char 一致：append）", (t2.comp as any).draft === "oldkeynewkey");
		ok("secret 粘贴 → draftIsOriginal=false（标记已改）", (t2.comp as any).draftIsOriginal === false);
	}
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
