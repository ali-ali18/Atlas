import { LEGACY_BROWSER_TOOL_NAMES } from "../browser-vocabulary.js";
import { COMPUTER_REF_TOOL_NAMES } from "../computer-refs.js";
import { COMPUTER_READ_TOOL_NAMES } from "../computer-read.js";
import { COMPUTER_TABS_TOOL_NAME } from "../computer-tabs.js";
import { NATIVE_COMPUTER_TOOL_NAME } from "../computer-native.js";
import { SANDBOX_RELEASE_TOOL_NAME } from "../sandbox-release.js";
import { SANDBOX_SHELL_TOOL_NAMES } from "../sandbox-shell.js";

/** Tools que usam a VM do run (navegador e shell): ganham aviso de aba e prazo de sandbox. */
export const SANDBOX_TOOL_NAMES = new Set([
	"screenshot",
	"navigate",
	"click",
	"type",
	"key",
	"scroll",
	...LEGACY_BROWSER_TOOL_NAMES,
	...COMPUTER_REF_TOOL_NAMES,
	...COMPUTER_READ_TOOL_NAMES,
	COMPUTER_TABS_TOOL_NAME,
	...SANDBOX_SHELL_TOOL_NAMES,
	SANDBOX_RELEASE_TOOL_NAME,
	NATIVE_COMPUTER_TOOL_NAME,
]);

export function isSandboxTool(name: string): boolean {
	return SANDBOX_TOOL_NAMES.has(name);
}
