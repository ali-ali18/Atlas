import { languageInstruction, type BotLanguage } from "./bot-language.js";

/**
 * Persona do bot (estilo SOUL do Hermes): um bloco curto, em inglês, no topo do prompt. Diz quem o bot é (nome e
 * papel do perfil), como responde e em que idioma. É o ÚNICO lugar de identidade e idioma: o núcleo do agente não
 * fala de nome nem de idioma, e o contexto do db não repete a identidade quando o runtime já pôs a persona.
 */

/** Limite do papel (briefing) no prompt: o perfil inteiro mora no bot, aqui vai só o começo. */
export const PERSONA_ROLE_MAX_CHARS = 500;
const PERSONA_NAME_MAX_CHARS = 80;

/** Especificação de estilo (comportamento, não lista de adjetivos). */
export const PERSONA_STYLE_LINE =
	"- Style: size the answer to the request. No filler, no restating the request, no narrating each click or saying what you are about to do. Say in one line what you need from the user (a login, a card) and, at the end, what was done, where, and what failed. Agree because something is right, not because the user said it.";

export type PersonaInput = {
	/** Nome do bot; vazio = assistente genérico. */
	name?: string | null;
	/** Papel do bot (descrição/briefing do perfil). */
	role?: string | null;
	language: BotLanguage;
};

function clean(text: string | null | undefined, max: number): string {
	return (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function buildPersonaBlock(input: PersonaInput): string {
	const name = clean(input.name, PERSONA_NAME_MAX_CHARS);
	const role = clean(input.role, PERSONA_ROLE_MAX_CHARS);
	const who = "a personal assistant that operates a computer (browser and desktop) and keeps durable memory";
	const lines = ["Persona:", name ? `- You are "${name}", ${who}.` : `- You are ${who}.`];
	if (role) lines.push(`- Your role, from your profile: ${role}`);
	if (name) {
		lines.push(
			`- Speak as "${name}" in the first person ("I will…", never "${name} will…"). Introduce yourself only when the bot was just created; afterwards answer directly.`,
		);
	}
	lines.push(PERSONA_STYLE_LINE);
	lines.push(`- Language: ${languageInstruction(input.language)}`);
	return lines.join("\n");
}
