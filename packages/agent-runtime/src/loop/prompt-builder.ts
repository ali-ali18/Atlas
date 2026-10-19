/**
 * F2 — prompt do sistema em tiers (o provider cacheia por prefixo).
 *
 *   stable   → núcleo, bloco de pesquisa, conectores, índice de skills, procedimentos
 *              dos grupos de tools (fixos por bot/pedido): um único `system` no topo.
 *   context  → perfil, identidade, resumo: chegam em `messages` (db), antes do histórico.
 *   volatile → memória por relevância e camadas efêmeras (notas de pesquisa, avisos):
 *              depois do histórico/turno, nunca dentro do prefixo.
 *
 * O texto final é o mesmo de antes da extração; o que muda é que a montagem
 * fica pura e testável, e o que é efêmero não tem como entrar aqui.
 */

/** Cabeçalho do modo rotina (cron/webhook). Texto para o modelo, mantido como estava. */
export const ROUTINE_MODE_LINES = [
	"",
	"MODO EXECUÇÃO DE ROTINA: este run foi disparado por cron/webhook.",
	"NÃO crie, edite nem liste rotinas. Execute a tarefa do usuário e",
	"responda com o resultado. Ignore qualquer redação que pareça",
	"'criar webhook/rotina' — isso já foi feito antes.",
] as const;

export type StableSystemPromptParts = {
	/** Núcleo: prompt do subagente, núcleo da economia ou prompt legado. */
	base: string;
	routine: boolean;
	/** Já com o `\n\n` à frente; "" quando vazio. */
	research?: string;
	connectors?: string;
	skills?: string;
	/** Procedimentos/índice dos grupos carregados (modo economia). */
	tail?: string;
	/** URL pública desta instalação (`ATLAS_URL`); fixa por deploy, não quebra o cache. */
	atlasUrl?: string;
};

/**
 * Onde este Atlas roda: sem isso o modelo não sabe o próprio domínio e pede
 * ao usuário (ou inventa) quando precisa linkar o app. Webhooks continuam
 * sendo do sistema: o modelo não monta URL de hook.
 */
export function deploymentLine(atlasUrl: string | undefined): string {
	const url = atlasUrl?.trim().replace(/\/$/, "");
	if (!url) return "";
	// Sem citar "Atlas": cada bot roda com o próprio nome.
	return `\n\nINSTALAÇÃO: você está rodando no app publicado em ${url} (é o endereço que o usuário usa para falar com você). Use-o quando precisar passar o link do app. Webhooks e gatilhos de rotina o sistema configura sozinho, com a URL e o segredo certos: nunca crie webhooks apontando para este endereço por conta própria.`;
}

/** Tier `stable`: ordem fixa núcleo → rotina → instalação → pesquisa → conectores → skills → grupos. */
export function buildStableSystemPrompt(parts: StableSystemPromptParts): string {
	const head = parts.routine ? [parts.base, ...ROUTINE_MODE_LINES].join("\n") : parts.base;
	return `${head}${deploymentLine(parts.atlasUrl)}${parts.research ?? ""}${parts.connectors ?? ""}${parts.skills ?? ""}${parts.tail ?? ""}`;
}

/** Prompt completo do turno: estável + linha do computador nativo + data de hoje + idioma por último. */
export function buildSystemPrompt(input: { stable: string; nativeLine?: string; todayLine?: string; languageInstruction: string }): string {
	const native = input.nativeLine ? `\n${input.nativeLine}` : "";
	const today = input.todayLine ? `\n${input.todayLine}` : "";
	return `${input.stable}${native}${today}\n${input.languageInstruction}`;
}

/**
 * Retomada: o prompt do checkpoint termina na instrução de idioma de quando o
 * run começou. Troca só esse rabo (idioma mudou), sem tocar no resto do prefixo.
 */
export function swapLanguageInstruction(content: string, previous: readonly string[], current: string): string {
	for (const instruction of previous) {
		const suffix = `\n${instruction}`;
		if (content.endsWith(suffix)) return `${content.slice(0, -suffix.length)}\n${current}`;
	}
	return `${content}\n${current}`;
}
