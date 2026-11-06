// Textos que o DONO lê, gerados pelo motor (não pelo modelo). Uma tabela por id, um texto por idioma do bot.
// Idiomas: os de `@workspace/shared` (`BotLanguage`); idioma novo lá vira erro de tipo aqui até ser traduzido.
// Sem nome de tool, campo ou id interno (70-padroes-produto). Texto para o modelo NÃO mora aqui.
import { type BotLanguage, DEFAULT_BOT_LANGUAGE, isBotLanguage } from "@workspace/shared";

type Entry = Record<BotLanguage, string>;

export const COPY = {
	/** Cartão de handoff: o passo é só do dono. */
	handoff: {
		"pt-BR": "Esse passo é só seu. Te explico o que fazer e espero você.",
		"en-US": "This step is yours alone. I'll explain what to do and wait for you.",
		"es-ES": "Este paso es solo tuyo. Te explico qué hacer y te espero.",
	},
	/** Ação indisponível neste contexto. */
	not_available: {
		"pt-BR": "Isso não está disponível aqui. Posso deixar preparado para você confirmar na conversa.",
		"en-US": "That isn't available here. I can have it ready for you to confirm in the chat.",
		"es-ES": "Eso no está disponible aquí. Puedo dejarlo preparado para que lo confirmes en la conversación.",
	},
	/** O run falhou por algo do motor (sem detalhe técnico para o dono). */
	run_failed: {
		"pt-BR": "Algo deu errado e não consegui terminar. Pode tentar de novo?",
		"en-US": "Something went wrong and I couldn't finish. Could you try again?",
		"es-ES": "Algo salió mal y no pude terminar. ¿Puedes intentarlo de nuevo?",
	},
	/** O run falhou porque o modelo não respondeu. */
	run_failed_model: {
		"pt-BR": "Não consegui falar com o modelo agora. Tente de novo em instantes.",
		"en-US": "I couldn't reach the model right now. Please try again in a moment.",
		"es-ES": "No pude comunicarme con el modelo ahora. Inténtalo de nuevo en un momento.",
	},
	/** Parou no teto de passos (o do dono ou o de segurança). */
	budget_steps: {
		"pt-BR": "Parei no limite de passos. A resposta acima é o melhor que apurei até aqui.",
		"en-US": "I stopped at the step limit. The answer above is the best I have so far.",
		"es-ES": "Me detuve en el límite de pasos. La respuesta de arriba es lo mejor que tengo hasta ahora.",
	},
	/** Parou no teto de gasto que o dono configurou. */
	budget_cost: {
		"pt-BR": "Parei no teto de gasto que você configurou. A resposta acima é o melhor que apurei até aqui.",
		"en-US": "I stopped at the spending limit you set. The answer above is the best I have so far.",
		"es-ES": "Me detuve en el tope de gasto que configuraste. La respuesta de arriba es lo mejor que tengo hasta ahora.",
	},
} as const satisfies Record<string, Entry>;

export type CopyId = keyof typeof COPY;

/** Idioma de reserva quando o bot não traz um idioma suportado (ex.: "auto" ainda não resolvido ou valor antigo). */
export const COPY_FALLBACK_LANGUAGE: BotLanguage = DEFAULT_BOT_LANGUAGE;

/** `{nome}` no texto é trocado por `params.nome`; marcador sem valor fica como está. */
export function copyFor(language: unknown, id: CopyId, params: Record<string, string | number> = {}): string {
	const lang = isBotLanguage(language) ? language : COPY_FALLBACK_LANGUAGE;
	const entry: Entry = COPY[id];
	return entry[lang].replace(/\{(\w+)\}/g, (whole, key: string) => (key in params ? String(params[key]) : whole));
}
