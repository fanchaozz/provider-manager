/**
 * index.ts — pi extension 入口
 *
 * 注册命令 / 工具 / 事件钩子。
 * v1 scope：只 CRUD ~/.pi/agent/models.json；不切模型，不做登录 UI。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.ts";
import { ensureDefaultConfigFile } from "./forms.ts";

export default function (pi: ExtensionAPI) {
	// 初始化 ~/.pi/agent/provider-manager.json（若不存在）。`pi install` 后用户立即有可编辑的配置，
	// 不必单独提供 json 模板。已存在则跳过；失败只 log 不抛。
	ensureDefaultConfigFile();

	registerCommands(pi);
}
