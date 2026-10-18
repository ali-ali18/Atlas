import type { MemoryTarget } from "./memory.js";

/** Categorias que podem ir ao store `user` (compartilhado entre bots). */
export const USER_PROFILE_CATEGORIES: ReadonlySet<string> = new Set([
	"identidade",
	"preferencia",
	"idioma",
	"fuso",
	"comunicacao",
	"contato",
	"profissao",
	"localizacao",
	"formacao",
]);

export type BotProfileText = { name?: string | null; snippet?: string | null; description?: string | null };

export type MemoryScopeContext = {
	/** Nomes de todos os bots do usuário (citar um bot = fato daquele bot, não do usuário). */
	botNames?: readonly string[];
	/** Perfil do bot deste chat: o que só repete o perfil já está salvo, não vira memória. */
	botProfile?: BotProfileText | null;
	/** Sem categoria, o revisor rebaixa para o bot (padrão); a tool do agente (categoria opcional) passa `false`. */
	requireCategory?: boolean;
};

export type MemoryScopeDecision =
	| { action: "save"; target: MemoryTarget; reason?: string }
	| { action: "skip"; reason: string }
	| { action: "reject"; reason: string };

export function normalizeMemoryCategory(value: string | undefined | null): string {
	return (value ?? "")
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.trim()
		.toLowerCase();
}

function fold(text: string): string {
	return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const FREQUENCY = /\b(todo dia|todos os dias|diariamente|toda (?:manha|tarde|noite|semana|segunda|terca|quarta|quinta|sexta|sabado|domingo)|todas as (?:manhas|tardes|noites|semanas)|semanalmente|mensalmente|de hora em hora)\b/;
const CLOCK = /\bas? \d{1,2}(?:h|:\d{2}|\s?horas)\b/;
const ROUTINE_WORD = /\b(rotinas?|lembretes?|agendar|agendamentos?|automatizar)\b/;
const ROUTINE_ACTION = /\b(consultar|checar|verificar|enviar|mandar|avisar|lembrar|conferir|resumir|resumo|relatorio|rodar|executar|buscar)\b/;
const REQUEST = /\b(?:quer|queria|pediu|pede|solicitou|precisa|deseja)\s+(?:uma?|que|ajuda|criar|receber|consultar|agendar|configurar|automatizar)\b/;

/** Pedido de rotina/lembrete agendado: rotinas vivem em Rotinas, não na memória. Estreito de propósito. */
export function isRoutineRequest(content: string): boolean {
	const text = fold(content);
	const scheduled = FREQUENCY.test(text) || CLOCK.test(text);
	if (ROUTINE_WORD.test(text) && (scheduled || REQUEST.test(text))) return true;
	return scheduled && ROUTINE_ACTION.test(text) && REQUEST.test(text);
}

function namesBot(text: string, folded: string, botNames: readonly string[]): boolean {
	if (/^bot\b/.test(folded) || /\bbot\s+\p{Lu}[\p{L}\d]*\s*:/u.test(text)) return true;
	if (/\b(?:este|esse|neste|nesse|no|do|ao|deste|desse|pelo|para o) bot\b/.test(folded)) return true;
	for (const raw of botNames) {
		const name = fold(raw.trim());
		if (name.length < 2) continue;
		if (new RegExp(`(?:^|[^\\p{L}\\d])${escapeRe(name)}(?![\\p{L}\\d])`, "u").test(folded)) return true;
	}
	return false;
}

const PERSONA_START = /^(?:tom|estilo|persona|personalidade|papel|funcao|instrucoes?|instrucao)\b/;
const PERSONA_USER_MARK = /\b(prefere|preferencia|preferido|gosta|usuario|fala|me chama|chamar de|apelido)\b/;
const BOT_ROLE = /\b(?:assistente|agente)\s+(?:amigavel|pessoal|virtual|de ia|para|de|que)\b/;
const WANTS_FROM_BOT = /\b(?:quer|precisa|pediu|pede|espera|deseja)\b[^.;]{0,60}\b(?:ajuda (?:principalmente |especialmente )?(?:com|em|para)|que o (?:bot|assistente))\b/;

function describesBotPersona(folded: string): boolean {
	if (PERSONA_START.test(folded) && !PERSONA_USER_MARK.test(folded)) return true;
	return /^(?:eh |e )?(?:um |uma )?(?:assistente|agente)\b/.test(folded) && BOT_ROLE.test(folded);
}

function tokens(text: string): Set<string> {
	return new Set(fold(text).split(/[^a-z0-9]+/).filter((token) => token.length >= 4));
}

/** O conteúdo só repete o perfil (nome/snippet/descrição) do bot? Cobertura alta de palavras. */
export function restatesBotProfile(content: string, profile: BotProfileText | null | undefined): boolean {
	if (!profile) return false;
	const mine = tokens(content);
	if (mine.size < 4) return false;
	const known = tokens([profile.name, profile.snippet, profile.description].filter(Boolean).join(" "));
	if (known.size === 0) return false;
	let hit = 0;
	for (const token of mine) if (known.has(token)) hit += 1;
	return hit / mine.size >= 0.7;
}

/**
 * Trava determinística das duas portas de escrita (revisor pós-conversa e tool `memory` do agente).
 * Só perfil pessoal estável vai ao store `user` (compartilhado entre bots); o resto fica no bot.
 * `reject` = rotina (não é memória); `skip` = repete o perfil do bot. Na dúvida: camada do bot.
 */
export function decideMemoryScope(
	input: { content: string; category?: string | null; target: MemoryTarget; hasBot: boolean },
	ctx: MemoryScopeContext = {},
): MemoryScopeDecision {
	const { content, target } = input;
	if (isRoutineRequest(content)) return { action: "reject", reason: "pedido de rotina/lembrete agendado" };
	if (restatesBotProfile(content, ctx.botProfile)) return { action: "skip", reason: "repete o perfil do bot" };
	if (target !== "user" || !input.hasBot) return { action: "save", target };
	const folded = fold(content);
	const category = normalizeMemoryCategory(input.category);
	if (category ? !USER_PROFILE_CATEGORIES.has(category) : ctx.requireCategory !== false) {
		return { action: "save", target: "memory", reason: "categoria fora do perfil pessoal" };
	}
	if (namesBot(content, folded, ctx.botNames ?? [])) return { action: "save", target: "memory", reason: "cita um bot" };
	if (describesBotPersona(folded)) return { action: "save", target: "memory", reason: "persona/papel de um bot" };
	if (WANTS_FROM_BOT.test(folded) || REQUEST.test(folded)) return { action: "save", target: "memory", reason: "pedido ao bot" };
	return { action: "save", target };
}
