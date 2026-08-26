// ensureDefaultConfigFile 测试
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP_DIR = mkdtempSync(join(tmpdir(), "pi-pm-ensure-"));
const MODELS_PATH = join(TMP_DIR, "models.json");
const BAK_PATH = join(TMP_DIR, "models.json.bak");
const CFG_PATH = join(TMP_DIR, "provider-manager.json");
(globalThis as any)[Symbol.for("pi-provider-manager:models-path-override")] = MODELS_PATH;
(globalThis as any)[Symbol.for("pi-provider-manager:backup-path-override")] = BAK_PATH;
(globalThis as any)[Symbol.for("pi-provider-manager:default-model-path-override")] = CFG_PATH;

import { ensureDefaultConfigFile, getDefaultModelConfigPath, loadDefaultModelConfig, DEFAULT_MODEL_CONFIG } from "./forms.ts";

const ok = (label: string, cond: boolean) => console.log((cond ? "✓ " : "✗ ") + label);

async function main() {
	// 1. 文件不存在 → 创建
	console.log("=== 文件不存在 → 自动创建 ===");
	ok("文件不存在", !existsSync(CFG_PATH));
	const p1 = ensureDefaultConfigFile();
	ok("返回写入路径", p1 === CFG_PATH);
	ok("文件已创建", existsSync(CFG_PATH));
	const content = JSON.parse(readFileSync(CFG_PATH, "utf8"));
	ok("含 defaultModel 字段", content.defaultModel !== undefined);
	ok("defaultModel.reasoning = true", content.defaultModel.reasoning === true);
	ok("defaultModel.input = [text,image]", JSON.stringify(content.defaultModel.input) === '["text","image"]');
	ok("defaultModel.thinkingLevelMap.medium = medium", content.defaultModel.thinkingLevelMap.medium === "medium");
	ok("defaultModel.thinkingLevelMap.xhigh = null", content.defaultModel.thinkingLevelMap.xhigh === null);

	// 2. 文件存在 → 不覆盖
	console.log("\n=== 文件已存在 → 不覆盖 ===");
	writeFileSync(CFG_PATH, JSON.stringify({ defaultModel: { reasoning: false, input: ["text"], contextWindow: 999, maxTokens: 99, thinkingLevelMap: {} } }));
	const p2 = ensureDefaultConfigFile();
	ok("返回 null（无写入）", p2 === null);
	const after = JSON.parse(readFileSync(CFG_PATH, "utf8"));
	ok("原内容保留（reasoning=false）", after.defaultModel.reasoning === false);
	ok("原内容保留（contextWindow=999）", after.defaultModel.contextWindow === 999);

	// 3. loadDefaultModelConfig 读取新文件
	console.log("\n=== loadDefaultModelConfig 读新文件 ===");
	const cfg = loadDefaultModelConfig();
	ok("读到 user 覆盖（reasoning=false）", cfg.reasoning === false);
	ok("读到 user 覆盖（contextWindow=999）", cfg.contextWindow === 999);

	// 4. 文件被删 → 下次加载 fallback 到 code default
	console.log("\n=== 文件被删 → loadDefaultModelConfig fallback ===");
	rmSync(CFG_PATH);
	const cfg2 = loadDefaultModelConfig();
	ok("fallback 到 code default (reasoning=true)", cfg2.reasoning === true);
	ok("fallback 到 code default (medium=medium)", cfg2.thinkingLevelMap.medium === "medium");

	// 5. 重新 ensure → 重建
	console.log("\n=== 文件被删后重新 ensure ===");
	const p3 = ensureDefaultConfigFile();
	ok("重建", p3 === CFG_PATH);
	ok("文件重新存在", existsSync(CFG_PATH));

	// 6. 文件内容非法 → loadDefaultModelConfig 仍 fallback
	console.log("\n=== 文件内容非法 → fallback ===");
	writeFileSync(CFG_PATH, "{ not valid json");
	const cfg3 = loadDefaultModelConfig();
	ok("fallback 到 code default (reasoning=true)", cfg3.reasoning === true);

	// 7. ensureDefaultConfigFile 自身容错
	console.log("\n=== ensureDefaultConfigFile 错误不抛 ===");
	writeFileSync(CFG_PATH, "{}");  // valid JSON but no defaultModel
	const p4 = ensureDefaultConfigFile();
	ok("文件已存在 → 返回 null", p4 === null);

	rmSync(TMP_DIR, { recursive: true, force: true });
	console.log("\n=== 完成 ===");
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
