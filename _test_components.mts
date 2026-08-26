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

		console.log("\n=== ModelChecklist: a 全选/全不选 ===");
		const comp4 = new ModelChecklist({
			title: "ToggleAll",
			items: [{ id: "a" }, { id: "b" }, { id: "c" }],
			theme,
			onConfirm: () => {},
			onCancel: () => {},
		});
		ok("初始全选", (comp4 as any).selected.size === 3);
		comp4.handleInput("a");
		ok("a 后全不选", (comp4 as any).selected.size === 0);
		comp4.handleInput("a");
		ok("a 再后全选", (comp4 as any).selected.size === 3);

		console.log("\n=== ModelChecklist: i 反选 ===");
		const comp5 = new ModelChecklist({
			title: "Invert",
			items: [{ id: "a" }, { id: "b" }, { id: "c" }],
			theme,
			onConfirm: () => {},
			onCancel: () => {},
		});
		ok("初始全选", (comp5 as any).selected.size === 3);
		comp5.handleInput("i");
		ok("i 反选（0 个）", (comp5 as any).selected.size === 0);
		comp5.handleInput("i");
		ok("i 再反选（3 个）", (comp5 as any).selected.size === 3);

		console.log("\n=== ModelChecklist: g/G 跳顶跳底 ===");
		const comp6 = new ModelChecklist({
			title: "Jump",
			items: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
			theme,
			onConfirm: () => {},
			onCancel: () => {},
		});
		(comp6 as any).cursor = 2;
		comp6.handleInput("g");
		ok("g 跳顶 → cursor 0", (comp6 as any).cursor === 0);
		comp6.handleInput("G");
		ok("G 跳底 → cursor 3", (comp6 as any).cursor === 3);

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
		ok("cursor 行有 ▸ 标记", lines.some((l) => l.includes("▸")));
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
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
