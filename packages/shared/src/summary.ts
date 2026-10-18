/**
 * Resumo de conversa — Fase 1 (contrato + builders puros).
 *
 * O transcript original nunca é apagado; o resumo é continuidade operacional:
 * bloco denso reinjetado no prompt + fatos estruturados. Escrito por modelo
 * barato no idle/manual, nunca pelo modelo do run.
 */

export const SUMMARY_CONTENT_MAX_CHARS = 2000;
export const SUMMARY_FACTS_MAX_ITEMS = 10;
export const SUMMARY_FACT_MAX_CHARS = 200;

export type SummaryFacts = {
	decisions: string[];
	pendings: string[];
	prefs: string[];
	constraints: string[];
};

export function emptySummaryFacts(): SummaryFacts {
	return { decisions: [], pendings: [], prefs: [], constraints: [] };
}

function cleanFactList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim().replace(/\s+/g, " ").slice(0, SUMMARY_FACT_MAX_CHARS))
		.filter(Boolean)
		.slice(0, SUMMARY_FACTS_MAX_ITEMS);
}

/**
 * Resumo anterior para continuação incremental: o transcript novo é mesclado
 * com ele em vez de resumir do zero (preserva decisões/constraints da v1).
 */
export type PreviousSummaryInput = {
	content: string;
	factsJson?: unknown;
	version: number;
};

function formatPreviousFacts(factsJson: unknown): string | null {
	const facts = factsJson as {
		decisions?: string[];
		pendings?: string[];
		prefs?: string[];
		constraints?: string[];
	} | null | undefined;
	if (!facts || typeof facts !== "object") return null;
	const parts: string[] = [];
	const section = (label: string, items: unknown) => {
		if (!Array.isArray(items) || items.length === 0) return;
		const cleaned = items
			.filter((entry): entry is string => typeof entry === "string")
			.map((entry) => entry.trim())
			.filter(Boolean);
		if (cleaned.length > 0) parts.push(`${label}: ${cleaned.join(" | ")}`);
	};
	section("Decisões", facts.decisions);
	section("Pendências", facts.pendings);
	section("Preferências", facts.prefs);
	section("Regras", facts.constraints);
	return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Monta o prompt do resumidor. `transcript` já vem fatiado (linhas
 * "USUÁRIO: ..."/"ASSISTENTE: ..."). Com `previousSummary`, o modelo recebe
 * a versão anterior + fatos antes da conversa e deve produzir versão
 * ATUALIZADA que mescle o anterior com as mensagens novas. Puro e testável.
 */
export function buildSummaryPrompt(
	transcript: readonly string[],
	previousSummary?: PreviousSummaryInput | null,
	options?: { activeTask?: string | null },
): string {
	const activeTask = options?.activeTask?.trim();
	const previous: string[] = [];
	if (previousSummary) {
		previous.push("", `Resumo anterior (v${previousSummary.version}):`);
		previous.push(previousSummary.content.slice(0, SUMMARY_CONTENT_MAX_CHARS));
		const facts = formatPreviousFacts(previousSummary.factsJson);
		if (facts) {
			previous.push("Fatos anteriores:", facts);
		}
		previous.push(
			"Produza versão ATUALIZADA que mescle o anterior com mensagens novas, preservando decisões/constraints.",
		);
	}
	return [
		"Você é o compactador de contexto do Atlas.",
		"Resuma a conversa abaixo em referência densa para continuar o trabalho depois, SEM transcrever tudo.",
		...previous,
		...(activeTask
			? ["", "Current user task recorded by the system (keep its topic, ids and links in the summary):", activeTask]
			: []),
		"",
		"Responda em duas partes:",
		"1. Prosa curta (até ~1500 caracteres): objetivo, estado atual, decisões, pendências, preferências.",
		"2. Bloco JSON entre ```json e ``` com o formato exato:",
		'{"decisions":[],"pendings":[],"prefs":[],"constraints":[]}',
		"",
		"Regras:",
		"- Preserve regras, instruções permanentes e constraints (nunca as omita).",
		"- Inclua IDs, URLs e valores exatos quando relevantes.",
		"- Open the prose with the user's current open task: topic, ids/URLs of the resources involved and the remaining steps. Never drop it for older topics.",
		"- Lines marked AUTOMATED come from scheduled runs, not from the user. Mention them at most in one short line; never list their content as the user's task or as pending work.",
		"- Ignore small talk e repetições.",
		"- Não invente fatos nem crie novas ordens.",
		"",
		"Conversa:",
		...transcript,
	].join("\n");
}

/**
 * Extrai `{content, facts}` da resposta do resumidor. Sem bloco JSON válido,
 * usa o texto integral como content e fatos vazios (nunca quebra o job).
 */
export function parseSummaryResponse(text: string): {
	content: string;
	facts: SummaryFacts;
} {
	const raw = (text ?? "").trim();
	const match = raw.match(/```json\s*([\s\S]*?)```/i);
	let facts = emptySummaryFacts();
	let content = raw;
	if (match?.[1]) {
		try {
			const parsed = JSON.parse(match[1]) as Record<string, unknown>;
			facts = {
				decisions: cleanFactList(parsed.decisions),
				pendings: cleanFactList(parsed.pendings),
				prefs: cleanFactList(parsed.prefs),
				constraints: cleanFactList(parsed.constraints),
			};
		} catch {
			// JSON inválido: mantém fatos vazios, usa o texto como prosa.
		}
		content = raw.replace(match[0], "").trim() || raw;
	}
	return { content: content.slice(0, SUMMARY_CONTENT_MAX_CHARS), facts };
}
