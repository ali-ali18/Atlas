import type { ChatTool } from "@workspace/llm";
import type { ResearchNote } from "@workspace/shared";

/**
 * `research_note` (F3): memória de trabalho da pesquisa. O modelo registra o que
 * achou em cada fonte (achado + fonte + confiança) em vez de manter tudo no
 * contexto ou reler a página. As notas vão no checkpoint (sobrevivem a higiene
 * de contexto e a resume) e voltam a cada passo como camada efêmera, sem mutar
 * o histórico. Tudo aqui é puro: o loop só injeta e persiste.
 */

export const RESEARCH_NOTE_TOOL_NAME = "research_note";

export const RESEARCH_NOTE_TOOL: ChatTool = {
	type: "function",
	function: {
		name: RESEARCH_NOTE_TOOL_NAME,
		description:
			"Saves a compact note about a source you just read (finding, key facts, links, confidence). Saved notes are shown back to you on every step, so you do not need to re-read the source. Use it after reading a page or result that matters for the task, then move on. Do not use it for plans, opinions or the final answer. Notes about the same source replace the older one.",
		parameters: {
			type: "object",
			properties: {
				sourceRef: { type: "string", description: "URL or artifact id of the source (max 300 chars)." },
				findings: { type: "string", description: "What this source established (max 500 chars)." },
				keyFacts: { type: "array", items: { type: "string" }, description: "Short verifiable facts, numbers or quotes (up to 8, 200 chars each)." },
				links: { type: "array", items: { type: "string" }, description: "Useful http(s) links found in the source (up to 8)." },
				confidence: { type: "string", enum: ["high", "medium", "low"], description: "How reliable the source is (default medium)." },
			},
			required: ["sourceRef", "findings"],
		},
	},
};

export const RESEARCH_NOTES_MAX = 40;
export const RESEARCH_NOTE_SOURCE_MAX = 300;
export const RESEARCH_NOTE_FINDINGS_MAX = 500;
export const RESEARCH_NOTE_FACTS_MAX = 8;
export const RESEARCH_NOTE_FACT_CHARS = 200;
export const RESEARCH_NOTE_LINKS_MAX = 8;
/** Orçamento próprio da camada efêmera (caracteres, ~1,5k tokens). */
export const RESEARCH_NOTES_LAYER_CHARS = 6_000;
/**
 * Notas de runs anteriores da conversa (ex.: a pesquisa que o usuário agora quer em PDF).
 * Piso de 1,5k; sem notas novas no run, o que sobra do orçamento total vai para elas
 * (teto 12k, ~3k tokens), senão o arquivo sairia só com as 3 notas mais recentes.
 */
const PRIOR_MIN_CHARS = 1_500;
export const RESEARCH_NOTES_PRIOR_CHARS = 12_000;
export const RESEARCH_NOTES_PRIOR_MAX = 40;

const CONFIDENCES = new Set(["high", "medium", "low"]);

function clean(value: unknown, max: number): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function stringList(value: unknown, maxItems: number, maxChars: number, filter?: (item: string) => boolean): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		const text = clean(item, maxChars);
		if (!text || (filter && !filter(text))) continue;
		out.push(text);
		if (out.length >= maxItems) break;
	}
	return out;
}

const isHttpUrl = (text: string) => /^https?:\/\/\S+$/i.test(text);

/** Valida os args do modelo; lança com a dica de correção (resultado honesto). */
export function parseResearchNoteArgs(args: Record<string, unknown>, step: number): ResearchNote {
	const sourceRef = clean(args.sourceRef, RESEARCH_NOTE_SOURCE_MAX);
	if (!sourceRef) throw new Error("sourceRef is required: pass the URL or artifact id of the source.");
	const findings = clean(args.findings, RESEARCH_NOTE_FINDINGS_MAX);
	if (!findings) throw new Error("findings is required: one or two sentences on what the source established.");
	if (args.confidence !== undefined && !CONFIDENCES.has(String(args.confidence))) {
		throw new Error("confidence must be one of: high, medium, low.");
	}
	return {
		sourceRef,
		findings,
		keyFacts: stringList(args.keyFacts, RESEARCH_NOTE_FACTS_MAX, RESEARCH_NOTE_FACT_CHARS),
		links: stringList(args.links, RESEARCH_NOTE_LINKS_MAX, RESEARCH_NOTE_SOURCE_MAX, isHttpUrl),
		confidence: (args.confidence as ResearchNote["confidence"] | undefined) ?? "medium",
		step: Math.max(0, Math.floor(step)),
	};
}

/** Lê notas de um checkpoint/db sem confiar no formato (JSON de fora). */
export function parseResearchNotes(raw: unknown, max = RESEARCH_NOTES_MAX): ResearchNote[] {
	if (!Array.isArray(raw)) return [];
	const out: ResearchNote[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		try {
			const entry = item as Record<string, unknown>;
			const step = typeof entry.step === "number" && Number.isFinite(entry.step) ? entry.step : 0;
			out.push(parseResearchNoteArgs(entry, step));
		} catch {
			// nota corrompida: ignora, o resto do checkpoint segue valendo
		}
	}
	return out.slice(-max);
}

