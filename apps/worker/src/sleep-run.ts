/**
 * Sono de um bot (F5.3): a manutenção de fim de dia da memória. Toda dependência de fora entra por `SleepPorts` (banco, modelo),
 * então o fluxo inteiro roda em teste com um modelo roteirizado. Sem I/O próprio.
 *
 * Fluxo diário: lê as falas do dia da conversa DIRETA do bot → só as do dono são fonte (`selectSleepTurns`) → UMA chamada ao
 * modelo `sleep` por bloco (um dia comum é um bloco; só passa de um se a conversa passar do limite técnico da janela do modelo)
 * → o código confere as fontes e a duplicata (`planSleepWrites`) → escreve fatos e notas pelas mesmas funções da UI (cada uma
 * grava a mudança no histórico desfazível) → habilidades e casos de eval das falhas viram PROPOSTA no relatório.
 *
 * O que o sono NUNCA faz: apagar ou editar o que já existe, fixar nota, mexer no perfil do bot, ler conversa de grupo.
 */
import { renderSleepTranscript, selectSleepTurns, chunkSleepTurns, evalCasesFromRuns, planSleepWrites, parseSleepProposal, parseConflictFindings, analyzeMemoryHealth, doctorSummary, skillProposalId, doctorProposalId, sleepSummary, sleepSummaryLanguage, SLEEP_CHUNK_CHARS, SLEEP_MODEL_ROLE, type DoctorFinding, type OwnerNoteView, type SleepFactProposal, type SleepNoteProposal, type SleepProposal, type SleepStoredProposal } from "@workspace/shared";
import type { Llm, LlmUsage } from "@workspace/agent";
import type { SleepDayInput } from "@workspace/db";
import { SUBMIT_DOCTOR_SPEC, SUBMIT_DOCTOR_TOOL, SUBMIT_SLEEP_SPEC, SUBMIT_SLEEP_TOOL, DOCTOR_SYSTEM_PROMPT, SLEEP_SYSTEM_PROMPT, buildDoctorUserMessage, buildSleepUserMessage } from "./sleep-prompt.js";

export type SleepFactResult = { status: "added" } | { status: "duplicate" } | { status: "rejected"; reason: string };

export type SleepPorts = {
	llm: Llm;
	/** Falas, runs e notas do dia da conversa direta do bot; `null` = bot sem conversa direta. */
	loadDay(window: { from: Date; to: Date }): Promise<SleepDayInput | null>;
	/** Fatos já salvos (perfil do dono e camada do bot), para não repetir. */
	existingFacts(): Promise<Array<{ layer: "owner" | "bot"; content: string }>>;
	/** Escreve um fato pela mesma função da UI/chat (duplicata por embedding quando há, limite, filtro de segurança). */
	addFact(fact: Pick<SleepFactProposal, "layer" | "content" | "category">): Promise<SleepFactResult>;
	/** Escreve uma nota do bot (nunca fixada). */
	addNote(note: Pick<SleepNoteProposal, "title" | "body">): Promise<{ status: "added" } | { status: "duplicate" } | { status: "rejected"; reason: string }>;
};

export type SleepOutcome = {
	status: "done" | "skipped";
	detail?: string;
	summary: string | null;
	proposals: SleepStoredProposal[];
	stats: Record<string, number>;
};

type Usage = { calls: number; inputTokens: number; outputTokens: number; costUsd: number };
const addUsage = (total: Usage, usage: LlmUsage | undefined): void => {
	total.calls += 1;
	total.inputTokens += usage?.inputTokens ?? 0;
	total.outputTokens += usage?.outputTokens ?? 0;
	total.costUsd += usage?.costUsd ?? 0;
};
const usageStats = (usage: Usage): Record<string, number> => ({ llmCalls: usage.calls, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: Math.round(usage.costUsd * 1_000_000) / 1_000_000 });

/** Falha de um sono com o uso do modelo até ali: o gasto de uma tentativa que falhou também é registrado (C1). */
export class SleepRunError extends Error {
	constructor(message: string, readonly stats: Record<string, number>, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "SleepRunError";
	}
}

const withUsageOnFailure = async <T>(usage: Usage, body: () => Promise<T>): Promise<T> => {
	try {
		return await body();
	} catch (error) {
		throw new SleepRunError(error instanceof Error ? error.message : String(error), usageStats(usage), { cause: error });
	}
};

