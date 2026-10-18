/**
 * Resultado grande de tool por referência (L3). O texto inteiro vai para um
 * artefato do dono (`persistUserArtifact`, tipo `tool_result`) e o contexto
 * guarda só o que o modelo precisa para decidir: contagem, o aviso de corte do
 * conector (L23), o começo e o id para reler com `artifact_read`. Duas faixas:
 *
 *  - acima de `refChars`: o texto continua inteiro no contexto (o modelo ainda
 *    não o leu) e ganha uma linha de referência; quando a higiene encolher o
 *    grupo antigo, a linha sobrevive e o modelo relê em vez de repetir a tool;
 *  - acima de `stubChars`: só o stub (a higiene cortaria de qualquer jeito).
 *
 * O resumo de leitura idêntica (F3b) e o aviso de corte (L23) não se repetem
 * aqui: resultado já trocado por referência curta não é guardado de novo e o
 * aviso de corte é copiado, não reescrito.
 */
export type ResultStoreLimits = { refChars: number; stubChars: number };

export const RESULT_REF_CHARS_DEFAULT = 6_000;
export const RESULT_STUB_CHARS_DEFAULT = 20_000;
export const RESULT_HEAD_CHARS = 3_000;
/** Teto de caracteres guardados por resultado (o artefato aceita 2 MB). */
export const RESULT_MAX_STORED_CHARS = 400_000;
/** Resultados guardados por run (evita encher o disco num laço). */
export const RESULT_MAX_PER_RUN = 40;

/** Tools cujo resultado nunca vira referência (já são leitura de referência, ou meta). */
const NEVER_REFERENCE: ReadonlySet<string> = new Set([
	"artifact_read",
	"read_cached_result",
	"mcp_tool_search",
	"checkpoint_read",
	"research_note",
	"show_image",
	"create_file",
]);

function positiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Limites por env (`ATLAS_CONTEXT_REF_CHARS`, `ATLAS_CONTEXT_STUB_CHARS`); `stub` nunca abaixo de `ref`. */
export function resultStoreLimits(env: Record<string, string | undefined> = process.env): ResultStoreLimits {
	const refChars = positiveInt(env.ATLAS_CONTEXT_REF_CHARS, RESULT_REF_CHARS_DEFAULT);
	const stubChars = Math.max(refChars, positiveInt(env.ATLAS_CONTEXT_STUB_CHARS, RESULT_STUB_CHARS_DEFAULT));
	return { refChars, stubChars };
}

const REF_PATTERN = /\[Full result stored as artifact:([A-Za-z0-9_-]{1,64}) \((\d+) chars\)[^\]]*\]/;
const CLIP_NOTICE_PATTERN = /\[Result truncated: showing[^\]]*\]/;

export type ResultRef = { id: string; chars: number; line: string };

/** Linha de referência embutida no resultado (a higiene a preserva ao encolher). */
export function extractResultRef(text: string): ResultRef | null {
	const match = REF_PATTERN.exec(text);
	return match ? { id: match[1]!, chars: Number(match[2]), line: match[0] } : null;
}

export function stripResultRef(text: string): string {
	const ref = extractResultRef(text);
	return ref ? text.replace(ref.line, "").replace(/\n{3,}/g, "\n\n").trimEnd() : text;
}

const countLines = (text: string): number => (text.match(/\n/g)?.length ?? 0) + 1;

/** Decide a faixa de um resultado: `none`, `ref` (inteiro + linha) ou `stub`. */
export function referenceMode(input: { tool: string; text: string; ok: boolean; limits: ResultStoreLimits }): "none" | "ref" | "stub" {
	if (!input.ok || NEVER_REFERENCE.has(input.tool)) return "none";
	if (extractResultRef(input.text)) return "none";
	if (input.text.length > input.limits.stubChars) return "stub";
	if (input.text.length > input.limits.refChars) return "ref";
	return "none";
}

export function buildReferenceText(input: {
	mode: "ref" | "stub";
	tool: string;
	text: string;
	artifactId: string;
	/** Caracteres de fato guardados no artefato (pode ser menos que o texto). */
	storedChars?: number;
}): string {
	const { text, artifactId, tool } = input;
	const stored = input.storedChars ?? text.length;
	if (input.mode === "ref") {
		return `${text}\n[Full result stored as artifact:${artifactId} (${stored} chars). It stays in context for now; if it is collapsed later, re-read it with artifact_read instead of repeating the call.]`;
	}
	const notice = CLIP_NOTICE_PATTERN.exec(text.slice(-2_000))?.[0];
	return [
		`[Large result: ${tool} returned ${text.length} characters (${countLines(text)} lines); the full text is stored outside the context.]`,
		...(notice ? [notice] : []),
		"Head:",
		text.slice(0, RESULT_HEAD_CHARS),
		`[Full result stored as artifact:${artifactId} (${stored} chars). Read the rest with artifact_read (id, offset) or search inside it with find. Do not assume what you have not read.]`,
	].join("\n");
}

/**
 * Guarda e referencia resultados de uma run. `persist` devolve o id do artefato
 * ou `null` quando não deu para guardar (nesse caso o resultado segue como
 * sempre: a referência é otimização, nunca motivo para falhar a tool).
 */
export function createResultStore(deps: {
	persist: (input: { tool: string; text: string; step: number }) => Promise<string | null>;
	limits?: ResultStoreLimits;
	maxPerRun?: number;
}) {
	const limits = deps.limits ?? resultStoreLimits();
	const maxPerRun = deps.maxPerRun ?? RESULT_MAX_PER_RUN;
	let stored = 0;
	return {
		/** Texto para o contexto (igual ao recebido quando não vale guardar). */
		async reference(input: { tool: string; text: string; ok: boolean; step: number }): Promise<string> {
			const mode = referenceMode({ tool: input.tool, text: input.text, ok: input.ok, limits });
			if (mode === "none" || stored >= maxPerRun) return input.text;
			const storedText = input.text.slice(0, RESULT_MAX_STORED_CHARS);
			const artifactId = await deps
				.persist({ tool: input.tool, text: storedText, step: input.step })
				.catch(() => null);
			if (!artifactId) return input.text;
			stored += 1;
			return buildReferenceText({ mode, tool: input.tool, text: input.text, artifactId, storedChars: storedText.length });
		},
		stored: () => stored,
	};
}