export type ResearchNotes = ReturnType<typeof createResearchNotes>;

/**
 * Notas do run (ordem de gravação) + notas de runs anteriores da mesma conversa
 * (somente leitura, já escopadas por dono no carregamento).
 */
export function createResearchNotes(initial?: unknown, prior?: unknown) {
	let notes = parseResearchNotes(initial);
	// Mesma fonte em runs diferentes: a nota mais nova vence (a lista chega do mais antigo ao mais novo).
	const earlier = dedupeBySource(parseResearchNotes(prior, 200)).slice(-RESEARCH_NOTES_PRIOR_MAX);
	return {
		/** Grava (mesma fonte substitui a anterior); passa o teto, a mais antiga sai. */
		add(note: ResearchNote): { total: number; replaced: boolean } {
			const replaced = notes.some((item) => item.sourceRef === note.sourceRef);
			notes = [...notes.filter((item) => item.sourceRef !== note.sourceRef), note].slice(-RESEARCH_NOTES_MAX);
			return { total: notes.length, replaced };
		},
		snapshot(): ResearchNote[] {
			return structuredClone(notes);
		},
		count(): number {
			return notes.length;
		},
		hasAny(): boolean {
			return notes.length > 0 || earlier.length > 0;
		},
		/** Camada efêmera: mais novas primeiro, dentro de orçamento próprio. Null sem notas. */
		layer(options?: { deliver?: boolean }): string | null {
			if (!notes.length && !earlier.length) return null;
			const currentBudget = earlier.length ? RESEARCH_NOTES_LAYER_CHARS - PRIOR_MIN_CHARS : RESEARCH_NOTES_LAYER_CHARS;
			const head = [
				"Research notes so far (newest first). They are your working memory: use them instead of re-reading sources.",
				...(options?.deliver ? ["Budget is nearly used: write the requested file now from these notes and name the gaps."] : []),
			].join(" ");
			const current = fit([...notes].reverse().map(renderNote), currentBudget);
			const parts = [head, ...current];
			if (earlier.length) {
				const used = current.reduce((sum, line) => sum + line.length, 0);
				const priorBudget = Math.min(RESEARCH_NOTES_PRIOR_CHARS, Math.max(PRIOR_MIN_CHARS, RESEARCH_NOTES_PRIOR_CHARS - used));
				parts.push("From earlier runs in this conversation: if the user wants a file about this research, build it from ALL of these notes and do not re-read these sources.");
				parts.push(...fit([...earlier].reverse().map(renderNote), priorBudget));
			}
			return parts.join("\n");
		},
	};
}

/** Orçamento das notas anexadas ao relatório de um subagente (caracteres). */
export const CHILD_REPORT_NOTES_CHARS = 3_000;

/**
 * Notas de um subagente no fim do relatório dele: o pai as recebe junto do
 * texto e as notas também entram na camada do pai. Vazio sem notas.
 */
export function renderNotesForReport(notes: readonly ResearchNote[], budget = CHILD_REPORT_NOTES_CHARS): string {
	if (!notes.length) return "";
	const lines = fit([...notes].reverse().map(renderNote), budget);
	return ["Research notes from this sub-agent (sources it read):", ...lines].join("\n");
}

function dedupeBySource(list: ResearchNote[]): ResearchNote[] {
	const latest = new Map<string, ResearchNote>();
	for (const note of list) {
		latest.delete(note.sourceRef);
		latest.set(note.sourceRef, note);
	}
	return [...latest.values()];
}

function renderNote(note: ResearchNote): string {
	const facts = note.keyFacts.length ? ` Facts: ${note.keyFacts.join("; ")}.` : "";
	const links = note.links.length ? ` Links: ${note.links.join(" ")}` : "";
	return `- [${note.confidence}] ${note.sourceRef}: ${note.findings}${facts}${links}`;
}

function fit(lines: string[], budget: number): string[] {
	const kept: string[] = [];
	let used = 0;
	for (const line of lines) {
		if (used + line.length > budget && kept.length > 0) break;
		kept.push(line.length > budget ? `${line.slice(0, budget - 1)}…` : line);
		used += line.length;
	}
	const omitted = lines.length - kept.length;
	if (omitted > 0) kept.push(`(+${omitted} older note(s) omitted)`);
	return kept;
}

/** Resultado da tool (curto: a nota inteira já volta na camada). */
export function executeResearchNote(
	args: Record<string, unknown>,
	ctx: { researchNotes?: ResearchNotes; currentStep?: () => number },
): { summary: string } {
	if (!ctx.researchNotes) throw new Error("research_note is not available in this run.");
	const note = parseResearchNoteArgs(args, ctx.currentStep?.() ?? 0);
	const { total, replaced } = ctx.researchNotes.add(note);
	return {
		summary: `Note ${replaced ? "updated" : "saved"} (${total}/${RESEARCH_NOTES_MAX}). It will be shown back to you on every step; continue with the next source or write the deliverable.`,
	};
}
