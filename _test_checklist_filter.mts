// ModelChecklist 视口 + 始终可见的 search 输入框 + (current/total) 位置
import { ModelChecklist } from "./components.ts";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ok = (label: string, cond: boolean) => console.log((cond ? "✓ " : "✗ ") + label);

const th = { fg: (_c: string, s: string) => s, bold: (s: string) => s, bg: (_c: string, s: string) => s };

// 100 个 model：m000, m001, ..., m099；m050, m051 label 带 "lite"
const items = Array.from({ length: 100 }, (_, i) => {
	const id = `m${String(i).padStart(3, "0")}`;
	return { id, label: i === 50 || i === 51 ? `${id}  (lite)` : id };
});

console.log("=== Case 1: 视口滚动 + 钉住首项 ===");
{
	const cl = new ModelChecklist({
		title: "test", items, theme: th, maxRows: 10, onConfirm: () => {}, onCancel: () => {},
	});
	// 用 ↓ 滚到底（j / k / ↑ / ↓ / Space / Backspace 之外只有可打印字符是 query 字符；
	// 大写 G 也是字符，进 query。跳到底用 ↓ 滚）
	for (let i = 0; i < 99; i++) cl.handleInput("\x1b[B");  // 99 次 ↓
	const lines = cl.render(80);
	const out = lines.join("\n");
	ok("G-after 效果：cursor=99", (cl as any).cursor === 99);
	ok("G 后 render 含 m000 (top) 钉住首项", out.includes("m000"));
	ok("G 后 render 含 '(top)' 标签",         out.includes("(top)"));
	ok("G 后 render 含 'hidden' 指示",        out.includes("hidden"));
	ok("G 后 top 已滚动（> 0）",               (cl as any).top > 0);
	ok("G 后末页不含 'more below'（最末）",    !out.includes("more below"));
	ok("可见行数 ≤ 10",  lines.filter(l => l.includes("▶") || l.includes("[√]") || l.includes("[ ]")).length <= 10);
	// 位置指示 (100/100)
	ok("render 含 (100/100) 位置", out.includes("(100/100)"));
}

console.log("\n=== Case 2: 始终可见的 search 输入框 + 字符过滤 ===");
{
	const cl = new ModelChecklist({
		title: "test", items, theme: th, maxRows: 10, onConfirm: () => {}, onCancel: () => {},
	});
	// 即使空 query 也应渲染 search 行（> |）
	const out0 = cl.render(80).join("\n");
	ok("query 空也渲染 > prompt", out0.includes("> "));
	// 输 "050" 过滤
	cl.handleInput("0");
	cl.handleInput("5");
	cl.handleInput("0");
	ok("query='050' → visible 长度 = 1（仅 m050）", (cl as any).visibleItems().length === 1);
	const out = cl.render(80).join("\n");
	ok("渲染含 m050",            out.includes("m050"));
	ok("渲染含 query='050'",      out.includes("050"));
	// 位置 (1/1)
	ok("render 含 (1/1) 位置",   out.includes("(1/1)"));
	// Backspace 删字
	cl.handleInput("\x7f");
	cl.handleInput("\x7f");
	ok("Backspace 2 次后 query='0'", (cl as any).query === "0");
	cl.handleInput("\x7f");
	ok("Backspace 清空 query", (cl as any).query === "");
	ok("query 空后 visible 恢复 100", (cl as any).visibleItems().length === 100);
}

console.log("\n=== Case 3: 过滤后 Space 仍可切换选中 ===");
{
	const cl = new ModelChecklist({
		title: "test", items, theme: th, maxRows: 10, onConfirm: () => {}, onCancel: () => {},
	});
	cl.handleInput("0");
	cl.handleInput("5");
	cl.handleInput("0");
	ok("filter='050' 命中 m050", (cl as any).visibleItems().length === 1);
	const beforeAll = (cl as any).selected.size;
	cl.handleInput(" ");  // 取消 m050
	ok("Space 后 m050 被取消", !(cl as any).selected.has("m050"));
	ok("selected 减少 1", (cl as any).selected.size === beforeAll - 1);
	cl.handleInput(" ");  // 再选
	ok("再 Space 恢复 m050", (cl as any).selected.has("m050"));
}

