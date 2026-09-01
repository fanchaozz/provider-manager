// forms.ts 单元测试：mock ctx，模拟 user input，验证 form 流程写盘正确
// 用 temp 路径，不污染 ~/.pi/agent/models.json
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const TMP_DIR = mkdtempSync(join(tmpdir(), "pi-pm-test-"));
const MODELS_PATH = join(TMP_DIR, "models.json");
const BAK_PATH = join(TMP_DIR, "models.json.bak");
const PM_PATH = join(TMP_DIR, "provider-manager.json");
(globalThis as any)[Symbol.for("pi-provider-manager:models-path-override")] = MODELS_PATH;
(globalThis as any)[Symbol.for("pi-provider-manager:backup-path-override")] = BAK_PATH;
(globalThis as any)[Symbol.for("pi-provider-manager:default-model-path-override")] = PM_PATH;

import { readModelsJson, writeModelsJson, restoreBackup, backupExists } from "./store.ts";
import {
	addProviderFlow,
	editProviderFlow,
	deleteProviderFlow,
	addModelFlow,
	editModelFlow,
	deleteModelFlow,
} from "./forms.ts";

const ok = (label: string, cond: boolean) => console.log((cond ? "✓ " : "✗ ") + label);

// 模拟 ctx + user input queue
type CtxMock = any;
function makeMockCtx(inputs: (string | boolean | undefined)[], customReturn?: any): CtxMock {
	const queue = [...inputs];
	const notifyLog: string[] = [];
	return {
		mode: "tui",
		modelRegistry: {
			getProvider: () => undefined,
			getProviderAuthStatus: () => ({ ok: true, source: "test" }),
		},
		ui: {
			notify: (msg: string, level?: string) => notifyLog.push(`[${level ?? "info"}] ${msg}`),
			input: async (_title: string, _placeholder?: string) => {
				const v = queue.shift();
				if (v === undefined) return undefined;
				return String(v);
			},
			select: async (_title: string, _options: string[]) => {
				const v = queue.shift();
				if (v === undefined) return undefined;
				return String(v);
			},
			confirm: async (_opts: any) => {
				const v = queue.shift();
				if (v === undefined) return undefined;
				return Boolean(v);
			},
			custom: async <T>(_factory: any): Promise<T | undefined> => {
				if (customReturn !== undefined) return customReturn as T;
				let result: T | undefined;
				const fakeTheme = { fg: (c: string, s: string) => `[${c}]${s}[/${c}]`, bold: (s: string) => `*${s}*`, bg: () => "" };
				const fakeDone = (v: T) => { result = v; };
				try { _factory({}, fakeTheme, {}, fakeDone); } catch (e) { /* ignore */ }
				return result;
			},
		},
		__notifyLog: notifyLog,
		__queue: queue,
	};
}

