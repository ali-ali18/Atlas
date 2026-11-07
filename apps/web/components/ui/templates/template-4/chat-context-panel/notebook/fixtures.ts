import type { LearnedRuleView, MemoryChange, OwnerNoteView, SleepReportView } from "@workspace/shared";

/** Dados falsos do Caderno para testes e prévias. */
export const NOW = new Date("2026-11-07T15:00:00.000Z");

export const note = (patch: Partial<OwnerNoteView> = {}): OwnerNoteView => ({
	id: "n1",
	botId: null,
	title: "Roteiro de Lisboa",
	body: "Chegada dia 12, hotel perto do Chiado. Jantar no Time Out Market.",
	pinned: false,
	source: "owner",
	createdAt: "2026-11-05T10:00:00.000Z",
	updatedAt: "2026-11-07T13:00:00.000Z",
	...patch,
});

export const rule = (patch: Partial<LearnedRuleView> = {}): LearnedRuleView => ({
	id: "rule_1",
	match: "*",
	effect: "send",
	verdict: "approve",
	note: null,
	source: "learned",
	learnedAt: "2026-11-04T10:00:00.000Z",
	...patch,
});

export const change = (patch: Partial<MemoryChange> = {}): MemoryChange => ({
	id: "c1",
	botId: "b1",
	entryId: "e1",
	target: "memory",
	action: "add",
	before: null,
	after: "Prefere café sem açúcar",
	source: "sleep",
	undoOfId: null,
	createdAt: "2026-11-07T02:30:00.000Z",
	undoneAt: null,
	reportId: "r1",
	...patch,
});

export const report = (patch: Partial<SleepReportView> = {}): SleepReportView => ({
	id: "r1",
	botId: "b1",
	kind: "daily",
	slot: "2026-11-06",
	status: "done",
	summary: "Guardei 1 fato e 1 nota. Tenho para você olhar: 1 habilidade. Dá para desfazer cada mudança.",
	proposals: [{ id: "skill:2026-11-06:planilha", kind: "skill", status: "open", name: "Conferir planilha de vendas", description: "Abrir a planilha, somar a coluna do mês e avisar se passar da meta.", instructions: "..." }],
	stats: {},
	createdAt: "2026-11-07T02:30:00.000Z",
	finishedAt: "2026-11-07T02:31:00.000Z",
	...patch,
});
