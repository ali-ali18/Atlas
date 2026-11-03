/**
 * Onboarding de um bot recém-criado: o SERVIDOR dispara o run (um ponto só, ver
 * docs/adr/ onboarding-no-servidor). Aqui ficam as peças puras: marcador do objetivo,
 * chave de idempotência, mensagens e o system prompt (texto para o modelo: inglês, curto, em seções).
 */

/** Prefixo do objetivo do run de onboarding; o runtime libera `propose_profile_update` por ele. */
export const BOT_CREATED_OBJECTIVE_MARKER = "[bot-created]";

const BOT_NAME_MAX_CHARS = 80;

/** Chave estável por bot: um onboarding por bot, qualquer que seja o cliente. */
export function botCreatedClientKey(botId: string): string {
	return `bot-created:${botId}`.slice(0, 128);
}

/** `true` para o objetivo de um run de onboarding (servidor ou web antigo). */
export function isBotCreatedObjective(objective: string | null | undefined): boolean {
	return typeof objective === "string" && objective.startsWith(BOT_CREATED_OBJECTIVE_MARKER);
}

export function buildBotCreatedObjective(botName: string): string {
	return `${BOT_CREATED_OBJECTIVE_MARKER} Perguntas de onboarding do ${botName}`.slice(0, 120);
}

/** System prompt do run de onboarding. The reply language comes from the bot language setting. */
export function buildBotCreatedSystem(botName: string): string {
	const name = botName.trim().slice(0, BOT_NAME_MAX_CHARS) || "bot";
	return [
		`You are the assistant of the newly created bot "${name}". Be friendly and direct.`,
		"",
		"## Introduction",
		`- Introduce yourself briefly as "${name}" (1-2 sentences, and say you will ask a few questions to tune the experience). Never as Atlas or as any other assistant.`,
		`- Always speak in the first person as "${name}" (say "I will", never "${name} will...").`,
		"",
		"## Questions",
		"- MANDATORY: your FIRST reply must already call `propose_questionnaire` (1 item). Never end with only the introduction.",
		"- Ask ONE question at a time through the questionnaire (`propose_questionnaire` with 1 item) and wait for the answer before the next. At most 3 objective questions about role, tone and first task.",
		"- NEVER send all the questions at once.",
		"- Before asking, check `session_search` and `memory_search` to reuse context from the user's other conversations.",
		"- If the briefing is durable (role, preferences), save it with the `memory` tool.",
		"",
		"## Finish",
		"- When onboarding is done (enough answers or the user is satisfied), consolidate the briefing/snippet and call `propose_profile_update`. Never edit the profile directly.",
		"- Do not use canned static text.",
	].join("\n");
}

/** Mensagens do run: system + evento `bot-created` como JSON do usuário. */
export function buildBotCreatedMessages(input: {
	name: string;
	description?: string | null;
}): Array<{ role: "system" | "user"; content: string }> {
	return [
		{ role: "system", content: buildBotCreatedSystem(input.name) },
		{
			role: "user",
			content: JSON.stringify({
				event: "bot-created",
				name: input.name,
				description: input.description?.trim() ?? "",
			}),
		},
	];
}
