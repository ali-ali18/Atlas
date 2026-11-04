import { z } from "zod";
import { PREPARE_FOR_OWNER_TOOL } from "../policy/decide.js";
import { defineTool, type DefinedTool } from "./define-tool.js";

export const PREPARE_FOR_OWNER_TOOL_NAME = PREPARE_FOR_OWNER_TOOL;

/** Texto curto que o dono lê no cartão (o resto do cartão são os argumentos da ação). */
export const PREPARE_NOTE_MAX_CHARS = 500;

const input = z.object({
	tool: z.string().min(1).max(128).describe("Name of the action that needs the owner (e.g. email_send, mcp__trello__update_card)."),
	args: z.record(z.string(), z.unknown()).describe("The exact arguments that action takes; the owner approves these and nothing else."),
	note: z.string().min(1).max(PREPARE_NOTE_MAX_CHARS).describe("One or two plain sentences for the owner: what it does and why, in the reply language."),
});

/**
 * `prepare_for_owner` (motor v3, PR8b; desenho seção 7, regra 1). Run SEM humano (rotina, webhook, proativo, e-mail
 * recebido, outro bot) não vê envio, escrita externa, dinheiro, link público nem credencial; esta tool deixa a ação
 * como rascunho aprovável no chat do dono. Ela mesma nunca executa a ação: o executor real é do motor v3
 * (`engine-v3/prepared.ts`, via `ctx.prepareForOwner`), que valida os args contra o schema da tool alvo.
 */
export const PREPARE_FOR_OWNER_DEFINED: DefinedTool = defineTool({
	name: PREPARE_FOR_OWNER_TOOL_NAME,
	description:
		"Leave an action that needs the owner (send, a connector write or other write outside Atlas, money, public link, credential) as a draft card in the owner's chat. The owner approves it (it then runs once) or dismisses it; nothing runs now. USE WHEN the task needs one of those actions and nobody is here to approve. DO NOT USE for actions available in this run, or to ask a question. One draft per run.",
	input,
	effect: "write_internal",
	group: "misc",
	run: async (args, ctx) => {
		if (!ctx.prepareForOwner) throw new Error("Drafts for the owner are not available in this run. Say in your reply what the owner needs to do.");
		return await ctx.prepareForOwner(args);
	},
});
