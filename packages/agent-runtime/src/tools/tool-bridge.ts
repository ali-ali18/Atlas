import type { ChatTool } from "@workspace/llm";
import { z } from "zod";
import { defineTool } from "./define-tool.js";

/**
 * Ponte do motor v3 para as tools que não estão no array (desenho 3.2): `tool_search` acha pelo assunto e devolve
 * a assinatura; `tool_call` executa uma tool do manifesto pelo nome. O laço do v3 desembrulha `tool_call` antes da
 * política e do executor: quem decide e registra vê sempre o nome real. Só o v3 oferece estas duas.
 */
export const TOOL_SEARCH_TOOL_NAME = "tool_search";
export const TOOL_CALL_TOOL_NAME = "tool_call";

export const toolSearchTool = defineTool({
	name: TOOL_SEARCH_TOOL_NAME,
	description:
		"Find tools that are not in your tool list (built-in and connectors) by name or by need, in a few words (\"create bot\", \"list sales orders\"). Returns up to 8 matches with their parameters. Skip it when the context already shows the tool you need and you know its parameters.",
	input: z.object({
		query: z.string().min(1).max(200).describe("Tool name or a short need"),
		limit: z.number().int().min(1).max(8).describe("Max results (default 8)").optional(),
	}),
	effect: "read",
	group: "misc",
	run: (args, ctx) => {
		if (!ctx.toolSearch) throw new Error("tool_search is not available in this run.");
		return { summary: ctx.toolSearch(args.query, args.limit) };
	},
});

export const toolCallTool = defineTool({
	name: TOOL_CALL_TOOL_NAME,
	description:
		"Call a tool that is not in your tool list by its exact name (from the context list or tool_search), with its arguments as a JSON object. It runs exactly like a direct call (same approvals and cards).",
	input: z.object({
		name: z.string().min(1).max(128).describe("Exact tool name"),
		args: z.record(z.string(), z.unknown()).describe("Arguments object for that tool").optional(),
	}),
	// Nunca roda como ela mesma: o v3 troca pela tool real antes da política (efeito, aprovação e journal são dela).
	effect: "read",
	group: "misc",
	run: () => {
		throw new Error("tool_call is resolved by the engine; call the tool by its exact name.");
	},
});

export const TOOL_SEARCH_TOOL: ChatTool = toolSearchTool.definition;
export const TOOL_CALL_TOOL: ChatTool = toolCallTool.definition;