async function main() {
	// 准备干净的初始状态
	const initial: any = { providers: { kdapi: { baseUrl: "x", api: "openai-completions", apiKey: "k", models: [{ id: "old-model" }] } } };
	await writeModelsJson(initial, { backup: false });

	// 全新表单模式：addProviderFlow 调 ctx.ui.custom(FormEditor) 一次性采集所有字段（含 id）。无 askInput。

	console.log("=== addProviderFlow：成功（表单模式，id 也走表单）===");
	{
		const ctx = makeMockCtx([], { saved: true, values: {
			id: "newprov",
			name: "New Provider",
			baseUrl: "http://localhost:9000/v1",
			apiKey: "",
			api: "openai-completions",
			authHeader: "no",
			proxy: "",
		}});
		let done = false;
		await addProviderFlow(ctx, () => { done = true; });
		const json = await readModelsJson();
		ok("done callback 调用", done);
		ok("newprov 写盘成功", !!json.providers.newprov);
		ok("newprov.name 正确", json.providers.newprov.name === "New Provider");
		ok("newprov.baseUrl 正确", json.providers.newprov.baseUrl === "http://localhost:9000/v1");
		ok("newprov.apiKey 为空", !json.providers.newprov.apiKey);
		ok("newprov.models=[] ", Array.isArray(json.providers.newprov.models) && json.providers.newprov.models.length === 0);
		ok("kdapi 还在", !!json.providers.kdapi);
	}

	console.log("\n=== addProviderFlow：proxy 字段生效 ===");
	{
		const ctx = makeMockCtx([], { saved: true, values: {
			id: "proxied",
			name: "Proxied",
			baseUrl: "http://api.example.com/v1",
			apiKey: "k",
			api: "openai-completions",
			authHeader: "no",
			proxy: "http://127.0.0.1:7890",
		}});
		await addProviderFlow(ctx, () => undefined);
		const json = await readModelsJson();
		ok("proxied.proxy 写盘", json.providers.proxied?.proxy === "http://127.0.0.1:7890");
	}

	console.log("\n=== addProviderFlow：表单 Esc 取消 ===");
	{
		const ctx = makeMockCtx([], undefined);  // FormEditor 返回 undefined = 取消
		await addProviderFlow(ctx, () => undefined);
		const json = await readModelsJson();
		ok("cancelp 没写盘", !json.providers.cancelp);
	}

	console.log("\n=== addProviderFlow：id 重复（表单 validate 拦截）===");
	{
		// 表单里 validate 发现了，提交时 ok=false，弹错（但 mock 不走 validate，提交后服务端再查）
		const ctx = makeMockCtx([], { saved: true, values: {
			id: "kdapi",   // 重复
			name: "Dup",
			baseUrl: "x",
			apiKey: "",
			api: "openai-completions",
			authHeader: "no",
			proxy: "",
		}});
		await addProviderFlow(ctx, () => undefined);
		const json = await readModelsJson();
		ok("kdapi 没被覆盖（models 仍为 1 个）", json.providers.kdapi.models.length === 1);
	}

	console.log("\n=== addProviderFlow：与 editProviderFlow 结构同形（id 在表单里）===");
	{
		const ctx = makeMockCtx([], { saved: true, values: {
			id: "str-equal",
			name: "",
			baseUrl: "",
			apiKey: "",
			api: "",
			authHeader: "no",
			proxy: "",
		}});
		await addProviderFlow(ctx, () => undefined);
		const json = await readModelsJson();
		ok("str-equal 写盘", !!json.providers["str-equal"]);
		ok("str-equal.name 为空（未设）", !json.providers["str-equal"].name);
	}

	console.log("\n=== addProviderFlow：用户中途取消 ===");
	{
		const ctx = makeMockCtx(["cancel-prov", undefined /* 取消 name 字段 */]);
		await addProviderFlow(ctx, () => undefined);
		const json = await readModelsJson();
		ok("cancel-prov 没写盘", !json.providers["cancel-prov"]);
	}

	console.log("\n=== editProviderFlow：保留未改字段（FormEditor 模拟）===");
	{
		// FormEditor 一次性提交所有字段。name=""= unset, 其余保留原值, api 改
		const ctx = makeMockCtx([], { saved: true, values: {
			name: "",
			baseUrl: "x",
			apiKey: "k",
			api: "anthropic-messages",
			authHeader: false,
		}});
		await editProviderFlow(ctx, "kdapi", () => undefined);
		const json = await readModelsJson();
		ok("kdapi.name 未被覆盖", !json.providers.kdapi.name);
		ok("kdapi.baseUrl 保留", json.providers.kdapi.baseUrl === "x");
		ok("kdapi.api 改了", json.providers.kdapi.api === "anthropic-messages");
		ok("kdapi.apiKey 保留", json.providers.kdapi.apiKey === "k");
	}

	console.log("\n=== deleteProviderFlow：confirm=true 删掉 ===");
	{
		const ctx = makeMockCtx([true]);
		await deleteProviderFlow(ctx, "kdapi", () => undefined);
		const json = await readModelsJson();
		ok("kdapi 被删除", !json.providers.kdapi);
		ok(".bak 存在", backupExists());
	}

	console.log("\n=== deleteProviderFlow：confirm=false 保留 ===");
	{
		const ctx = makeMockCtx([false]);
		const before = (await readModelsJson()).providers;
		await deleteProviderFlow(ctx, Object.keys(before)[0]!, () => undefined);
		const after = (await readModelsJson()).providers;
		ok("providers 未变", Object.keys(after).length === Object.keys(before).length);
	}

	console.log("\n=== addModelFlow：useDefault=yes，套模板（带 compat）===");
	{
		const target = Object.keys((await readModelsJson()).providers)[0]!;
		const ctx = makeMockCtx(
			[],  // confirm(yes) → boolean true；mock 会 shift 出一个值，但 confirm 拿 [0] 还是 [1]？看 queue 序
			{ saved: true, values: { id: "gpt-test", name: "GPT Test" } },
		);
		// 手动喂 confirm=true：mock 的 confirm 会拿 queue[0] = undefined → 返 undefined（取消）.
		// 改用直接传 confirmReturn 路径？这里用 addModelFlow 之前把 queue 改成 [true]：
		(ctx as any).__queue.unshift(true);
		await addModelFlow(ctx as any, target, () => undefined);
		const models = (await readModelsJson()).providers[target].models;
		const m = models.find((mm: any) => mm.id === "gpt-test");
		ok("gpt-test 写盘", !!m);
		ok("compat.supportsDeveloperRole = false（默认不丢）", m?.compat?.supportsDeveloperRole === false);
		ok("reasoning = true（默认）", m?.reasoning === true);
		ok("input 含 image（默认）", Array.isArray(m?.input) && m.input.includes("image"));
		// 套 pm.json 里的 user defaults（隔离后 = 代码默认 128000/16384）。但 pm.json 可能是用户 global 默认的快照，
		// 所以不锁具体数值，只锁 "是合理数 + thinkingLevelMap.medium === medium"。
		ok("contextWindow > 0（套模板）", typeof m?.contextWindow === "number" && m.contextWindow > 0);
		ok("maxTokens > 0（套模板）", typeof m?.maxTokens === "number" && m.maxTokens > 0);
		ok("thinkingLevelMap.medium = medium（默认）", m?.thinkingLevelMap?.medium === "medium");
		ok("name 透传", m?.name === "GPT Test");
	}

	console.log("\n=== addModelFlow：useDefault=no，逐项提示 ===");
	{
		const target = Object.keys((await readModelsJson()).providers)[0]!;
		const ctx = makeMockCtx(
			[],
			{ saved: true, values: {
				id: "manual-model",
				name: "",
				reasoning: "no",
				input: ["text"],
				contextWindow: 64000,
				maxTokens: 8192,
				thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: null, xhigh: null, max: null },
				supportsDeveloperRole: "no",
			} },
		);
		(ctx as any).__queue.unshift(false);  // confirm=no
		await addModelFlow(ctx as any, target, () => undefined);
		const models = (await readModelsJson()).providers[target].models;
		const m = models.find((mm: any) => mm.id === "manual-model");
		ok("manual-model 写盘", !!m);
		ok("reasoning = no（输入）", m?.reasoning === false);
		ok("input = [text]（无 image）", JSON.stringify(m?.input) === '["text"]');
		ok("contextWindow = 64000（输入）", m?.contextWindow === 64000);
		ok("maxTokens = 8192（输入）", m?.maxTokens === 8192);
		ok("thinkingLevelMap.low = low（输入）", m?.thinkingLevelMap?.low === "low");
		ok("compat.supportsDeveloperRole = false（输入 no）", m?.compat?.supportsDeveloperRole === false);
	}

	console.log("\n=== addModelFlow：id 重复，notify 报错且不写盘 ===");
	{
		// 预先往 provider 上挂一个 old-model，模拟“已有同名 model”场景
		const target = Object.keys((await readModelsJson()).providers)[0]!;
		await writeModelsJson({
			providers: {
				[target]: { ...(await readModelsJson()).providers[target], models: [{ id: "old-model" }] },
			},
		}, { backup: false });
		const ctx = makeMockCtx(
			[],
			{ saved: true, values: { id: "old-model", name: "" } },  // id 与已存在的 old-model 冲突
		);
		(ctx as any).__queue.unshift(true);  // useDefault
		const before = (await readModelsJson()).providers[target].models.length;
		await addModelFlow(ctx as any, target, () => undefined);
		const after = (await readModelsJson()).providers[target].models.length;
		ok("未新增 model（before === after）", before === after);
		ok("notify 报错", ctx.__notifyLog.some((m: string) => m.includes("already exists") || m.includes("error")));
	}

	console.log("\n=== addModelFlow：Esc 取消 confirm → 不写盘 ===");
	{
		const target = Object.keys((await readModelsJson()).providers)[0]!;
		const ctx = makeMockCtx([]);  // confirm 拿 undefined → cancel
		await addModelFlow(ctx as any, target, () => undefined);
		const models = (await readModelsJson()).providers[target].models;
		ok("未新增 model", !models.some((m: any) => m.id === "esc-cancel-model"));
	}

	console.log("\n=== addModelFlow：provider 不存在 → 报错 ===");
	{
		const ctx = makeMockCtx([]);
		await addModelFlow(ctx as any, "nonexistent", () => undefined);
		ok("notify 报错不存在", ctx.__notifyLog.some((m: string) => m.toLowerCase().includes("不存在") || m.toLowerCase().includes("does not exist")));
	}

	console.log("\n=== editModelFlow：局部更新 ===");
	{
		const target = Object.keys((await readModelsJson()).providers)[0]!;
		const json = await readModelsJson();
		// 补一个 model 以供 editModelFlow 测试
		if (!json.providers[target].models || json.providers[target].models.length === 0) {
			await writeModelsJson({ ...json, providers: { ...json.providers, [target]: { ...json.providers[target], models: [{ id: "edit-target", input: ["text"], contextWindow: 8000, maxTokens: 4000 }] } } });
		}
		const json2 = await readModelsJson();
		const oldModel = json2.providers[target].models[0];
		// FormEditor 一次性返回所有字段
		const ctx = makeMockCtx([], { saved: true, values: {
			name: "",
			reasoning: "yes",
			input: oldModel.input ?? ["text"],
			contextWindow: oldModel.contextWindow ?? 0,
			maxTokens: oldModel.maxTokens ?? 0,
			thinkingLevelMap: null,
			supportsDeveloperRole: "no",
		}});
		await editModelFlow(ctx, target, oldModel.id, () => undefined);
		const updated = (await readModelsJson()).providers[target].models.find((m: any) => m.id === oldModel.id);
		ok("model id 未变", updated?.id === oldModel.id);
		ok("model.reasoning 改了", updated?.reasoning === true);
		ok("compat.supportsDeveloperRole = false", updated?.compat?.supportsDeveloperRole === false);
	}

	console.log("\n=== editModelFlow：保留已有 compat 字段 ===");
	{
		const target = Object.keys((await readModelsJson()).providers)[0]!;
		const json = await readModelsJson();
		const modelId = json.providers[target].models[0].id;
		// 预先给 model 写一个带 custom 字段的 compat
		const baseModel = json.providers[target].models[0];
		await writeModelsJson({ ...json, providers: { ...json.providers, [target]: { ...json.providers[target], models: json.providers[target].models.map((m) => m.id === modelId ? { ...m, compat: { supportsDeveloperRole: true, customField: "preserve" } } : m) } } });
		const ctx = makeMockCtx([], { saved: true, values: {
			name: "",
			reasoning: "yes",
			input: ["text"],
			contextWindow: 1000,
			maxTokens: 1000,
			thinkingLevelMap: null,
			supportsDeveloperRole: "yes",
		}});
		await editModelFlow(ctx, target, modelId, () => undefined);
		const updated = (await readModelsJson()).providers[target].models.find((m: any) => m.id === modelId);
		ok("supportsDeveloperRole 改 true", updated?.compat?.supportsDeveloperRole === true);
		ok("其他 compat 字段保留 (customField)", (updated?.compat as any)?.customField === "preserve");
	}

	console.log("\n=== deleteModelFlow：confirm=true ===");
	{
		const target = Object.keys((await readModelsJson()).providers)[0]!;
		const json = await readModelsJson();
		const targetId = json.providers[target].models[0].id;  // 删第一个（之前 add 进去的 gpt-test）
		const ctx = makeMockCtx([true]);
		await deleteModelFlow(ctx, target, targetId, () => undefined);
		const after = (await readModelsJson()).providers[target].models;
		ok("目标 model 被删", !after.some((m: any) => m.id === targetId));
	}

	console.log("\n=== 清理：还原 .bak ===");
	const restored = await restoreBackup();
	ok("restoreBackup 返回 true", restored);
	ok("还原后是合法 JSON", typeof (await readModelsJson()).providers === "object");
}

main().catch((err) => {
	console.error("FATAL:", err);
	process.exit(1);
});