/** Uma chamada ao papel `sleep` com UMA tool; devolve os argumentos dela (ou `undefined` se o modelo não a chamou). */
async function callSleepModel(llm: Llm, input: { system: string; user: string; tool: typeof SUBMIT_SLEEP_SPEC; usage: Usage; signal?: AbortSignal }): Promise<unknown> {
	let args: unknown;
	for await (const event of llm.chat({ role: SLEEP_MODEL_ROLE, messages: [{ role: "system", content: input.system }, { role: "user", content: input.user }], tools: [input.tool], ...(input.signal && { signal: input.signal }) })) {
		if (event.type === "tool_call" && event.call.name === input.tool.name && args === undefined) args = event.call.args;
		else if (event.type === "done") addUsage(input.usage, event.usage);
	}
	return args;
}

const mergeProposals = (parts: SleepProposal[]): SleepProposal => ({ facts: parts.flatMap((p) => p.facts), notes: parts.flatMap((p) => p.notes), skills: parts.flatMap((p) => p.skills), invalid: parts.reduce((sum, p) => sum + p.invalid, 0) });

export async function runDailySleep(input: { ports: SleepPorts; botId: string; window: { from: Date; to: Date }; slotKey: string; language: unknown; signal?: AbortSignal }): Promise<SleepOutcome> {
	const usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
	return withUsageOnFailure(usage, () => dailySleepBody(input, usage));
}

async function dailySleepBody(input: { ports: SleepPorts; botId: string; window: { from: Date; to: Date }; slotKey: string; language: unknown; signal?: AbortSignal }, usage: Usage): Promise<SleepOutcome> {
	const { ports } = input;
	const day = await ports.loadDay(input.window);
	if (!day) return { status: "skipped", detail: "sem conversa direta", summary: null, proposals: [], stats: {} };

	const { turns, ownerIds, excluded } = selectSleepTurns(day.messages);
	const evalCases = evalCasesFromRuns(day.runs);
	const proposals: SleepStoredProposal[] = evalCases.map((c) => ({ id: c.id, kind: "eval_case", status: "open", runId: c.runId, failureClass: c.failureClass, evidence: c.evidence, input: c.input }));
	const counts = { facts: 0, notes: 0, skills: 0, evalCases: evalCases.length };
	const skipped = { duplicate: 0, untrusted: 0, invalid: 0, rejected: 0, invalidItems: 0 };

	// Sem fala do dono e sem falha para registrar não há o que fazer: dia quieto, nenhuma chamada ao modelo (custo zero).
	if (ownerIds.size === 0 && evalCases.length === 0) return { status: "skipped", detail: "sem fala do dono na janela", summary: null, proposals: [], stats: { messages: day.messages.length, ownerMessages: 0, excludedMessages: excluded } };
	// Sem fala do dono não há fonte: nenhuma chamada ao modelo (custo zero). Os casos de eval das falhas ainda valem.
	if (ownerIds.size > 0) {
		const existingFacts = await ports.existingFacts();
		const saved = { facts: existingFacts, noteTitles: day.notes.map((note) => note.title) };
		const parts: SleepProposal[] = [];
		const chunks = chunkSleepTurns(turns, SLEEP_CHUNK_CHARS);
		for (const chunk of chunks) {
			const args = await callSleepModel(ports.llm, { system: SLEEP_SYSTEM_PROMPT, user: buildSleepUserMessage({ saved, transcript: renderSleepTranscript(chunk) }), tool: SUBMIT_SLEEP_SPEC, usage, ...(input.signal && { signal: input.signal }) });
			parts.push(parseSleepProposal(args));
		}
		const proposal = mergeProposals(parts);
		skipped.invalidItems = proposal.invalid;
		const plan = planSleepWrites({ proposal, ownerIds, existing: { facts: existingFacts, notes: day.notes.map((n) => ({ id: n.id, body: n.body, botId: n.botId })) }, botId: input.botId });
		for (const item of plan.skipped) {
			if (item.reason === "duplicate") skipped.duplicate += 1;
			else if (item.reason === "invalid") skipped.invalid += 1;
			else skipped.untrusted += 1;
		}
		for (const fact of plan.facts) {
			const result = await ports.addFact({ layer: fact.layer, content: fact.content, ...(fact.category && { category: fact.category }) });
			if (result.status === "added") counts.facts += 1;
			else if (result.status === "duplicate") skipped.duplicate += 1;
			else skipped.rejected += 1;
		}
		for (const note of plan.notes) {
			const result = await ports.addNote({ title: note.title, body: note.body });
			if (result.status === "added") counts.notes += 1;
			else if (result.status === "duplicate") skipped.duplicate += 1;
			else skipped.rejected += 1;
		}
		for (const skill of plan.skills) proposals.push({ id: skillProposalId(input.slotKey, skill.name), kind: "skill", status: "open", name: skill.name, description: skill.description, instructions: skill.instructions });
		counts.skills = plan.skills.length;
	}

	return {
		status: "done",
		summary: sleepSummary(counts, sleepSummaryLanguage(input.language)),
		proposals,
		stats: { messages: day.messages.length, ownerMessages: ownerIds.size, excludedMessages: excluded, skippedDuplicate: skipped.duplicate, skippedUntrusted: skipped.untrusted, skippedInvalid: skipped.invalid + skipped.invalidItems, rejected: skipped.rejected, facts: counts.facts, notes: counts.notes, skills: counts.skills, evalCases: counts.evalCases, ...usageStats(usage) },
	};
}