console.log("\n=== Case 4: 过滤后 ↑/↓ 在过滤结果内导航 ===");
{
	const cl = new ModelChecklist({
		title: "test", items, theme: th, maxRows: 10, onConfirm: () => {}, onCancel: () => {},
	});
	cl.handleInput("0");
	cl.handleInput("5");
	cl.handleInput("0");
	ok("filter='050' 后 visible 长度 = 1（仅 m050）", (cl as any).visibleItems().length === 1);
	cl.handleInput("j");  // j 仍是 nav 键（因为不是 backspace / 字母 / 等价 search 字符）
	ok("j 仍是 nav（visible 1 个，cursor 不变）", (cl as any).cursor === 0);
}

console.log("\n=== Case 5: a / i / g / G 全部进 query（search-first 约定）===");
{
	const cl = new ModelChecklist({
		title: "test", items, theme: th, maxRows: 10, onConfirm: () => {}, onCancel: () => {},
	});
	cl.handleInput("a");
	ok("'a' 进 query（query='a'）", (cl as any).query === "a");
	cl.handleInput("\x7f");
	cl.handleInput("i");
	ok("'i' 进 query（query='i'）", (cl as any).query === "i");
	cl.handleInput("\x7f");
	cl.handleInput("g");
	ok("'g' 进 query（query='g'）", (cl as any).query === "g");
	cl.handleInput("\x7f");
	cl.handleInput("G");
	ok("'G' 进 query（query='G'）", (cl as any).query === "G");
	cl.handleInput("\x7f");
	// 一字一字输 'lite' 进去（handleInput 一次只吃 1 字符）
	cl.handleInput("l");
	cl.handleInput("i");
	cl.handleInput("t");
	cl.handleInput("e");
	ok("输完 'lite' 匹配 2 个（m050 + m051 含 lite label）", (cl as any).visibleItems().length === 2);
}

console.log("\n=== Case 6: ↑/↓ 边界循环 ===");
{
	const cl = new ModelChecklist({
		title: "test", items, theme: th, maxRows: 10, onConfirm: () => {}, onCancel: () => {},
	});
	ok("初始 cursor=0", (cl as any).cursor === 0);
	cl.handleInput("\x1b[A");  // ↑
	ok("↑ 在顶部跳到末项 (cursor=99)", (cl as any).cursor === 99);
	cl.handleInput("\x1b[B");  // ↓
	ok("↓ 在底部跳回首项 (cursor=0)", (cl as any).cursor === 0);
	cl.handleInput("k");
	ok("k 在顶部跳到末项", (cl as any).cursor === 99);
	cl.handleInput("j");
	ok("j 在底部跳回首项", (cl as any).cursor === 0);
}

console.log("\n=== Case 7: onConfirm 返回当前 selected（filter 不会影响 selected）===");
{
	let confirmed: string[] | null = null;
	const cl = new ModelChecklist({
		title: "test", items, theme: th, maxRows: 10, onConfirm: (sel) => { confirmed = sel; }, onCancel: () => {},
	});
	cl.handleInput(" ");  // 取消 m000
	cl.handleInput("\r"); // confirm
	ok("onConfirm 触发",  confirmed !== null);
	ok("onConfirm 不含 m000（被取消）",  confirmed !== null && !confirmed.includes("m000"));
	ok("onConfirm 含 m001（仍选）",     confirmed !== null && confirmed.includes("m001"));
}

