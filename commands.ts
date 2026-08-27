/**
 * commands.ts — /providers 子命令派发
 *
 * 单一 /providers 命令，按 args 首词派发到子命令。
 * 子命令列表见 printHelp()。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readModelsJson } from "./store.ts";
import { openDashboard } from "./ui.ts";
import {
	addProviderFlow,
	deleteProviderFlow,
	restoreFromBackupFlow,
	syncFlow,
} from "./forms.ts";

// 覆盖范围：仅 models.json 里的自定义 provider。内置 provider 走 pi 的 /model
const STUBS = new Set(["test", "test-all"]);

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("providers", {
		description: "Manage providers and models in ~/.pi/agent/models.json",
		getArgumentCompletions: (prefix: string) => {
			const subs = ["ls", "add", "remove", "sync", "test", "test-all", "reset", "help"];
			const filtered = subs.filter((s) => s.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim();
			const sub = trimmed.split(/\s+/)[0] ?? "";
			const rest = trimmed.slice(sub.length).trim();

			switch (sub) {
				case "":
				case "ui":
				case "dashboard":
					await openDashboard(ctx);
					return;
				case "ls":
					await cmdLs(rest, ctx);
					return;
				case "help":
				case "-h":
				case "--help":
					cmdHelp(ctx);
					return;
				case "add": {
					if (ctx.mode !== "tui") { ctx.ui.notify("/providers add 需要 TUI 模式。打开 /providers 后按 n", "warning"); return; }
					if (rest) ctx.ui.notify(`将在表单中输入 id="${rest}"`, "info");
					await addProviderFlow(ctx, () => undefined);
					return;
				}
				case "remove": {
					const id = rest.trim();
					if (!id) { ctx.ui.notify("用法: /providers remove <id>", "warning"); return; }
					await deleteProviderFlow(ctx, id, () => undefined);
					return;
				}
				case "reset": {
					await restoreFromBackupFlow(ctx, () => undefined);
					return;
				}
				case "sync": {
					if (ctx.mode !== "tui") { ctx.ui.notify("/providers sync 需要 TUI 模式。打开 /providers 后按 y，或传 <provider-id> 选 source", "warning"); return; }
					await syncFlow(ctx, { sourceProviderId: rest.trim() || undefined });
					return;
				}
				case "test-all": {
					await testAllCommand(ctx, rest.trim() || undefined);
					return;
				}
				case "test": {
					await testCommand(ctx, rest.trim());
					return;
				}
				default: {
					if (STUBS.has(sub)) {
						ctx.ui.notify(`/providers ${sub} 暂未实现（plan 后续步骤）`, "info");
					} else {
						ctx.ui.notify(`未知子命令: ${sub}。/providers help 查看帮助`, "error");
					}
				}
			}
		},
	});
}

// ---------------------------------------------------------------------------
// /providers ls [filter]
// ---------------------------------------------------------------------------

async function cmdLs(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const filter = args.trim().toLowerCase();

	// 只读 models.json（自定义 provider）
	const json = await readModelsJson();
	const allProviderIds = Object.keys(json.providers).sort();

	const matchesFilter = (id: string) => !filter || id.toLowerCase().includes(filter);
	const matchedIds = allProviderIds.filter(matchesFilter);

	if (matchedIds.length === 0) {
		ctx.ui.notify(`没有匹配 "${filter}" 的 provider`, "warning");
		return;
	}

	// 主列表：provider 概要
	const lines: string[] = [];
	lines.push(`Custom providers in models.json (${matchedIds.length}${filter ? `, filter="${filter}"` : ""})`);
	lines.push("─".repeat(60));
	for (const pid of matchedIds) {
		const prov = json.providers[pid];
		const modelCount = prov?.models?.length ?? 0;
		lines.push(`  ${pid}  — ${modelCount} model(s)`);
	}

	// 详情：每个 provider 的 model 列表
	lines.push("");
	lines.push("Models");
	lines.push("─".repeat(60));
	for (const pid of matchedIds) {
		const prov = json.providers[pid];
		const providerModels = prov?.models ?? [];
		if (providerModels.length === 0) {
			lines.push(`  ${pid}: (none)`);
			continue;
		}
		lines.push(`  ${pid}:`);
		for (const m of providerModels) {
			const ctx2 = m.contextWindow ? `${formatNum(m.contextWindow)} ctx` : "? ctx";
			const max2 = m.maxTokens ? `${formatNum(m.maxTokens)} max` : "? max";
			const flags = [m.reasoning && "reasoning", m.input?.includes("image") && "vision"].filter(Boolean).join(" ");
			lines.push(`    • ${m.id}${flags ? ` [${flags}]` : ""} (${ctx2}, ${max2})`);
		}
	}

	const out = lines.join("\n");

	// print / rpc 模式：走 console.log（headless 下能直接看）
	// TUI 模式：console.log 会破坏 TUI 屏幕，改用 select 列表
	if (ctx.mode === "tui") {
		const selected = await ctx.ui.select(`${matchedIds.length} provider(s)`, lines).catch(() => undefined);
		if (selected) {
			// 尝试解析选中的行：provider 概要行 / model bullet 行
			// provider 概要行： "  ${pid}  — ${count} model(s)"
			// provider section header： "  ${pid}:"
			// model bullet：      "    • ${modelId} ..."
			const providerHeader = selected.match(/^\s+(\S+):\s*$/);
			const providerSummary = selected.match(/^\s+(\S+)\s+—\s+\d+\s+model\(s\)\s*$/);
			if (providerHeader || providerSummary) {
				const pid = (providerHeader ?? providerSummary)![1]!;
				if (json.providers[pid]) {
					await showProviderModels(ctx, pid);
				}
			}
			// model 行 / header 行 / 分隔符：只关闭，do nothing
		}
	} else {
		console.log(out);
	}
}

/** 只显示一个 provider 的 models（被 cmdLs drill-down 调用） */
async function showProviderModels(ctx: ExtensionCommandContext, providerId: string): Promise<void> {
	const json = await readModelsJson();
	const prov = json.providers[providerId];
	if (!prov) { ctx.ui.notify(`Provider "${providerId}" does not exist.`, "error"); return; }
	const models = prov.models ?? [];
	const lines: string[] = [];
	lines.push(`Models of "${providerId}" (${models.length})`);
	lines.push("─".repeat(60));
	if (models.length === 0) {
		lines.push("  (no models)");
	} else {
		for (const m of models) {
			const ctx2 = m.contextWindow ? `${formatNum(m.contextWindow)} ctx` : "? ctx";
			const max2 = m.maxTokens ? `${formatNum(m.maxTokens)} max` : "? max";
			const flags = [m.reasoning && "reasoning", m.input?.includes("image") && "vision"].filter(Boolean).join(" ");
			lines.push(`  • ${m.id}${flags ? ` [${flags}]` : ""} (${ctx2}, ${max2})`);
		}
	}
	if (ctx.mode === "tui") {
		await ctx.ui.select(`models of "${providerId}"`, lines).catch(() => undefined);
	} else {
		console.log(lines.join("\n"));
	}
}

