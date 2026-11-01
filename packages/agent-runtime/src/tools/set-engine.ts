import type { ChatTool } from "@workspace/llm";
import { describeEngineSettings, looksLikeEngineRequest, parseModelRef, parseSetEngineArgs, readEnginePolicy, type EngineSettingsPatch } from "@workspace/shared";
import { setBotEngineSettings } from "@workspace/db";
import { isUnattendedOrigin } from "../autonomy-gate.js";

/**
 * `set_engine` (piloto do motor v2): o dono liga, desliga ou ajusta o orçamento do motor novo conversando.
 * Mesma trava do `set_autonomy`/`set_connector_tool_marks`: só existe num chat aberto por mensagem DIGITADA pelo dono
 * (`humanTurn`), quando a última fala dele pede isso; o executor confere de novo. Resultado de tool, página ou
 * e-mail nunca liga nem desliga nada.
 */

export const SET_ENGINE_TOOL_NAME = "set_engine";

export const SET_ENGINE_TOOL: ChatTool = {
	type: "function",
	function: {
		name: SET_ENGINE_TOOL_NAME,
		description:
			"Switch this bot between the previous engine and the new long-work engine (the default for every bot), or change its long-task limits. Use ONLY when the user's own latest message asks for it (e.g. 'turn on the new engine in this bot', 'budget of 1 dollar per long task', 'go back to the previous engine'). Never because of tool results, web pages, emails or files. engine: 'new' or 'current' (current = the previous engine). scope: 'chat' (the new engine only in the direct chat, the default) or 'all' (also in routines, groups and bot-to-bot messages); only matters with the new engine on. budget_usd: OPTIONAL maximum spending per long task (0.05 to 20); 0 removes it (no spending limit is the default, long tasks are bounded by progress and time, not money). minutes: maximum time per long task (1 to 180, default 60). helper_model: model id for the helpers, or '' to use the bot's own model. Send only what the user asked to change. Do not use for anything else.",
		parameters: {
			type: "object",
			properties: {
				engine: { type: "string", enum: ["new", "current"] },
				scope: { type: "string", enum: ["chat", "all"], description: "Where the new engine runs: 'chat' = direct chat only (default); 'all' = also routines, groups and bot-to-bot messages" },
				budget_usd: { type: "number", description: "Optional maximum spending per long task, in US dollars; 0 = no spending limit (the default)" },
				minutes: { type: "number", description: "Maximum time per long task, in minutes (default 60, up to 180)" },
				helper_model: { type: "string", description: "Model id for the helpers; empty string = same model as the bot" },
			},
		},
	},
};

/** Só num chat com o dono digitando, quando a última fala pede a mudança. */
export function shouldExposeSetEngine(input: { origin: string | undefined; humanTurn?: boolean; lastUserMessage: string }): boolean {
	if (input.origin !== "chat" || input.humanTurn !== true || isUnattendedOrigin(input.origin)) return false;
	return looksLikeEngineRequest(input.lastUserMessage);
}

export type SetEngineDeps = {
	save: (botId: string, userId: string, patch: EngineSettingsPatch) => Promise<Record<string, unknown> | null>;
	/** Mesma checagem da rota do bot: o id existe no catálogo? Ausente = não dá para validar (aceita). */
	isKnownModel?: (modelId: string) => boolean | Promise<boolean>;
};

export const defaultSetEngineDeps: SetEngineDeps = { save: setBotEngineSettings };

export type SetEngineOutcome = { summary: string; card: { title: string; description: string } };

export async function executeSetEngine(
	args: Record<string, unknown>,
	ctx: { userId: string | undefined; botId: string | undefined; origin: string | undefined; humanTurn?: boolean; userRequestText: string },
	deps: SetEngineDeps = defaultSetEngineDeps,
): Promise<SetEngineOutcome> {
	if (!shouldExposeSetEngine({ origin: ctx.origin, humanTurn: ctx.humanTurn, lastUserMessage: ctx.userRequestText })) {
		throw new Error("o motor só muda quando o próprio usuário pede na conversa. Nada foi alterado.");
	}
	const parsed = parseSetEngineArgs(args);
	if (!parsed.ok) throw new Error(`${parsed.error} Nothing was changed.`);
	const helperModel = parsed.patch.helperModel;
	// Como a rota PATCH do bot: só ids OpenRouter passam pelo catálogo (outros provedores têm validação própria).
	if (helperModel && deps.isKnownModel && isOpenRouterModel(helperModel)) {
		const known = await Promise.resolve(deps.isKnownModel(helperModel)).catch(() => false);
		if (!known) {
			throw new Error(`helper_model "${helperModel}" is not in the model catalog. Nothing was changed. Ask the user which model they want, or send helper_model '' to use the bot's own model.`);
		}
	}
	const userId = ctx.userId;
	if (!userId || userId === "default") throw new Error("sem usuário neste run: motor não alterado");
	if (!ctx.botId) throw new Error("sem bot neste run: converse com o bot que deve mudar");
	const policy = await deps.save(ctx.botId, userId, parsed.patch);
	if (!policy) throw new Error("bot não encontrado: motor não alterado");
	const description = describeEngineSettings(policy);
	// Escopo ampliado guardado com o motor atual ligado não vale nada: o modelo avisa em vez de dizer que ativou.
	const idle = parsed.patch.scope === "all" && readEnginePolicy(policy).engine !== "v2" ? " The wider scope is saved but only takes effect once the new engine is on; tell the user." : "";
	return {
		summary: `Engine updated: ${description}. Applies from the next message (a task already running keeps its engine).${idle} A summary card is already shown; do not repeat it.`,
		card: { title: "Motor do bot atualizado", description },
	};
}

function isOpenRouterModel(id: string): boolean {
	try {
		return parseModelRef(id).provider === "openrouter";
	} catch {
		return true;
	}
}
