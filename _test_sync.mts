// sync.ts 单测：mock global fetch，测试 fetcher + heuristics + filter
import {
	fetchListing,
	inferModel,
	inferReasoning,
	inferInput,
	isNoise,
	syncExisting,
	SYNC_PRESETS,
} from "./sync.ts";

const ok = (label: string, cond: boolean, extra?: string) => {
	const tag = cond ? "✓" : "✗";
	console.log(`${tag} ${label}${extra ? " — " + extra : ""}`);
	if (!cond) process.exitCode = 1;
};

function mockFetch(handler: (url: string, init?: any) => Response | Promise<Response>) {
	const orig = (globalThis as any).fetch;
	(globalThis as any).fetch = async (url: string, init?: any) => handler(url, init);
	return () => { (globalThis as any).fetch = orig; };
}

const okResp = (json: any) =>
	new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });

async function main() {
	// ----- 1. heuristics -----
	console.log("=== heuristics ===");
	ok("isNoise 过滤 embed", isNoise("text-embedding-3-small"));
	ok("isNoise 过滤 tts", isNoise("tts-1"));
	ok("isNoise 过滤 whisper", isNoise("whisper-1"));
	ok("isNoise 过滤 dall-e", isNoise("dall-e-3"));
	ok("isNoise 不过滤 gpt-4", !isNoise("gpt-4"));
	ok("isNoise 不过滤 claude", !isNoise("claude-opus-4-7"));
	ok("isNoise 过滤 image- 前缀", isNoise("image-generation-v1"));
	ok("isNoise 过滤 moderation", isNoise("text-moderation-latest"));

	ok("inferReasoning o1", inferReasoning("o1-preview"));
	ok("inferReasoning o3-mini", inferReasoning("o3-mini"));
	ok("inferReasoning deepseek-r1", inferReasoning("deepseek-r1-distill"));
	ok("inferReasoning qwq", inferReasoning("qwq-32b-preview"));
	ok("inferReasoning qwen3 thinking", inferReasoning("qwen3-thinking"));
	ok("!inferReasoning gpt-4", !inferReasoning("gpt-4"));
	ok("!inferReasoning claude-opus", !inferReasoning("claude-opus-4-7"));

	ok("inferInput claude 视觉", inferInput("claude-opus-4-7").includes("image"));
	ok("inferInput gpt-4 视觉", inferInput("gpt-4-turbo").includes("image"));
	ok("inferInput gemini 视觉", inferInput("gemini-1.5-pro").includes("image"));
	ok("!inferInput gpt-3.5 文本", !inferInput("gpt-3.5-turbo").includes("image"));

	ok("inferModel defaults (contextWindow=128k = DEFAULT)", inferModel("foo", { id: "foo" }).contextWindow === 128000);
	ok("inferModel maxTokens default (16k = DEFAULT)", inferModel("foo", { id: "foo" }).maxTokens === 16384);
	ok("inferModel o1 reasoning=true", inferModel("o1", { id: "o1" }).reasoning === true);
	ok("inferModel name 一致时省略", inferModel("foo", { id: "foo", name: "foo" }).name === undefined);
	ok("inferModel name 不一致保留", inferModel("foo", { id: "foo", name: "Foo Plus" }).name === "Foo Plus");

	// 新行为：sync 出来的 model 应用 DEFAULT_MODEL_CONFIG
	ok("sync inferModel 套用默认 reasoning=true", inferModel("plain-model", { id: "plain-model" }).reasoning === true);
	ok("sync inferModel 套用默认 input=[text,image]", JSON.stringify(inferModel("plain-model", { id: "plain-model" }).input) === '["text","image"]');
	ok("sync inferModel 套用默认 thinkingLevelMap.medium=medium", inferModel("plain-model", { id: "plain-model" }).thinkingLevelMap?.medium === "medium");
	ok("sync inferModel 套用默认 thinkingLevelMap 6 个 null", ["off","minimal","low","high","xhigh","max"].every((l) => inferModel("plain-model", { id: "plain-model" }).thinkingLevelMap?.[l] === null));
	// heuristic 覆盖：vision id 仍带 image
	ok("sync inferModel vision id 输入仍含 image", inferModel("vision-model", { id: "vision-model" }).input.includes("image"));
	// heuristic 与默认一致：o1 reasoning=true（默认就是 true，heuristic 也 true）
	ok("sync inferModel o1 reasoning=true", inferModel("o1-preview", { id: "o1-preview" }).reasoning === true);

	// ----- 2. fetchListing: OpenAI-compat -----
	console.log("\n=== fetchListing: openai-compat ===");
	{
		const restore = mockFetch((url) => {
			ok("OpenAI URL 拼对", url === "http://localhost:11434/v1/models");
			return okResp({
				data: [
					{ id: "llama3.1:8b" },
					{ id: "qwen2.5:7b" },
					{ id: "nomic-embed-text" },  // noise
					{ id: "deepseek-r1:7b" },     // reasoning
					{ id: "llava:7b" },            // vision
				],
			});
		});
		try {
			const r = await fetchListing({ baseUrl: "http://localhost:11434/v1/", apiKind: "openai-compat" });
			ok("models 数 4（noise 过滤）", r.models.length === 4);
			ok("baseUrl 去尾 /", r.baseUrl === "http://localhost:11434/v1");
			ok("nomic-embed-text 被过滤", !r.models.some((m) => m.id === "nomic-embed-text"));
			ok("deepseek-r1 保留", r.models.some((m) => m.id === "deepseek-r1:7b"));
			ok("llava 保留", r.models.some((m) => m.id === "llava:7b"));
		} finally {
			restore();
		}
	}

	// ----- 3. fetchListing: apiKey 带 Bearer -----
	console.log("\n=== fetchListing: apiKey ===");
	{
		const restore = mockFetch((url, init) => {
			ok("URL 不带 key query", url === "http://x/v1/models");
			ok("Bearer header 设置", init?.headers?.Authorization === "Bearer secret-key");
			return okResp({ data: [{ id: "m1" }] });
		});
		try {
			await fetchListing({ baseUrl: "http://x/v1", apiKey: "secret-key", apiKind: "openai-compat" });
		} finally {
			restore();
		}
	}

	// ----- 4. fetchListing: Google -----
	console.log("\n=== fetchListing: google ===");
	{
		const restore = mockFetch((url) => {
			ok("Google URL 拼对", url === "https://generativelanguage.googleapis.com/v1beta/models?key=my-key");
			return okResp({
				models: [
					{ name: "models/gemini-1.5-pro", displayName: "Gemini 1.5 Pro", supportedGenerationMethods: ["generateContent", "countTokens"] },
					{ name: "models/embedding-001", displayName: "Embedding", supportedGenerationMethods: ["embedContent"] },
					{ name: "models/gemini-1.5-flash", displayName: "Gemini 1.5 Flash", supportedGenerationMethods: ["generateContent"] },
				],
			});
		});
		try {
			const r = await fetchListing({ baseUrl: "https://generativelanguage.googleapis.com/v1beta/", apiKey: "my-key", apiKind: "google" });
			ok("Google models 数 2（embedContent 过滤）", r.models.length === 2);
			ok("gemini-1.5-pro 保留", r.models.some((m) => m.id === "gemini-1.5-pro"));
			ok("embedding-001 被过滤", !r.models.some((m) => m.id === "embedding-001"));
			ok("displayName 保留为 name", r.models.find((m) => m.id === "gemini-1.5-pro")?.name === "Gemini 1.5 Pro");
		} finally {
			restore();
		}
	}

	// ----- 5. fetchListing: 错误处理 -----
	console.log("\n=== fetchListing: errors ===");
	{
		const restore = mockFetch(() => new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }));
		try {
			try {
				await fetchListing({ baseUrl: "http://x/v1", apiKind: "openai-compat" });
				ok("401 应该 throw", false);
			} catch (err: any) {
				ok("401 抛错带状态码", err.message.includes("401"));
			}
		} finally {
			restore();
		}
	}

	{
		const restore = mockFetch(() => okResp({ data: "not an array" }));
		try {
			const r = await fetchListing({ baseUrl: "http://x/v1", apiKind: "openai-compat" });
			ok("data 非数组时返回空列表", r.models.length === 0);
		} finally {
			restore();
		}
	}

	// ----- 6. fetchListing: 超时（mock 不响应 abort，跳过；真实场景由 controller 控制）-----
	console.log("\n=== fetchListing: timeout (skipped) ===");
	ok("skipped", true);

	// ----- 7. SYNC_PRESETS 完整性 -----
	console.log("\n=== SYNC_PRESETS ===");
	ok("google preset 存在", !!SYNC_PRESETS.find((p) => p.id === "google"));
	ok("custom preset 存在", !!SYNC_PRESETS.find((p) => p.id === "custom"));
	ok("google preset baseUrl 设了", !!SYNC_PRESETS.find((p) => p.id === "google")?.baseUrl);
	ok("custom preset baseUrl 留空", !SYNC_PRESETS.find((p) => p.id === "custom")?.baseUrl);

	// ----- 8. syncExisting -----
	console.log("\n=== syncExisting ===");
	{
		const restore = mockFetch((url) => {
			if (url.includes("googleapis")) return okResp({ models: [{ name: "models/gemini-1.5-pro", displayName: "Gemini", supportedGenerationMethods: ["generateContent"] }] });
			return okResp({ data: [{ id: "llama3.1" }] });
		});
		try {
			const results = await syncExisting({
				kdapi: { baseUrl: "http://10.168.2.110:23000/v1", api: "openai-completions" },
				google: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", api: "google-generative-ai", apiKey: "k" },
				noUrl: { api: "openai-completions" },  // 没有 baseUrl → 跳过
			});
			ok("2 个 provider 被处理（noUrl 跳过）", results.length === 2);
			ok("kdapi 成功", "models" in (results.find((r) => r.providerId === "kdapi")?.result as any));
			ok("kdapi 1 个 model", (results.find((r) => r.providerId === "kdapi")?.result as any).models.length === 1);
			ok("google 成功", "models" in (results.find((r) => r.providerId === "google")?.result as any));
		} finally {
			restore();
		}
	}
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
