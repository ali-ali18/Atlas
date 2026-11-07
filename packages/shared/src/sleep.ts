/**
 * Sono do bot (Motor v4, F5.3): a manutenção de fim de dia da memória. Funções puras (sem I/O): horário, quais falas
 * são fonte confiável, o formato do que o modelo propõe, o plano de escrita e os casos de eval das falhas do dia.
 *
 * Critério de promoção, ESTRUTURAL (60-agente: nada de regex sobre texto do dono ou do modelo):
 *  - só a fala do dono (`role: user` e sem `origin`) é fonte. Fala com `origin` (rotina, webhook, e-mail, outro bot) e
 *    qualquer texto de página/arquivo/conector nem chega ao modelo do sono;
 *  - cada fato ou nota proposta cita os ids das falas do dono em que se apoia (`sources`); o código confere que TODOS
 *    os ids existem na janela e são do dono. Sem fonte válida, a proposta é descartada com o motivo;
 *  - duplicata (igualdade normalizada do texto, no mesmo escopo) é descartada; o db ainda confere por embedding quando há;
 *  - o escopo é a conversa direta do bot com o dono: conversa de grupo nunca é lida, então não vaza para o 1:1.
 */
import { z } from "zod";
import { classifyRunFailure, type FailureClass, type RunFailureTrace } from "./run-failure-class.js";
import { isEngineV4Enabled, type EngineV4Gate } from "./engine-policy-v4.js";
import { localParts, normalizeForDedupe } from "./proactive.js";
import { zonedWallTimeToUtc } from "./routine-once.js";
import { OWNER_NOTE_BODY_MAX_CHARS, OWNER_NOTE_TITLE_MAX_CHARS, findDuplicateNote } from "./owner-notes.js";

/** Fim do dia no fuso do dono: o sono roda depois deste horário local, uma vez por dia e por bot. */
export const SLEEP_LOCAL_TIME = "23:30";
/** Janela quando o bot ainda não dormiu nenhuma vez. */
export const SLEEP_FIRST_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SLEEP_MAX_FACTS = 8;
export const SLEEP_MAX_NOTES = 4;
export const SLEEP_MAX_SKILLS = 3;
export const SLEEP_MAX_EVAL_CASES = 5;
export const SLEEP_FACT_MAX_CHARS = 600;
export const SLEEP_SOURCES_MAX = 10;
/** Fala do assistente entra só como contexto para entender a fala do dono; este é o teto de cada uma. */
export const SLEEP_ASSISTANT_CONTEXT_CHARS = 1_500;
/**
 * Limite TÉCNICO de uma chamada (cabe com folga na janela de um modelo barato): ~75 mil tokens de conversa. Dia maior que
 * isso é dividido em mais chamadas em ordem (`chunkSleepTurns`); nada é cortado para economizar.
 */
export const SLEEP_CHUNK_CHARS = 300_000;
/** Decisão do dono: o sono usa o papel de modelo `sleep`. */
export const SLEEP_MODEL_ROLE = "sleep" as const;

export const SLEEP_LAYERS = ["owner", "bot"] as const;
export type SleepLayer = (typeof SLEEP_LAYERS)[number];

/** `key` = dia local do slot (`YYYY-MM-DD`), a chave que impede dois sonos no mesmo dia; `weekday` 0 = domingo. */
export type SleepSlot = { key: string; at: Date; weekday: number };

const pad = (value: number) => String(value).padStart(2, "0");

