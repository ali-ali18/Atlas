import { z } from "zod";
import { defineTool, type Tool } from "../tools/define-tool.js";
import type { Effect } from "../contract/effects.js";

/** Tool de teste com schema de um campo. */
export function fakeTool(name: string, effect: Effect = "read"): Tool {
	return defineTool({
		name,
		description: `Test tool ${name}.`,
		inputSchema: z.object({ value: z.string().optional() }),
		effect,
		execute: () => ({ ok: true, summary: `${name} done` }),
	});
}
