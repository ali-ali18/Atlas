import type { ChatMessage } from "@workspace/shared";
import { isBotConfigEventObjective } from "./tools/registry/helpers.js";

/**
 * Evento proativo de bot (bot-created / questionnaire-submitted)
 * — instrução PER-EVENTO.
 *
 * QA: NÃO embutir no SYSTEM_PROMPT global acima. O caller monta via
 * objective/messages (ideal: messages[0] = { role: "system", content:
 * BOT_CONFIG_EVENT_SYSTEM_INSTRUCTION }); o runtime só injeta o sufixo
 * abaixo quando detecta o marcador no objective, como rede de segurança.
 * Proativo usa origin "chat" (nunca "routine": rotina stripa tools e
 * histórico — ver computer-use.ts:2012-2023 e agent-run.ts:246-249).
 *
 * Contrato `questionnaire-submitted` (ver `@workspace/shared/questionnaire`):
 * `{ botId, event: "questionnaire-submitted", answers: { direction, detail,
 * briefing }, submittedAt }` entra como `messages[].user` em JSON, SEM texto
 * estático pronto — o LLM lê o JSON e consolida via tool `memory`.
 * Memória vai para MemoryEntry target "memory" botId-escopado
 * (resolveBotId em memory-entries.ts), category "bot_config"/"bot_evolution",
 * importance>=0.7 quando muda decisões futuras; content = "<estado>. Porquê:
 * <motivo>".
 *
 * Modelo mental (anti-alucinação):
 * - `Bot.description` = ESTADO ATUAL (briefing consolidado via confirm +
 *   `PATCH /v1/bots`); lido todo run via `buildBotBriefingMessages` em
 *   `memory-context.ts` como system.
 * - `MemoryEntry` (memory, bot_config/bot_evolution) = PORQUÊ/HISTÓRICO;
 *   lido por relevância via `renderRelevantMemoryPrompt` em `memory-search.ts`.
 * - Antes de afirmar sobre o bot/usuário ou dizer "não sei", consulte
 *   `memory_search` (fatos) e `session_search` (conversas passadas).
 * - NÃO criar tabela BotBriefing (proibido): briefing vive em
 *   `Bot.description` + `MemoryEntry`.
 *
 * Perguntas com escolhas fixas (inclusive bot recém-criado): via tool
 * `propose_questionnaire` (card `questionnaire`, uma proposta por vez, 1
 * pergunta por chamada); texto final confirma o entendimento + introduz
 * a próxima pergunta (só ele persiste como balão — papo do meio evapora).
 *
 * Dedup (resposta repetida NÃO duplica — ver `memory-entries.ts`):
 * - Exato barra ("duplicado"); semântico < 0.08
 *   (`SEMANTIC_DUP_MAX_DISTANCE`) barra paráfrase ("duplicado").
 * - Overflow 2200 chars (`MEMORY_CHAR_LIMIT`): `add` falha; use `replace`
 *   consolidando (antigo + novo num fato só, "<estado>. Porquê: <motivo>").
 *
 * Offline/close sem rede: aceitar sem run na v1 (caller não cria run).
 * 1 run ativo por conversa (P2002 -> steer) + `clientKey` idempotente
 * (ver `packages/shared/src/runs.ts`, `packages/db/src/runs.ts`).
 */
export const BOT_CONFIG_EVENT_SYSTEM_INSTRUCTION = [
	"BOT EVENT (bot created, config or questionnaire answers): reply briefly and warmly, in the bot's language.",
	"Introduce yourself in 1-2 sentences (who you are, and that you will ask a few questions to tailor the experience). No formal welcome.",
	"One question at a time: call `propose_questionnaire` with 1 item, wait for the answer, then ask the next (at most 3 in onboarding).",
	"Before asking, check `session_search` (this bot's history) and `memory_search` to reuse what was already said. Each bot is isolated: do not assume or cite context from the user's other bots.",
	"After `propose_questionnaire`, the final text confirms what you understood and introduces the next question (the card already shows the question).",
	"Without a card and for a trivial point: at most one short question in text. Do not open a long conversation.",
	"If the conclusion changes future decisions, save it with the `memory` tool, target `memory`, category `bot_config` or `bot_evolution`, importance>=0.7 (content=\"<state>. Why: <reason>\").",
	"A repeated answer is not duplicated: an identical or paraphrased `add` (<0.08) returns \"duplicado\"; when over 2200 chars, use `replace` to consolidate.",
	"Before stating something about the bot or saying you do not know, check `memory_search` and `session_search` (description = current state, memory = why/history).",
].join("\n");