/** O slot de hoje no fuso do dono (o instante em que o sono deste dia pode começar). */
export function sleepSlotFor(now: Date, timeZone: string): SleepSlot {
	const parts = localParts(now, timeZone);
	const [hour, minute] = SLEEP_LOCAL_TIME.split(":").map(Number) as [number, number];
	return { key: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`, at: zonedWallTimeToUtc({ year: parts.year, month: parts.month, day: parts.day, hour, minute, second: 0 }, timeZone), weekday: parts.weekday };
}

/** Já passou do fim do dia do dono? (a reserva no banco garante uma vez por dia e por bot). */
export function isSleepDue(now: Date, timeZone: string): { due: boolean; slot: SleepSlot } {
	const slot = sleepSlotFor(now, timeZone);
	return { due: now.getTime() >= slot.at.getTime(), slot };
}

/** O "doctor" roda uma vez por semana, no sono de domingo (dia local do dono). */
export function isDoctorDay(slot: SleepSlot): boolean {
	return slot.weekday === 0;
}

/** Janela a ler: do fim do sono anterior (ou 24 h atrás) até este slot. Janelas contíguas: nada fica entre dois sonos. */
export function sleepWindow(input: { slotAt: Date; previousEnd?: Date | null }): { from: Date; to: Date } {
	const to = input.slotAt;
	const fallback = new Date(to.getTime() - SLEEP_FIRST_WINDOW_MS);
	const from = input.previousEnd && input.previousEnd.getTime() < to.getTime() ? input.previousEnd : fallback;
	return { from, to };
}

// ---------------------------------------------------------------------------
// Falas: quem é fonte
// ---------------------------------------------------------------------------

export type SleepMessage = { id: string; role: string; content: string; origin: string | null };
export type SleepTurn = { id: string; speaker: "owner" | "assistant"; text: string };

/**
 * Das mensagens da conversa direta, só entram a fala do dono e (como contexto) a do assistente. Mensagem com `origin`
 * (rotina, webhook, e-mail, outro bot) fica de fora por inteiro: é dado, não fonte, e não deve nem chegar ao modelo.
 */
export function selectSleepTurns(messages: readonly SleepMessage[]): { turns: SleepTurn[]; ownerIds: Set<string>; excluded: number } {
	const turns: SleepTurn[] = [];
	const ownerIds = new Set<string>();
	let excluded = 0;
	for (const message of messages) {
		const text = message.content.trim();
		if (message.origin !== null || text.length === 0) {
			if (message.origin !== null) excluded += 1;
			continue;
		}
		if (message.role === "user") {
			turns.push({ id: message.id, speaker: "owner", text });
			ownerIds.add(message.id);
		} else if (message.role === "assistant") {
			turns.push({ id: message.id, speaker: "assistant", text: text.length > SLEEP_ASSISTANT_CONTEXT_CHARS ? `${text.slice(0, SLEEP_ASSISTANT_CONTEXT_CHARS)} […]` : text });
		} else excluded += 1;
	}
	return { turns, ownerIds, excluded };
}

/** Divide as falas em blocos de até `max` caracteres, em ordem e sem partir uma fala (uma fala maior que o bloco vai sozinha). */
export function chunkSleepTurns(turns: readonly SleepTurn[], max = SLEEP_CHUNK_CHARS): SleepTurn[][] {
	const chunks: SleepTurn[][] = [];
	let current: SleepTurn[] = [];
	let size = 0;
	for (const turn of turns) {
		const cost = turn.text.length + turn.id.length + 16;
		if (current.length > 0 && size + cost > max) {
			chunks.push(current);
			current = [];
			size = 0;
		}
		current.push(turn);
		size += cost;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

/** O que o modelo vê: cada fala com o id (para citar) e quem falou. Texto para o MODELO. */
export function renderSleepTranscript(turns: readonly SleepTurn[]): string {
	return turns.map((turn) => `[${turn.id}] ${turn.speaker === "owner" ? "OWNER" : "assistant (context only, never a source)"}: ${turn.text}`).join("\n\n");
}

// ---------------------------------------------------------------------------
// O que o modelo propõe
// ---------------------------------------------------------------------------

const sources = z.array(z.string().trim().min(1).max(64)).min(1).max(SLEEP_SOURCES_MAX);
const factSchema = z.object({ layer: z.enum(SLEEP_LAYERS), content: z.string().trim().min(1).max(SLEEP_FACT_MAX_CHARS), category: z.string().trim().min(1).max(40).optional(), sources });
const noteSchema = z.object({ title: z.string().trim().min(1).max(OWNER_NOTE_TITLE_MAX_CHARS), body: z.string().trim().min(1).max(OWNER_NOTE_BODY_MAX_CHARS), pinned: z.boolean().optional(), sources });
const skillSchema = z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().min(1).max(240), instructions: z.string().trim().min(1).max(4_000), sources });

export type SleepFactProposal = z.infer<typeof factSchema>;
export type SleepNoteProposal = z.infer<typeof noteSchema>;
export type SleepSkillProposal = z.infer<typeof skillSchema>;
export type SleepProposal = { facts: SleepFactProposal[]; notes: SleepNoteProposal[]; skills: SleepSkillProposal[]; invalid: number };

const itemsOf = (raw: unknown, key: string): unknown[] => {
	const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)[key] : undefined;
	return Array.isArray(value) ? value : [];
};

/** Lê os argumentos da tool `submit` do sono. Item inválido é contado e descartado; o resto segue (o modelo erra um campo, não o dia todo). */
export function parseSleepProposal(raw: unknown): SleepProposal {
	let invalid = 0;
	const take = <T>(key: string, schema: z.ZodType<T>, max: number): T[] => {
		const out: T[] = [];
		for (const item of itemsOf(raw, key)) {
			const parsed = schema.safeParse(item);
			if (parsed.success && out.length < max) out.push(parsed.data);
			else invalid += 1;
		}
		return out;
	};
	return { facts: take("facts", factSchema, SLEEP_MAX_FACTS), notes: take("notes", noteSchema, SLEEP_MAX_NOTES), skills: take("skills", skillSchema, SLEEP_MAX_SKILLS), invalid };
}

export const SLEEP_SKIP_REASONS = ["no_source", "untrusted_source", "duplicate", "invalid"] as const;
export type SleepSkipReason = (typeof SLEEP_SKIP_REASONS)[number];
export type SleepSkipped = { kind: "fact" | "note" | "skill"; reason: SleepSkipReason; text: string };

export type SleepExisting = {
	facts: ReadonlyArray<{ layer: SleepLayer; content: string }>;
	notes: ReadonlyArray<{ id: string; body: string; botId: string | null }>;
};

export type SleepPlan = { facts: SleepFactProposal[]; notes: SleepNoteProposal[]; skills: SleepSkillProposal[]; skipped: SleepSkipped[] };

/** O item cita só falas do dono desta janela? Sem citação, ou com id de fala do assistente/inexistente, não é fonte. */
export function sourceVerdict(cited: readonly string[], ownerIds: ReadonlySet<string>): "ok" | "no_source" | "untrusted_source" {
	if (cited.length === 0) return "no_source";
	return cited.every((id) => ownerIds.has(id)) ? "ok" : "untrusted_source";
}

/**
 * Do que o modelo propôs ao que o sono pode escrever. Só passa o que tem fonte confiável e não repete o que já existe
 * (nem outro item do mesmo lote). Habilidades nunca são escritas aqui: viram proposta para o dono.
 */
export function planSleepWrites(input: { proposal: SleepProposal; ownerIds: ReadonlySet<string>; existing: SleepExisting; botId: string }): SleepPlan {
	const plan: SleepPlan = { facts: [], notes: [], skills: [], skipped: [] };
	const seenFacts = new Set(input.existing.facts.map((fact) => `${fact.layer}\n${normalizeForDedupe(fact.content)}`));
	const seenNotes: Array<{ id: string; body: string; botId: string | null }> = [...input.existing.notes];
	for (const fact of input.proposal.facts) {
		const verdict = sourceVerdict(fact.sources, input.ownerIds);
		if (verdict !== "ok") {
			plan.skipped.push({ kind: "fact", reason: verdict, text: fact.content });
			continue;
		}
		const key = `${fact.layer}\n${normalizeForDedupe(fact.content)}`;
		if (normalizeForDedupe(fact.content).length === 0) plan.skipped.push({ kind: "fact", reason: "invalid", text: fact.content });
		else if (seenFacts.has(key)) plan.skipped.push({ kind: "fact", reason: "duplicate", text: fact.content });
		else {
			seenFacts.add(key);
			plan.facts.push(fact);
		}
	}
	for (const note of input.proposal.notes) {
		const verdict = sourceVerdict(note.sources, input.ownerIds);
		if (verdict !== "ok") {
			plan.skipped.push({ kind: "note", reason: verdict, text: note.title });
			continue;
		}
		if (findDuplicateNote(seenNotes, { body: note.body, botId: input.botId })) plan.skipped.push({ kind: "note", reason: "duplicate", text: note.title });
		else {
			seenNotes.push({ id: `planned:${plan.notes.length}`, body: note.body, botId: input.botId });
			plan.notes.push(note);
		}
	}
	for (const skill of input.proposal.skills) {
		const verdict = sourceVerdict(skill.sources, input.ownerIds);
		if (verdict === "ok") plan.skills.push(skill);
		else plan.skipped.push({ kind: "skill", reason: verdict, text: skill.name });
	}
	return plan;
}

// ---------------------------------------------------------------------------
// Casos de eval a partir das falhas do dia
// ---------------------------------------------------------------------------

export type SleepRunRecord = {
	runId: string;
	origin: string;
	status: string;
	stopReason: string | null;
	/** Objetivo do run: para run de chat é a fala do dono que o abriu. */
	objective: string;
	journal: ReadonlyArray<{ step: number; toolName: string; outcome: string }>;
};

/**
 * Traço estrutural de um run v4 a partir do que o banco guarda (parada e journal). Só preenche o que o banco sabe: sem
 * `transportErrors`, validação ou tarefas abertas, essas classes não são acusadas (nunca se inventa causa).
 */
export function traceFromRunRecord(run: SleepRunRecord): RunFailureTrace {
	const byStep = new Map<number, Array<{ name: string; ok: boolean }>>();
	for (const entry of run.journal) {
		const list = byStep.get(entry.step) ?? [];
		list.push({ name: entry.toolName, ok: entry.outcome === "succeeded" });
		byStep.set(entry.step, list);
	}
	const steps = [...byStep.entries()].sort((a, b) => a[0] - b[0]).map(([, toolCalls]) => ({ toolCalls }));
	return {
		steps,
		stop: { reason: run.stopReason },
		staleTaskInjected: false,
		declinedOffers: [],
		openTaskItemsAtEnd: 0,
		endedWithoutTool: false,
		repetitionBlocked: run.stopReason === "loop_repeat",
		compactionHappened: false,
		reReadAfterCompactionEmpty: false,
		approvalCardForReadEffect: false,
		denyLaterAllowedByOwner: false,
	};
}

export type EvalCaseProposal = { id: string; runId: string; failureClass: FailureClass; evidence: string[]; input: string };
export const EVAL_CASE_INPUT_MAX_CHARS = 600;

/** Casos de eval propostos: um por run de chat com falha classificada. Só proposta; quem promove a caso do eval é o dono. */
export function evalCasesFromRuns(runs: readonly SleepRunRecord[]): EvalCaseProposal[] {
	const cases: EvalCaseProposal[] = [];
	for (const run of runs) {
		if (run.origin !== "chat" || cases.length >= SLEEP_MAX_EVAL_CASES) continue;
		const verdict = classifyRunFailure(traceFromRunRecord(run));
		if (verdict.primary === "none") continue;
		cases.push({ id: `eval:${run.runId}`, runId: run.runId, failureClass: verdict.primary, evidence: verdict.evidence, input: run.objective.slice(0, EVAL_CASE_INPUT_MAX_CHARS) });
	}
	return cases;
}

// ---------------------------------------------------------------------------
// Relatório e propostas guardadas
// ---------------------------------------------------------------------------

export const SLEEP_REPORT_KINDS = ["daily", "doctor"] as const;
export type SleepReportKind = (typeof SLEEP_REPORT_KINDS)[number];
export const SLEEP_REPORT_STATUSES = ["running", "done", "skipped", "failed"] as const;
export type SleepReportStatus = (typeof SLEEP_REPORT_STATUSES)[number];
export const SLEEP_PROPOSAL_STATUSES = ["open", "dismissed"] as const;
export type SleepProposalStatus = (typeof SLEEP_PROPOSAL_STATUSES)[number];

export type SleepStoredProposal =
	| { id: string; kind: "skill"; status: SleepProposalStatus; name: string; description: string; instructions: string }
	| { id: string; kind: "eval_case"; status: SleepProposalStatus; runId: string; failureClass: FailureClass; evidence: string[]; input: string }
	| { id: string; kind: "doctor"; status: SleepProposalStatus; finding: DoctorFinding };

/** Achado do doctor: sempre uma proposta; nada é apagado sozinho. `ids` são ids de memória ou de nota do dono. */
export type DoctorFinding = { type: "duplicate" | "conflict" | "stale"; subject: "memory" | "note"; ids: string[]; reason: string };

export type SleepReportView = {
	id: string;
	botId: string;
	kind: SleepReportKind;
	/** Dia local (daily) ou domingo da semana (doctor), `YYYY-MM-DD`. */
	slot: string;
	status: SleepReportStatus;
	summary: string | null;
	proposals: SleepStoredProposal[];
	stats: Record<string, number>;
	createdAt: string;
	finishedAt: string | null;
};

export function skillProposalId(runKeySlot: string, name: string): string {
	return `skill:${runKeySlot}:${normalizeForDedupe(name).replace(/ /g, "-").slice(0, 40)}`;
}

export function readStoredProposals(raw: unknown): SleepStoredProposal[] {
	if (!Array.isArray(raw)) return [];
	return raw.filter((item): item is SleepStoredProposal => {
		if (typeof item !== "object" || item === null) return false;
		const value = item as Record<string, unknown>;
		return typeof value.id === "string" && (value.kind === "skill" || value.kind === "eval_case" || value.kind === "doctor") && (value.status === "open" || value.status === "dismissed");
	});
}

/** Chave em `policyJson` que liga/desliga o sono do bot. */
export const SLEEP_POLICY_KEY = "sleep";

/** O sono é padrão para o bot (conta no v4). O dono desliga por bot com `policyJson.sleep = false`; qualquer outro valor mantém ligado. */
export function readSleepEnabled(policyJson: unknown): boolean {
	if (typeof policyJson !== "object" || policyJson === null || Array.isArray(policyJson)) return true;
	return (policyJson as Record<string, unknown>)[SLEEP_POLICY_KEY] !== false;
}

/**
 * O sono substitui a reflexão diária do v2 (auditoria F5, R1). As duas fazem a mesma manutenção da memória a partir da
 * conversa; rodar as duas na mesma conta duplicaria chamadas ao modelo (2 por dia) e escritas. Para conta no v4 cujo bot
 * principal dorme (sono ligado e conversa direta existente), a reflexão AGENDADA não roda. "Refletir agora" (pedido
 * manual) continua valendo, e quem desliga o sono do bot principal volta a ter a reflexão. Decisão estrutural: flag da
 * conta, configuração do bot e existência da conversa; nenhum texto.
 * Não reaproveita `bot-lessons`: lições vêm da revisão de correções dos runs, outra fonte e outro destino.
 */
export function sleepReplacesScheduledReflection(gate: EngineV4Gate | undefined, userId: string, primaryBot: { conversationId: string | null; policyJson: unknown }): boolean {
	return isEngineV4Enabled(gate, userId) && primaryBot.conversationId !== null && readSleepEnabled(primaryBot.policyJson);
}

export type SleepSummaryCounts = { facts: number; notes: number; skills: number; evalCases: number };
export type SleepSummaryLanguage = "pt" | "en" | "es";

/** Idioma do resumo a partir do idioma do bot (padrão pt-BR; "auto" e desconhecido também). */
export function sleepSummaryLanguage(botLanguage: unknown): SleepSummaryLanguage {
	const value = typeof botLanguage === "string" ? botLanguage.toLowerCase() : "";
	return value.startsWith("en") ? "en" : value.startsWith("es") ? "es" : "pt";
}

const SUMMARY_WORDS = {
	pt: { none: "Nada novo para guardar hoje.", saved: "Guardei", fact: ["fato", "fatos"], note: ["nota", "notas"], propose: "Tenho para você olhar", skill: ["habilidade", "habilidades"], eval: ["caso de teste das falhas", "casos de teste das falhas"], tail: "Dá para desfazer cada mudança.", and: "e" },
	en: { none: "Nothing new to keep today.", saved: "I saved", fact: ["fact", "facts"], note: ["note", "notes"], propose: "For you to review", skill: ["skill", "skills"], eval: ["test case from failures", "test cases from failures"], tail: "Every change can be undone.", and: "and" },
	es: { none: "Nada nuevo que guardar hoy.", saved: "Guardé", fact: ["dato", "datos"], note: ["nota", "notas"], propose: "Para que revises", skill: ["habilidad", "habilidades"], eval: ["caso de prueba de fallos", "casos de prueba de fallos"], tail: "Puedes deshacer cada cambio.", and: "y" },
} as const;

/** Resumo de uma frase para o dono, sem nome interno (pt-BR por padrão). */
export function sleepSummary(counts: SleepSummaryCounts, language: SleepSummaryLanguage = "pt"): string {
	const w = SUMMARY_WORDS[language];
	const list = (items: Array<[number, readonly [string, string]]>) => {
		const parts = items.filter(([n]) => n > 0).map(([n, [one, many]]) => `${n} ${n === 1 ? one : many}`);
		return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} ${w.and} ${parts.at(-1)}`;
	};
	const saved = list([[counts.facts, w.fact], [counts.notes, w.note]]);
	const proposed = list([[counts.skills, w.skill], [counts.evalCases, w.eval]]);
	if (!saved && !proposed) return w.none;
	return [saved && `${w.saved} ${saved}.`, proposed && `${w.propose}: ${proposed}.`, saved && w.tail].filter(Boolean).join(" ");
}