console.log("\n=== Case 8: 钉住顶部首项（cursor 远离顶部时仍可见 m000）===");
{
	// maxRows=5（构造器下限为 5）。cursor 跳到 99：有效视口 = 5-1=4，hidden = 100-5=95。
	const cl = new ModelChecklist({
		title: "test", items, theme: th, maxRows: 5, onConfirm: () => {}, onCancel: () => {},
	});
	// 滚到底
	for (let i = 0; i < 99; i++) cl.handleInput("\x1b[B");
	const lines = cl.render(80);
	const out = lines.join("\n");
	ok("cursor 远离顶部 → render 含 m000 (top)", out.includes("m000  (top)"));
	ok("render 含 m099 (cursor)",                out.includes("m099"));
	ok("render 含 '95 hidden'（cursor 99，总 100，钉 1 + 视口 4）",     out.includes("95 hidden"));
	ok("cursor 仍 = 99", (cl as any).cursor === 99);
}

console.log("\n=== Case 9: 列表>maxRows 时首项始终带 (top) 标签 ===");
{
	const cl = new ModelChecklist({
		title: "test", items, theme: th, maxRows: 3, onConfirm: () => {}, onCancel: () => {},
	});
	// cursor=0, 列表 100 > maxRows=3
	const lines = cl.render(80);
	const out = lines.join("\n");
	ok("列表>maxRows 始终含 (top)", out.includes("(top)"));
	ok("含 m000", out.includes("m000"));
	ok("含 m001", out.includes("m001"));
	ok("含 m002", out.includes("m002"));
	ok("含 'more below' 提示余下项", out.includes("more below"));
	// 位置 (1/100)
	ok("render 含 (1/100) 位置", out.includes("(1/100)"));
}

console.log("\n=== Case 10: filter query 大小写不敏感 + label 匹配 ===");
{
	const cl = new ModelChecklist({
		title: "test", items, theme: th, maxRows: 10, onConfirm: () => {}, onCancel: () => {},
	});
	cl.handleInput("L");
	cl.handleInput("I");
	cl.handleInput("T");
	cl.handleInput("E");
	ok("大写 'LITE' → 匹配 2 个 (m050, m051 label 含 lite)", (cl as any).visibleItems().length === 2);
}

console.log("\n=== Case 11: 顶部始终渲染 selected/total 状态 ===");
{
	const cl = new ModelChecklist({
		title: "test", items, theme: th, maxRows: 5, onConfirm: () => {}, onCancel: () => {},
	});
	const out = cl.render(80).join("\n");
	ok("render 含 '100/100 selected' 顶部状态", out.includes("100/100 selected"));
	ok("render 含 'type to filter' footer", out.includes("type to filter"));
}

console.log("\n=== Case 12: 配置 syncViewportSize 读取 ===");
{
	const TMP_DIR = mkdtempSync(join(tmpdir(), "pi-pm-vp-test-"));
	const tmpCfg = join(TMP_DIR, "pm.json");
	(globalThis as any)[Symbol.for("pi-provider-manager:default-model-path-override")] = tmpCfg;
	const { getSyncViewportSize } = await import("./forms.ts");
	ok("不存在的配置文件 → null", getSyncViewportSize() === null);
	writeFileSync(tmpCfg, JSON.stringify({ syncViewportSize: 25 }));
	ok("syncViewportSize=25 → 25", getSyncViewportSize() === 25);
	writeFileSync(tmpCfg, JSON.stringify({ syncViewportSize: 3 }));
	ok("syncViewportSize=3 (过小) → null", getSyncViewportSize() === null);
	writeFileSync(tmpCfg, JSON.stringify({ syncViewportSize: 999 }));
	ok("syncViewportSize=999 (过大) → null", getSyncViewportSize() === null);
	writeFileSync(tmpCfg, JSON.stringify({ syncViewportSize: "30" }));
	ok("syncViewportSize 字符串 → null", getSyncViewportSize() === null);
	// 清理
	unlinkSync(tmpCfg);
	(globalThis as any)[Symbol.for("pi-provider-manager:default-model-path-override")] = undefined;
}
