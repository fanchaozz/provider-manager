// ModelChecklist 组件测试
import { ModelChecklist, matchesKey } from "./components.ts";

const ok = (label: string, cond: boolean) => {
	const tag = cond ? "✓" : "✗";
	console.log(`${tag} ${label}`);
	if (!cond) process.exitCode = 1;
};

const theme = {
	fg: (c: string, s: string) => `[${c}]${s}[/${c}]`,
	bold: (s: string) => `*${s}*`,
	bg: (c: string, s: string) => `<${c}>${s}</${c}>`,
};

async function main() {
	console.log("=== matchesKey 基础 ===");
	ok("escape", matchesKey("\x1b", "escape"));
	ok("enter", matchesKey("\r", "enter"));
	ok("up", matchesKey("\x1b[A", "up"));
	ok("down", matchesKey("\x1b[B", "down"));
	ok("space (single char)", matchesKey(" ", " "));
	ok("ctrl+c (data = \\x1bc)", matchesKey("\x1bc", "ctrl+c"));

	console.log("\n=== ModelChecklist: 初始预选（默认全选非 disabled）===");
	{
		const items = [
			{ id: "a", label: "A label", disabled: false },
			{ id: "b", label: "", disabled: false },
			{ id: "c", label: "C", disabled: true },
		];
		const comp = new ModelChecklist({
			title: "Test",
			items,
			theme,
			onConfirm: () => {},
			onCancel: () => {},
		});
		ok("c 是 disabled", (comp as any).items[2].disabled);
		ok("a 预选", (comp as any).selected.has("a"));
		ok("b 预选", (comp as any).selected.has("b"));
		ok("c 不预选（disabled）", !(comp as any).selected.has("c"));

		console.log("\n=== ModelChecklist: Space 切换 ===");
		comp.handleInput(" ");
		ok("Space 取消 a", !(comp as any).selected.has("a"));
		comp.handleInput(" ");
		ok("Space 再选 a", (comp as any).selected.has("a"));

		console.log("\n=== ModelChecklist: ↓ 移动 + Space 切 b ===");
		comp.handleInput("\x1b[B");
		ok("cursor 在 1 (b)", (comp as any).cursor === 1);
		comp.handleInput(" ");
		ok("b 取消", !(comp as any).selected.has("b"));
		comp.handleInput(" ");
		ok("b 恢复", (comp as any).selected.has("b"));

		console.log("\n=== ModelChecklist: Enter 提交 ===");
		let captured: string[] | null = null;
		const comp2 = new ModelChecklist({
			title: "Submit",
			items,
			theme,
			onConfirm: (sel) => { captured = sel; },
			onCancel: () => {},
		});
		comp2.handleInput("\r");
		ok("onConfirm 触发", Array.isArray(captured));
		ok("captured 含 a", captured?.includes("a"));
		ok("captured 含 b", captured?.includes("b"));
		ok("captured 不含 c（disabled）", !captured?.includes("c"));

		console.log("\n=== ModelChecklist: Esc 取消 ===");
		let cancelled = false;
		const comp3 = new ModelChecklist({
			title: "Cancel",
			items: [{ id: "x" }],
			theme,
			onConfirm: () => {},
			onCancel: () => { cancelled = true; },
		});
		comp3.handleInput("\x1b");
		ok("onCancel 触发", cancelled);

		console.log("\n=== ModelChecklist: a/i/g/G 变为 search 输入（search-first 约定）===");
		// 新设计：search 输入框始终可见、可打印字符都进 search。所以 a/i/g/G 不再是快捷键。
		const comp4 = new ModelChecklist({
			title: "SearchFirst",
			items: [{ id: "a" }, { id: "b" }, { id: "c" }],
			theme,
			onConfirm: () => {},
			onCancel: () => {},
		});
		ok("初始全选", (comp4 as any).selected.size === 3);
		comp4.handleInput("a");  // a 进 query
		ok("a 进 query（query='a'）", (comp4 as any).query === "a");
		ok("selected 不变（a 不作 toggle all）", (comp4 as any).selected.size === 3);
		// 清空 query
		comp4.handleInput("\x7f");
		ok("Backspace 清空 query", (comp4 as any).query === "");
		// 同样：i、g、G 进 query
		comp4.handleInput("i");
		ok("i 进 query", (comp4 as any).query === "i");
		comp4.handleInput("\x7f");
		comp4.handleInput("g");
		ok("g 进 query", (comp4 as any).query === "g");
		comp4.handleInput("\x7f");
		comp4.handleInput("G");
		ok("G 进 query", (comp4 as any).query === "G");
		comp4.handleInput("\x7f");

		console.log("\n=== ModelChecklist: render 输出含 checkbox 标记 ===");
		const comp7 = new ModelChecklist({
			title: "Render test",
			items: [
				{ id: "alpha" },
				{ id: "beta", disabled: true },
				{ id: "gamma" },
			],
			theme,
			preSelect: (it) => it.id === "alpha",  // gamma 默认不选，render 才有 [ ]
			onConfirm: () => {},
			onCancel: () => {},
		});
		const lines = comp7.render(80);
		const joined = lines.join("\n");
		ok("含 [√] (alpha 预选)", joined.includes("[√]"));
		ok("含 [skip] (beta disabled)", joined.includes("[skip]"));
		// gamma 预选但未选中 → 输出 "[ ]"（被 theme wrap 成 [dim][ ][/dim]）
		ok("含未选中方括号（[dim][ ][/dim]）", joined.includes("[ ][/dim]"));
		ok("含 alpha", joined.includes("alpha"));
		ok("含 beta", joined.includes("beta"));
		ok("含 gamma", joined.includes("gamma"));
		ok("含 footer Space 提示", joined.includes("Space"));
		ok("含 footer Enter 提示", joined.includes("Enter"));
		ok("含 footer Esc 提示", joined.includes("Esc"));
		ok("cursor 行有 ▶ 标记", lines.some((l) => l.includes("▶")));
		ok("含 search input 提示词 (type to filter)", joined.includes("type to filter"));
		ok("含顶部 selected/total 状态", joined.includes("1/3 selected"));
		ok("含底部 (1/N) 位置指示", /\(1\/3\)/.test(joined));
	}

	console.log("\n=== preSelect 过滤 ===");
	{
		const comp = new ModelChecklist({
			title: "PreSel",
			items: [
				{ id: "a" },
				{ id: "b" },
				{ id: "c" },
			],
			theme,
			preSelect: (it) => it.id !== "b",
			onConfirm: () => {},
			onCancel: () => {},
		});
		ok("a 预选", (comp as any).selected.has("a"));
		ok("b 不预选", !(comp as any).selected.has("b"));
		ok("c 预选", (comp as any).selected.has("c"));
	}

	console.log("\n=== ModelChecklist: 导航 wrap-around（顶部↑→末、底部↓→首）===");
	{
		const comp = new ModelChecklist({
			title: "Wrap",
			items: [{ id: "a" }, { id: "b" }, { id: "c" }],
			theme,
			onConfirm: () => {},
			onCancel: () => {},
		});
		ok("初始 cursor=0", (comp as any).cursor === 0);
		comp.handleInput("\x1b[A");  // ↑
		ok("↑ 在顶部跳到末项（cursor=2）", (comp as any).cursor === 2);
		comp.handleInput("\x1b[B");  // ↓
		ok("↓ 在底部跳回首项（cursor=0）", (comp as any).cursor === 0);
		// k 同样
		comp.handleInput("k");
		ok("k 在顶部跳到末项（cursor=2）", (comp as any).cursor === 2);
		comp.handleInput("j");
		ok("j 在底部跳回首项（cursor=0）", (comp as any).cursor === 0);
	}

	console.log("\n=== ModelChecklist: 搜索过滤 + Space 选中（filter 后仍可 toggle）===");
	{
		const comp = new ModelChecklist({
			title: "FilterToggle",
			items: [
				{ id: "gpt-4" },
				{ id: "gpt-4-turbo" },
				{ id: "claude-opus-4-7" },
				{ id: "claude-sonnet-4" },
			],
			theme,
			onConfirm: () => {},
			onCancel: () => {},
		});
		// 输入 "gpt" 过滤
		comp.handleInput("g");
		comp.handleInput("p");
		comp.handleInput("t");
		ok("query='gpt' → visibleItems 含 2 个", (comp as any).visibleItems().length === 2);
		// Space 取消 cursor 处的 gpt-4
		comp.handleInput(" ");
		ok("Space 取消 gpt-4", !(comp as any).selected.has("gpt-4"));
		ok("gpt-4-turbo 仍选", (comp as any).selected.has("gpt-4-turbo"));
		ok("claude-* 仍选（不在 filter 内）", (comp as any).selected.has("claude-opus-4-7"));
		// Backspace 删字
		comp.handleInput("\x7f");
		comp.handleInput("\x7f");
		comp.handleInput("\x7f");
		ok("Backspace 清空 query → visibleItems 恢复 4 个", (comp as any).visibleItems().length === 4);
	}

	console.log("\n=== ModelChecklist: 视口滚动 + (top) 钉住 + 隐藏提示 ===");
	{
		// 20 个 model，maxRows=5，cursor 滚到 10 时顶部应钉住首项
		const items = Array.from({ length: 20 }, (_, i) => ({ id: `m${i.toString().padStart(2, "0")}` }));
		const comp = new ModelChecklist({
			title: "Viewport",
			items,
			theme,
			maxRows: 5,
			onConfirm: () => {},
			onCancel: () => {},
		});
		ok("maxRows = 5", (comp as any).maxRows === 5);
		// 滚到 10
		for (let i = 0; i < 10; i++) comp.handleInput("\x1b[B");
		ok("10 次 ↓ → cursor=10", (comp as any).cursor === 10);
		comp.render(80);
		// top 钉住首项时，cursor=10 超出 maxRows=5，有效视口 = 5-1=4，top = 10-4+1 = 7
		ok("top 调整使 cursor 在视口内（top = 7）", (comp as any).top === 7);
		const lines = comp.render(80);
		const out = lines.join("\n");
		ok("render 含 m00 (top) 钉住", out.includes("m00") && out.includes("(top)"));
		ok("render 含 m10（cursor 项）", out.includes("m10"));
		ok("render 含 'hidden' 提示", out.includes("hidden"));
		ok("render 含 'more below' 提示", out.includes("more below"));
		// 位置指示
		ok("render 含 (11/20) 位置", out.includes("(11/20)"));
		// selected/total 状态
		ok("render 含 20/20 selected", out.includes("20/20 selected"));
	}

	console.log("\n=== ModelChecklist: query 空时 (current/total) 显示 cursor/total ===");
	{
		const comp = new ModelChecklist({
			title: "Position",
			items: [{ id: "a" }, { id: "b" }, { id: "c" }],
			theme,
			maxRows: 2,
			onConfirm: () => {},
			onCancel: () => {},
		});
		// 把 cursor 移到 2
		comp.handleInput("\x1b[B");
		comp.handleInput("\x1b[B");
		ok("cursor=2", (comp as any).cursor === 2);
		const out = comp.render(80).join("\n");
		ok("query 空 → (3/3) 总长度指示", out.includes("(3/3)"));
	}

	console.log("\n=== ModelChecklist: maxRows 边界保护（5-200）===");
	{
		const comp = new ModelChecklist({
			title: "Bounds",
			items: [{ id: "a" }],
			theme,
			maxRows: 1,  // 太小
			onConfirm: () => {},
			onCancel: () => {},
		});
		ok("maxRows=1 → clamp 到 >= 5", (comp as any).maxRows >= 5);
		const comp2 = new ModelChecklist({
			title: "Bounds2",
			items: [{ id: "a" }],
			theme,
			maxRows: 999,  // 太大
			onConfirm: () => {},
			onCancel: () => {},
		});
		ok("maxRows=999 → clamp 到 <= 200", (comp2 as any).maxRows <= 200);
	}

	console.log("\n=== ModelChecklist: 括包粘贴（Ctrl+V / Alt+V / 右键）===");
	{
		// 完整一块：start + content + end 进同一次 handleInput（pi-tui 走法）
		const comp = new ModelChecklist({
			title: "Paste",
			items: [{ id: "a" }, { id: "b" }, { id: "abc" }],
			theme,
			onConfirm: () => {},
			onCancel: () => {},
		});
		comp.handleInput("\x1b[200~abc\x1b[201~");
		ok("完整一块粘贴 → query = 'abc'", (comp as any).query === "abc");
		ok("过滤后只剩 'abc'（1 项）", (comp as any).visibleItems().length === 1);
		ok("过滤后首项是 abc", (comp as any).visibleItems()[0].id === "abc");

		// 跨多次：分 3 块送进（模拟大文本被 node 拆 chunk）
		const comp2 = new ModelChecklist({
			title: "Paste2",
			items: [{ id: "x" }, { id: "y" }],
			theme,
			onConfirm: () => {},
			onCancel: () => {},
		});
		comp2.handleInput("\x1b[200~hello");
		ok("仅 start → query 仍为空（未完成）", (comp2 as any).query === "");
		comp2.handleInput(" wo");
		ok("中段 → query 仍为空", (comp2 as any).query === "");
		comp2.handleInput("rld\x1b[201~");
		ok("结束时合并 → query = 'hello world'", (comp2 as any).query === "hello world");

		// 清理换行 / \r / \t
		const comp3 = new ModelChecklist({
			title: "Paste3",
			items: [{ id: "z" }],
			theme,
			onConfirm: () => {},
			onCancel: () => {},
		});
		comp3.handleInput("\x1b[200~li\nne\ttwo\x1b[201~");
		ok("\\n 去掉", (comp3 as any).query === "line    two");
		ok("\\t 变 4 空格", (comp3 as any).query.includes("    "));

		// 单 chunk 含多 start/end（递归处理剩余）
		const comp4 = new ModelChecklist({
			title: "Paste4",
			items: [{ id: "p" }],
			theme,
			onConfirm: () => {},
			onCancel: () => {},
		});
		comp4.handleInput("\x1b[200~foo\x1b[201~bar");
		ok("首段粘贴 'foo' + 剩余 'bar' 进 query/query/search", (comp4 as any).query === "foobar");
	}
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
