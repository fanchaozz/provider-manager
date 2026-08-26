// store.ts round-trip test（用 temp 路径，不污染用户 ~/.pi/agent/models.json）

import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP_DIR = mkdtempSync(join(tmpdir(), "pi-pm-store-test-"));
const MODELS_PATH = join(TMP_DIR, "models.json");
const BAK_PATH = join(TMP_DIR, "models.json.bak");
(globalThis as any)[Symbol.for("pi-provider-manager:models-path-override")] = MODELS_PATH;
(globalThis as any)[Symbol.for("pi-provider-manager:backup-path-override")] = BAK_PATH;

import {
	readModelsJson,
	writeModelsJson,
	validateProvider,
	validateModel,
	validateAll,
	mergeProvider,
	mergeModel,
	maskApiKey,
	restoreBackup,
	backupExists,
	type ProviderConfig,
	type ModelConfig,
} from "./store.ts";

const log = (label: string, ok: boolean, extra?: string) => {
	const tag = ok ? "✓" : "✗";
	console.log(`${tag} ${label}${extra ? " — " + extra : ""}`);
	if (!ok) process.exitCode = 1;
};

async function main() {
	// 准备临时初始状态
	const initial: any = {
		providers: {
			kdapi: {
				baseUrl: "http://10.168.2.110:23000/v1",
				api: "openai-completions",
				apiKey: "sk-wOHnkJGmz14LEY3kRbTBll6Pu0XT304AiCLWX1TVJBfY4O3j",
				compat: { supportsDeveloperRole: false },
				models: [
					{
						id: "minimax-m3",
						name: "minimax-m3",
						reasoning: true,
						input: ["text"],
						contextWindow: 1_000_000,
						maxTokens: 128_000,
					},
				],
			},
		},
	};
	await writeModelsJson(initial, { backup: false });

	console.log("=== 1. read 初始 models.json ===");
	const before = await readModelsJson();
	console.log("providers:", Object.keys(before.providers));
	log("kdapi 存在", "kdapi" in before.providers);
	log("kdapi 包含 minimax-m3", before.providers.kdapi?.models?.[0]?.id === "minimax-m3");

	console.log("\n=== 2. validate 现有数据 ===");
	const v1 = validateAll(before);
	log("整体 validate ok", v1.ok, !v1.ok ? JSON.stringify(v1.errors.slice(0, 3)) : "");
	const v2 = validateProvider("kdapi", before.providers.kdapi);
	log("kdapi validate ok", v2.ok);

	console.log("\n=== 3. 错误数据 validate ===");
	const bad1 = validateProvider("", { baseUrl: 123 });
	log("空 id + 错 baseUrl 报错", !bad1.ok && bad1.errors.length >= 2);
	const bad2 = validateProvider("x", { api: "totally-not-real" });
	log("未知 api 报错", !bad2.ok && bad2.errors[0].message.includes("openai-completions"));
	const bad3 = validateModel({ id: "", contextWindow: -1 });
	log("空 id + 负 contextWindow 报错", !bad3.ok && bad3.errors.length === 2);

	console.log("\n=== 4. writeModelsJson 写回 + 备份 ===");
	const next: any = JSON.parse(JSON.stringify(before));
	if (next.providers.kdapi) {
		next.providers.kdapi.name = "kdapi (round-trip test)";
	}
	const { path, backupPath } = await writeModelsJson(next);
	log("写盘成功", true, path);
	log(".bak 存在", backupExists(), backupPath);
	const after = await readModelsJson();
	log("读回 name 修改成功", after.providers.kdapi?.name === "kdapi (round-trip test)");

	console.log("\n=== 5. mutex 串行化（5 个并发写）===");
	const tasks = Array.from({ length: 5 }, (_, i) =>
		writeModelsJson({ ...next, providers: { ...next.providers, kdapi: { ...next.providers.kdapi, name: `concurrent ${i}` } } })
			.then(() => i),
	);
	const done = await Promise.all(tasks);
	const finalState = await readModelsJson();
	log("5 个并发写都完成", done.length === 5, done.join(","));
	log("最终 state 是其中一个写者的结果", /^concurrent \d$/.test(finalState.providers.kdapi?.name ?? ""));

	console.log("\n=== 6. merge shallow ===");
	const merged = mergeProvider({ baseUrl: "x", api: "openai-completions" } as ProviderConfig, { apiKey: "secret" });
	log("merge 保留 baseUrl", merged.baseUrl === "x");
	log("merge 加 apiKey", merged.apiKey === "secret");
	log("merge 跳过 undefined", !("name" in merged));
	const mm = mergeModel({ id: "x", reasoning: true } as ModelConfig, { reasoning: undefined, contextWindow: 100000 });
	log("model merge 保留 id", mm.id === "x");
	log("model merge undefined 不覆盖", mm.reasoning === true);
	log("model merge 加新字段", mm.contextWindow === 100000);

	console.log("\n=== 7. maskApiKey ===");
	log("短 key", maskApiKey("abc") === "•••");
	log("标准 key", maskApiKey("sk-wOHnkJGmz14LEY3kRbTBll6Pu0XT304AiCLWX1TVJBfY4O3j") === "sk-w••••4O3j");
	log("空", maskApiKey(undefined) === "(none)");

	console.log("\n=== 8. 还原 + 清理 .bak ===");
	const finalBefore = await readModelsJson();
	await writeModelsJson(finalBefore, { backup: false });
	await writeModelsJson({ providers: { junk: { baseUrl: "x" } } }, { backup: true });
	await restoreBackup();
	const restored = await readModelsJson();
	log("restoreBackup 后 providers 集合匹配", Object.keys(restored.providers).join(",") === Object.keys(finalBefore.providers).join(","));
}

main().catch((err) => {
	console.error("FATAL:", err);
	process.exit(1);
});