function formatNum(n: number | undefined): string {
	if (n == null) return "?";
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(0) + "M";
	if (n >= 1_000) return (n / 1_000).toFixed(0) + "k";
	return String(n);
}

// ---------------------------------------------------------------------------
// /providers help
// ---------------------------------------------------------------------------

function cmdHelp(ctx: ExtensionCommandContext): void {
	const lines = [
		"provider-manager — Manage ~/.pi/agent/models.json",
		"",
		"Usage:",
		"  /providers                  Open TUI dashboard",
		"  /providers ls [filter]      List providers and their models",
		"  /providers add <id>         Add a new provider (TUI: open dashboard, press n)",
		"  /providers remove <id>      Remove a provider (with confirm)",
		"  /providers sync [provider-id]  Pick a provider (or pass id), fetch remote models, multi-select, write back. TUI: y on selected provider.",
		"  /providers test <provider>/<model>  Test model (auth + reachable + 1-shot generation). TUI: t on selected model.",
		"  /providers test-all [provider]      Batch test all models of a provider (concurrency 3). TUI: T on selected provider.",
		"  /providers reset            Restore models.json.bak (with confirm)",
		"  /providers help             This help",
		"",
		"Models can only be added/removed via sync (y on a provider).",
		"Switching models is NOT done by this extension — use Ctrl+L or /model.",
	];
	const out = lines.join("\n");
	console.log(out);
	if (ctx.mode === "tui") {
		// TUI 模式弹 toast + 全屏 select 让用户可滚动
		void ctx.ui.select("provider-manager help", lines).catch(() => undefined);
	}
}

