// Porta `Agenda` do v4 no worker (F4.2): lembrete, vigia e intenção por evento sobre `BotFollowup` (db). Toda chamada leva
// o `userId` do RUN e o db filtra por ele na consulta: item de outro dono responde igual a inexistente (40-seguranca).
//
// A permissão do run de agenda é decidida AQUI, na criação: guarda a autonomia e as regras do run que criou o item. O run
// acordado depois usa só isso (superfície `agenda`, sem dono para perguntar a cada execução).
import type { Agenda, AgendaItemView, AgendaRunResult } from "@workspace/agent";
import {
	changeAgendaItem,
	createAgendaItem,
	listAgendaItems,
	loadAgendaSettings,
	recordAgendaResult,
	type AgendaGrant,
	type AgendaItemRecord,
} from "@workspace/db";

export type V4AgendaDeps = {
	loadSettings: typeof loadAgendaSettings;
	create: typeof createAgendaItem;
	list: typeof listAgendaItems;
	change: typeof changeAgendaItem;
	record: typeof recordAgendaResult;
};

export const realV4AgendaDeps: V4AgendaDeps = { loadSettings: loadAgendaSettings, create: createAgendaItem, list: listAgendaItems, change: changeAgendaItem, record: recordAgendaResult };

/** A permissão a guardar: a política do run que cria (nunca algo vindo do modelo). */
export type V4AgendaPolicy = { autonomy: AgendaGrant["autonomy"]; rules: ReadonlyArray<{ match: string; effect?: AgendaGrant["rules"][number]["effect"]; verdict: "run" | "approve" | "deny" }> };

export function toAgendaView(item: AgendaItemRecord): AgendaItemView {
	return {
		id: item.id,
		kind: item.kind,
		status: item.status,
		note: item.note,
		nextRunAt: item.dueAt.toISOString(),
		everyMinutes: item.intervalMinutes,
		untilAt: item.untilAt?.toISOString() ?? null,
		runCount: item.runCount,
		maxRuns: item.maxRuns,
		eventFilter: item.eventFilter,
		endReason: item.endReason,
	};
}

export function createV4Agenda(input: { botId: string; policy: V4AgendaPolicy; deps?: V4AgendaDeps }): Agenda {
	const deps = input.deps ?? realV4AgendaDeps;
	const grant: AgendaGrant = { autonomy: input.policy.autonomy, rules: input.policy.rules.map((rule) => ({ match: rule.match, verdict: rule.verdict, ...(rule.effect && { effect: rule.effect }) })) };
	return {
		settings: (userId) => deps.loadSettings(userId, input.botId),
		async create(userId, plan, context) {
			const created = await deps.create({ userId, botId: input.botId, plan, grant, sourceRunId: context.sourceRunId, ...(context.untrustedRead === true && { untrustedRead: true }) });
			return created.ok ? { ok: true, item: toAgendaView(created.item), duplicate: created.duplicate } : { ok: false, error: created.error };
		},
		async list(userId, options) {
			return (await deps.list(userId, { includeEnded: options?.includeEnded === true })).map(toAgendaView);
		},
		async change(userId, id, action) {
			const item = await deps.change(userId, id, action);
			return item ? toAgendaView(item) : null;
		},
		async reportResult(userId, runId, result: AgendaRunResult, context) {
			const recorded = await deps.record({ userId, runId, outcome: result.outcome, ...(result.message !== undefined && { message: result.message }), ...(result.memo !== undefined && { memo: result.memo }), ...(result.pending !== undefined && { pending: result.pending }), ...(context?.untrustedRead === true && { untrustedRead: true }) });
			return recorded.ok ? { ok: true } : { ok: false, error: recorded.error };
		},
	};
}