function containsBotConfigInstruction(text: string): boolean {
	const lower = (text ?? "").toLowerCase();
	return (
		lower.includes("evento de bot") ||
		lower.includes("bot event") ||
		lower.includes("bot_config") ||
		lower.includes("bot_evolution") ||
		lower.includes("questionnaire-submitted")
	);
}

/**
 * Retorna a instrução per-evento a injetar como system extra, ou null.
 * Não duplica se messages já traz system com a instrução (messages[0].system).
 */
export function getBotConfigEventExtraSystemMessage(
	messages: ChatMessage[],
): string | null {
	const hasInstruction = messages.some(
		(message) =>
			message.role === "system" && containsBotConfigInstruction(message.content),
	);
	if (hasInstruction) return null;
	const objective =
		[...messages].reverse().find((m) => m.role === "user")?.content ?? "";
	if (!isBotConfigEventObjective(objective)) return null;
	return BOT_CONFIG_EVENT_SYSTEM_INSTRUCTION;
}

/**
 * Hash de dedup do evento de config (botId + snapshot normalizado).
 * Caller (web/api) compara antes de criar run: hash igual + sem mudança
 * material => 0 runs (fechar sem mudar, pin/seção). Mudança pequena/grande
 * decide confirma vs pergunta+salva via instrução per-evento acima.
 */
export async function hashBotConfigEvent(input: {
	botId: string;
	snapshot: string;
}): Promise<string> {
	const { createHash } = await import("node:crypto");
	return createHash("sha256")
		.update(`${input.botId}\n${input.snapshot.trim()}`)
		.digest("hex")
		.slice(0, 32);
}

/**
 * Monta messages para run proativo de bot (origin "chat", nunca "routine").
 * messages[0].system = instrução curta PT-BR; user = objective com marcador.
 * Tom simpático com 1 frase de olá + UMA pergunta por vez via
 * `propose_questionnaire` (ver instrução); com card, o texto final confirma
 * o entendimento + introduz a próxima pergunta (é o que persiste).
 * Offline/close sem rede: caller NÃO chama (aceita sem run na v1).
 */
export function buildBotConfigEventMessages(input: {
	objective: string;
	botName?: string;
	summary?: string;
}): ChatMessage[] {
	const header = input.botName ? `Bot "${input.botName}": ` : "";
	const detail = input.summary?.trim() ? `\n${input.summary.trim()}` : "";
	return [
		{ role: "system", content: BOT_CONFIG_EVENT_SYSTEM_INSTRUCTION },
		{ role: "user", content: `${header}${input.objective.trim()}${detail}` },
	];
}

/**
 * Monta messages para o evento `questionnaire-submitted` (origin "chat").
 *
 * Contrato mínimo (ver `@workspace/shared/questionnaire`):
 * `{ botId, event: "questionnaire-submitted", answers: { direction, detail,
 * briefing }, submittedAt }` entra como `messages[1].user` em JSON, SEM texto
 * estático — o LLM consolida via tool `memory` (`target: "memory"`, category
 * `bot_config`/`bot_evolution`, `importance >= 0.7`, content
 * `"<estado>. Porquê: <motivo>"`). `Bot.description` (estado atual, via
 * confirm + `PATCH /v1/bots`) + memória (porquê) são lidos em runs futuros
 * via `buildMemoryAugmentedMessages` + `renderRelevantMemoryPrompt`; nunca
 * criar tabela `BotBriefing`.
 */
export function buildQuestionnaireSubmittedMessages(input: {
	botId: string;
	answers: { direction?: string; detail?: string; briefing?: string };
	submittedAt?: string;
	botName?: string;
}): ChatMessage[] {
	const answers: Record<string, string> = {};
	const direction = input.answers.direction?.trim();
	const detail = input.answers.detail?.trim();
	const briefing = input.answers.briefing?.trim();
	if (direction) answers.direction = direction.slice(0, 2000);
	if (detail) answers.detail = detail.slice(0, 2000);
	if (briefing) answers.briefing = briefing.slice(0, 2000);
	const payload = {
		botId: input.botId,
		event: "questionnaire-submitted" as const,
		answers,
		submittedAt: input.submittedAt ?? new Date().toISOString(),
	};
	const header = input.botName ? `Bot "${input.botName}": ` : "";
	return [
		{ role: "system", content: BOT_CONFIG_EVENT_SYSTEM_INSTRUCTION },
		{
			role: "user",
			content: `${header}[questionnaire-submitted]\n${JSON.stringify(payload)}`,
		},
	];
}