// ---------------------------------------------------------------------------
// /providers test <provider>/<model>  |  /providers test-all [provider]
// ---------------------------------------------------------------------------

import { testModel, testProvider, formatTestResult } from "./test.ts";

/** 测单个 model：arg 支持 "<provider>/<model>" 或 "<model>"（缺省走 models.json 里第一个 provider）。 */
async function testCommand(ctx: ExtensionCommandContext, arg: string): Promise<void> {
	const json = await readModelsJson();
	const m = arg.match(/^([^/\s]+)\/([^/\s]+)$/);
	let provider: string;
	let model: string;
	if (m) {
		provider = m[1];
		model = m[2];
	} else if (arg) {
		// arg 是 model id；provider 用 models.json 里第一个包含该 model 的
		const entry = Object.entries(json.providers).find(([, p]) => (p.models ?? []).some((mm: any) => mm.id === arg));
		if (!entry) {
			ctx.ui.notify(`未找到 model "${arg}"。用法: /providers test <provider>/<model>`, "error");
			return;
		}
		provider = entry[0];
		model = arg;
	} else {
		ctx.ui.notify("用法: /providers test <provider>/<model>，或 /providers test <model>", "warning");
		return;
	}

	if (!json.providers[provider]) {
		ctx.ui.notify(`provider "${provider}" 不在 models.json 中`, "error");
		return;
	}

	const result = await testModel({ ctx: ctx as any, provider, model, mode: "full" });
	// 同步 dashboard：测试结果统一 info（showStatus 可覆盖），失败语义靠文本 ✗ fail 前缀表达
	ctx.ui.notify(formatTestResult(result), "info");
}

/** 批量测某 provider 全部 model；无参数时取第一个 provider。 */
async function testAllCommand(ctx: ExtensionCommandContext, providerId: string | undefined): Promise<void> {
	const json = await readModelsJson();
	let provider: string;
	if (providerId) {
		if (!json.providers[providerId]) {
			ctx.ui.notify(`provider "${providerId}" 不在 models.json 中`, "error");
			return;
		}
		provider = providerId;
	} else {
		const ids = Object.keys(json.providers);
		if (ids.length === 0) {
			ctx.ui.notify("models.json 中无 provider", "warning");
			return;
		}
		provider = ids[0]!;
	}
	const prov = json.providers[provider]!;
	const modelIds = (prov.models ?? []).map((m: any) => m.id);
	if (modelIds.length === 0) {
		ctx.ui.notify(`provider "${provider}" 无 model`, "warning");
		return;
	}

	ctx.ui.notify(`testing ${modelIds.length} model(s) of "${provider}"...`, "info");
	const results = await testProvider({
		ctx: ctx as any,
		provider,
		modelIds,
		mode: "full",
		concurrency: 3,
	});
	// 批量结果拼成一条 notify：逐条 notify 会被 showStatus 原地覆盖，只残留最后一条
	const okCount = results.filter((r) => r.ok).length;
	const summary = results.map((r) => formatTestResult(r)).join("\n\n") + `\n${provider}: ${okCount}/${results.length} ok`;
	ctx.ui.notify(summary, "info");
}
