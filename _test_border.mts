// box() 外边框测试：3 个 overlay 组件（Dashboard / FormEditor / ModelChecklist）
// 都用 box() 包了外框，验证：边框存在 + 4 角 + 边线 + title 在顶框中部
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP = mkdtempSync(join(tmpdir(), "pi-pm-border-"));
const MODELS_PATH = join(TMP, "models.json");
const BAK_PATH = join(TMP, "models.json.bak");
(globalThis as any)[Symbol.for("pi-provider-manager:models-path-override")] = MODELS_PATH;
(globalThis as any)[Symbol.for("pi-provider-manager:backup-path-override")] = BAK_PATH;

writeFileSync(MODELS_PATH, JSON.stringify({
  providers: {
    kdapi: { baseUrl: "http://x", api: "openai-completions", apiKey: "sk", models: [{ id: "m1" }] },
  },
}, null, 2));

import { box } from "./components.ts";
import { Dashboard } from "./ui.ts";
import { FormEditor, ModelChecklist } from "./components.ts";

const ok = (label: string, cond: boolean) => {
  const tag = cond ? "✓" : "✗";
  console.log(`${tag} ${label}`);
  if (!cond) process.exitCode = 1;
};

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const th = {
  fg: (c: string, s: string) => `\x1b[38;5;${(Math.abs(c.length * 17) % 200) + 20}m${s}\x1b[39m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  bg: (_c: string, s: string) => s,
};

async function main() {
  console.log("=== box() 直接调用 ===");
  {
    const out = box(th, 20, "test", ["hello", "world"]);
    ok("box 输出 4 行（顶 + 2 content + 底）",  out.length === 4);
    const stripped = strip(out[0]!);
    ok("顶行有 ┌",  stripped.startsWith("┌"));
    ok("顶行有 ┐",  stripped.endsWith("┐"));
    ok("顶行含 test",  /test/.test(stripped));
    ok("底行以 ┘ 结尾",  strip(out[3]!).endsWith("┘"));
    ok("底行以 ┌ 开头",  strip(out[3]!).startsWith("└"));
    const mid = strip(out[1]!);
    ok("中间行以 │ 开头",  mid.startsWith("│"));
    ok("中间行以 │ 结尾",  mid.endsWith("│"));
    ok("中间行含 hello",  /hello/.test(mid));
  }

  console.log("\n=== box() 无 title 也能跑 ===");
  {
    const out = box(th, 15, "", ["line1"]);
    ok("无 title 顶行纯横线",  strip(out[0]!).startsWith("┌") && strip(out[0]!).endsWith("┐"));
  }

  console.log("\n=== box() 太窄时不画框（不爆框）===");
  {
    const out = box(th, 4, "x", ["y"]);
    ok("width=4 直接返回 content（1 行）",  out.length === 1);
  }

  console.log("\n=== Dashboard 浮窗外框 ===");
  {
    const d = new Dashboard({ mode: "tui", modelRegistry: { getProviderDisplayName: (id: string) => id } } as any, th, () => {}, {
      providerViewRows: 6, modelViewRows: 6, detailViewRows: 10,
    });
    await d.init();
    const lines = d.render(96);
    const stripped = strip(lines.join("\n"));
    ok("dashboard 顶行有 ┌",  stripped.split("\n")[0]!.startsWith("┌"));
    ok("dashboard 末行有 └",  stripped.split("\n").at(-1)!.startsWith("└"));
    ok("dashboard 顶行含 provider-manager",  /provider-manager/.test(stripped.split("\n")[0]!));
    // 中间每行都以 │ 开头、以 │ 结尾
    const middle = lines.slice(1, -1);
    const allBoxed = middle.every(l => {
      const s = strip(l);
      return s.startsWith("│") && s.endsWith("│");
    });
    ok("dashboard 中间所有行都有 │ 边框",  allBoxed);
  }

  console.log("\n=== FormEditor 浮窗外框 ===");
  {
    const fe = new FormEditor({
      title: "Test Form",
      fields: [
        { key: "id", label: "id", type: "text" },
        { key: "name", label: "name", type: "text" },
      ],
      initial: { id: "abc", name: "" },
      theme: th,
      onSave: () => {},
      onCancel: () => {},
    });
    const lines = fe.render(60);
    const stripped = strip(lines.join("\n"));
    ok("FormEditor 顶行有 ┌",  stripped.split("\n")[0]!.startsWith("┌"));
    ok("FormEditor 末行有 └",  stripped.split("\n").at(-1)!.startsWith("└"));
    ok("FormEditor 顶行含 Test Form",  /Test Form/.test(stripped.split("\n")[0]!));
    const middle = lines.slice(1, -1);
    const allBoxed = middle.every(l => {
      const s = strip(l);
      return s.startsWith("│") && s.endsWith("│");
    });
    ok("FormEditor 中间所有行都有 │ 边框",  allBoxed);
  }

  console.log("\n=== ModelChecklist 浮窗外框 ===");
  {
    const items = [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ];
    const mc = new ModelChecklist({
      title: "Sync test",
      items,
      theme: th,
      onConfirm: () => {},
      onCancel: () => {},
    });
    const lines = mc.render(60);
    const stripped = strip(lines.join("\n"));
    ok("ModelChecklist 顶行有 ┌",  stripped.split("\n")[0]!.startsWith("┌"));
    ok("ModelChecklist 末行有 └",  stripped.split("\n").at(-1)!.startsWith("└"));
    ok("ModelChecklist 顶行含 Sync test",  /Sync test/.test(stripped.split("\n")[0]!));
    const middle = lines.slice(1, -1);
    const allBoxed = middle.every(l => {
      const s = strip(l);
      return s.startsWith("│") && s.endsWith("│");
    });
    ok("ModelChecklist 中间所有行都有 │ 边框",  allBoxed);
  }

  console.log("\n=== 边线宽度自适应 ===");
  {
    // 同一 dashboard 渲染不同宽度，每行应有正确的 │ 边框
    for (const w of [60, 80, 100, 120, 140]) {
      const d = new Dashboard({ mode: "tui", modelRegistry: { getProviderDisplayName: (id: string) => id } } as any, th, () => {}, {
        providerViewRows: 6, modelViewRows: 6, detailViewRows: 10,
      });
      await d.init();
      const lines = d.render(w);
      const first = strip(lines[0]!);
      const last = strip(lines.at(-1)!);
      // 顶/底行可见宽度应 == w
      const fw = first.length;
      const lw = last.length;
      ok(`width=${w} 时顶/底行可见宽 = ${w}（实 ${fw}/${lw}）`,  fw === w && lw === w);
      const mid = strip(lines[3]!);
      ok(`width=${w} 中间行可见宽 = ${w}（实 ${mid.length}）`, mid.length === w);
    }
  }

  console.log("\n=== 边线不破坏内容（边框内是真实内容）===");
  {
    const d = new Dashboard({ mode: "tui", modelRegistry: { getProviderDisplayName: (id: string) => id } } as any, th, () => {});
    await d.init();
    const lines = d.render(96);
    const joined = strip(lines.join("\n"));
    ok("外框内仍含 provider 名 kdapi",  /kdapi/.test(joined));
    ok("外框内仍含 model 名 m1",  /m1/.test(joined));
    ok("外框内仍含 stats (1P · 1M)",  /1P\s*·\s*1M/.test(joined));
  }
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });
