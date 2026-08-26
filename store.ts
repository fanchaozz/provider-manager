/**
 * store.ts — models.json 读写 + 校验 + 备份 + 合并
 *
 * 单一职责：所有对 ~/.pi/agent/models.json 的写盘都走这里。
 * - atomic write（tmp + rename）
 * - 写前自动 .bak
 * - 单例 write mutex（防止 TUI 编辑和 LLM 工具并发写）
 * - hand-rolled 校验（pi 不导出 schema 运行时，TypeBox 留待后续）
 */

import { readFile, writeFile, rename, copyFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Types
// ============================================================================

export type ApiType =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "azure-openai-responses"
  | "openai-codex-responses"
  | "mistral-conversations"
  | "bedrock-converse-stream";

export const ALLOWED_APIS: readonly ApiType[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "azure-openai-responses",
  "openai-codex-responses",
  "mistral-conversations",
  "bedrock-converse-stream",
];

export type ModelConfig = {
  id: string;
  name?: string;
  api?: ApiType | string;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;
  input?: Array<"text" | "image">;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    tiers?: Array<{ inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }>;
  };
  contextWindow?: number;
  maxTokens?: number;
  samplingParams?: Record<string, unknown>;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
};

export type ModelOverrideConfig = Partial<Omit<ModelConfig, "id">>;

export type ProviderConfig = {
  name?: string;
  baseUrl?: string;
  api?: ApiType | string;
  apiKey?: string;
  oauth?: "radius";
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  authHeader?: boolean;
  proxy?: string;
  models?: ModelConfig[];
  modelOverrides?: Record<string, ModelOverrideConfig>;
};

export type ModelsJson = { providers: Record<string, ProviderConfig> };

// ============================================================================
// Paths
// ============================================================================

export function getModelsJsonPath(): string {
	const ov = (globalThis as any)[Symbol.for("pi-provider-manager:models-path-override")] as string | undefined;
	if (ov) return ov;
	return join(getAgentDir(), "models.json");
}

export function getBackupPath(): string {
	const ov = (globalThis as any)[Symbol.for("pi-provider-manager:backup-path-override")] as string | undefined;
	if (ov) return ov;
	return join(getAgentDir(), "models.json.bak");
}

// ============================================================================
// Read
// ============================================================================

export async function readModelsJson(): Promise<ModelsJson> {
  const path = getModelsJsonPath();
  if (!existsSync(path)) return { providers: {} };
  const text = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`models.json 不是合法 JSON: ${err instanceof Error ? err.message : err}`);
  }
  if (!parsed || typeof parsed !== "object" || !("providers" in parsed) || typeof (parsed as any).providers !== "object") {
    throw new Error("models.json 缺少 'providers' 对象");
  }
  return parsed as ModelsJson;
}

// ============================================================================
// Write (atomic + backup + mutex)
// ============================================================================

// 全局写锁：所有写盘走同一个 Promise 链，串行化
let writeChain: Promise<void> = Promise.resolve();

export async function writeModelsJson(
  next: ModelsJson,
  opts: { backup?: boolean } = { backup: true },
): Promise<{ path: string; backupPath: string }> {
  const path = getModelsJsonPath();
  const bak = getBackupPath();
  const tmp = path + ".tmp";

  const task = writeChain.then(async () => {
    if (opts.backup && existsSync(path)) {
      await copyFile(path, bak);
    }
    await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, path);
    try {
      await chmod(path, 0o600);
    } catch {
      // Windows: chmod 是 no-op，忽略
    }
  });
  // 不让 chain 被前一个错误污染
  writeChain = task.catch(() => undefined);
  await task;
  return { path, backupPath: bak };
}

export async function restoreBackup(): Promise<boolean> {
  const path = getModelsJsonPath();
  const bak = getBackupPath();
  if (!existsSync(bak)) return false;
  await copyFile(bak, path);
  return true;
}

export function backupExists(): boolean {
  return existsSync(getBackupPath());
}

// ============================================================================
// Validation
// ============================================================================

export type ValidationError = { path: string; message: string };
export type ValidationResult = { ok: true } | { ok: false; errors: ValidationError[] };