// ---------------------------------------------------------------------------
// Doctor semanal
// ---------------------------------------------------------------------------

export type DoctorPorts = {
	llm: Llm;
	memory(): Promise<Array<{ id: string; scope: string; content: string; updatedAt: Date; validUntil: Date | null }>>;
	notes(): Promise<OwnerNoteView[]>;
};

/**
 * Relatório da saúde da memória: duplicatas e itens velhos por regra, conflitos por UMA chamada ao modelo `sleep` (só se
 * houver 2+ itens). Tudo vira proposta com `status: open`; o doctor nunca apaga nem edita nada.
 */
export async function runDoctor(input: { ports: DoctorPorts; now: Date; slotKey: string; language: unknown; signal?: AbortSignal }): Promise<SleepOutcome> {
	const usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
	return withUsageOnFailure(usage, () => doctorBody(input, usage));
}

async function doctorBody(input: { ports: DoctorPorts; now: Date; slotKey: string; language: unknown; signal?: AbortSignal }, usage: Usage): Promise<SleepOutcome> {
	const memory = await input.ports.memory();
	const notes = await input.ports.notes();
	const findings: DoctorFinding[] = analyzeMemoryHealth({
		memory: memory.map((m) => ({ id: m.id, scope: m.scope, content: m.content, updatedAt: m.updatedAt, validUntil: m.validUntil })),
		notes: notes.map((n) => ({ id: n.id, scope: n.botId === null ? "owner" : "bot", title: n.title, body: n.body, updatedAt: n.updatedAt })),
		now: input.now,
	});
	let notesCompared = notes.length;
	if (memory.length + notes.length >= 2) {
		// Limite técnico da janela do modelo: notas entram inteiras, das mais recentes, até o teto; o resto fica de fora desta comparação.
		let budget = SLEEP_CHUNK_CHARS - memory.reduce((sum, m) => sum + m.content.length + m.id.length + 16, 0);
		const sent: OwnerNoteView[] = [];
		for (const note of notes) {
			const cost = note.title.length + note.body.length + note.id.length + 16;
			if (cost > budget) continue;
			budget -= cost;
			sent.push(note);
		}
		notesCompared = sent.length;
		const args = await callSleepModel(input.ports.llm, { system: DOCTOR_SYSTEM_PROMPT, user: buildDoctorUserMessage({ memory, notes: sent }), tool: SUBMIT_DOCTOR_SPEC, usage, ...(input.signal && { signal: input.signal }) });
		findings.push(...parseConflictFindings(args, { memory: new Set(memory.map((m) => m.id)), note: new Set(sent.map((n) => n.id)) }));
	}
	const proposals: SleepStoredProposal[] = findings.map((finding) => ({ id: doctorProposalId(input.slotKey, finding), kind: "doctor", status: "open", finding }));
	return {
		status: "done",
		summary: doctorSummary(findings),
		proposals,
		stats: { memoryItems: memory.length, notes: notes.length, notesCompared, duplicates: findings.filter((f) => f.type === "duplicate").length, conflicts: findings.filter((f) => f.type === "conflict").length, stale: findings.filter((f) => f.type === "stale").length, ...usageStats(usage) },
	};
}

export { SUBMIT_DOCTOR_TOOL, SUBMIT_SLEEP_TOOL };