export function validateProvider(id: string, p: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  if (typeof id !== "string" || !id) {
    errors.push({ path: "<id>", message: "provider id 必须是非空字符串" });
  }
  if (typeof p !== "object" || p === null) {
    errors.push({ path: `providers.${id}`, message: "必须是 object" });
    return { ok: false, errors };
  }
  const prov = p as Record<string, unknown>;

  if ("name" in prov && typeof prov.name !== "string") {
    errors.push({ path: `providers.${id}.name`, message: "必须是 string" });
  }
  if ("baseUrl" in prov && typeof prov.baseUrl !== "string") {
    errors.push({ path: `providers.${id}.baseUrl`, message: "必须是 string" });
  }
  if ("apiKey" in prov && typeof prov.apiKey !== "string") {
    errors.push({ path: `providers.${id}.apiKey`, message: "必须是 string" });
  }
  if ("api" in prov) {
    if (typeof prov.api !== "string" || !ALLOWED_APIS.includes(prov.api as ApiType)) {
      errors.push({ path: `providers.${id}.api`, message: `必须是 ${ALLOWED_APIS.join(" | ")}` });
    }
  }
  if ("authHeader" in prov && typeof prov.authHeader !== "boolean") {
    errors.push({ path: `providers.${id}.authHeader`, message: "必须是 boolean" });
  }
  if ("headers" in prov) {
    if (typeof prov.headers !== "object" || prov.headers === null || Array.isArray(prov.headers)) {
      errors.push({ path: `providers.${id}.headers`, message: "必须是 Record<string,string>" });
    }
  }
  if ("models" in prov) {
    if (!Array.isArray(prov.models)) {
      errors.push({ path: `providers.${id}.models`, message: "必须是 array" });
    } else {
      (prov.models as unknown[]).forEach((m, i) => {
        const r = validateModel(m);
        if (!r.ok) for (const e of r.errors) errors.push({ path: `providers.${id}.models[${i}].${e.path}`, message: e.message });
      });
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function validateModel(m: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  if (typeof m !== "object" || m === null) {
    return { ok: false, errors: [{ path: "<model>", message: "必须是 object" }] };
  }
  const model = m as Record<string, unknown>;
  if (typeof model.id !== "string" || !model.id) {
    errors.push({ path: "id", message: "必须是非空 string" });
  }
  if ("name" in model && typeof model.name !== "string") {
    errors.push({ path: "name", message: "必须是 string" });
  }
  if ("reasoning" in model && typeof model.reasoning !== "boolean") {
    errors.push({ path: "reasoning", message: "必须是 boolean" });
  }
  if ("contextWindow" in model && (typeof model.contextWindow !== "number" || model.contextWindow < 0)) {
    errors.push({ path: "contextWindow", message: "必须是非负 number" });
  }
  if ("maxTokens" in model && (typeof model.maxTokens !== "number" || model.maxTokens < 0)) {
    errors.push({ path: "maxTokens", message: "必须是非负 number" });
  }
  if ("input" in model) {
    if (!Array.isArray(model.input) || !model.input.every((x) => x === "text" || x === "image")) {
      errors.push({ path: "input", message: '必须是 ("text" | "image")[]' });
    }
  }
  if ("thinkingLevelMap" in model) {
    if (typeof model.thinkingLevelMap !== "object" || model.thinkingLevelMap === null) {
      errors.push({ path: "thinkingLevelMap", message: "必须是 object" });
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function validateAll(json: ModelsJson): ValidationResult {
  const errors: ValidationError[] = [];
  for (const [id, p] of Object.entries(json.providers)) {
    const r = validateProvider(id, p);
    if (!r.ok) errors.push(...r.errors);
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// ============================================================================
// Shallow merge (drop undefined)
// ============================================================================

function shallowMerge<T extends Record<string, any>>(base: T, patch: Partial<T>): T {
  const out: T = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    (out as any)[k] = v;
  }
  return out;
}

export const mergeProvider = shallowMerge<ProviderConfig>;
export const mergeModel = shallowMerge<ModelConfig>;

// ============================================================================
// Display helpers
// ============================================================================

/** 把 apiKey 遮成 "abcd••••wxyz"（首 4 + 末 4，中间省略号），UI 用 */
export function maskApiKey(key: string | undefined): string {
  if (!key) return "(none)";
  if (key.length <= 10) return "•".repeat(key.length);
  return key.slice(0, 4) + "••••" + key.slice(-4);
}
