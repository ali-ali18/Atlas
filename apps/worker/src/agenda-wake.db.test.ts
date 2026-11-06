/**
 * Agenda do worker contra Postgres real (auditoria F4: T2 concorrência, T3 run que morreu, B1/B5 ponta a ponta no banco).
 * Pulado sem `ATLAS_TEST_DB_URL` (banco com `test` no nome) e `DATABASE_URL` igual a ele.
 * Runner: `ATLAS_TEST_DB_URL=postgresql://.../atlas_test DATABASE_URL=$ATLAS_TEST_DB_URL NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/agenda-wake.db.test.ts`.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import {
	AGENDA_RUN_RETRY_MS,
	beginAgendaRun,
	claimDueAgendaItems,
	createAgendaItem,
	finalizeAgendaRun,
	getAgendaItem,
	prisma,
	recordAgendaResult,
	reserveAgendaItem,
	type AgendaGrant,
	type AgendaItemRecord,
} from "@workspace/db";
import { DEFAULT_PROACTIVE_SETTINGS, planAgendaItem, readEngineV4Gate, type AgendaEvent, type AgendaPlan } from "@workspace/shared";
import { realAgendaRunDb, settleAbortedAgendaRun } from "./agenda-run.js";
import { dispatchAgendaItem, processAgenda, wakeAgendaForEvent, type AgendaWakeDeps } from "./agenda-wake.js";

const url = process.env.ATLAS_TEST_DB_URL?.trim() ?? "";
const dbSkip: string | false = !url ? "banco de teste ausente (ATLAS_TEST_DB_URL)" : !/test/i.test(new URL(url).pathname) ? "recusado: o banco deve ter 'test' no nome" : process.env.DATABASE_URL !== url ? "DATABASE_URL difere de ATLAS_TEST_DB_URL" : false;

const GRANT: AgendaGrant = { autonomy: "balanced", rules: [] };
// Quarta 2026-11-04 10:00 em São Paulo.
const T0 = new Date("2026-11-04T13:00:00.000Z");
const at = (minutes: number, base = T0) => new Date(base.getTime() + minutes * 60_000);
const SETTINGS = { ...DEFAULT_PROACTIVE_SETTINGS, enabled: true, timezone: "America/Sao_Paulo" };
const EVENT: AgendaEvent = { source: "email", from: "fatura@banco.com", subject: "Sua fatura", hasAttachment: true };

function plan(request: Parameters<typeof planAgendaItem>[0]["request"]): AgendaPlan {
	const out = planAgendaItem({ request, now: T0, settings: SETTINGS });
	if (!out.ok) throw new Error(out.error);
	return out.plan;
}

describe("agenda do worker (Postgres real)", { skip: dbSkip }, () => {
	let userId: string;
	let otherId: string;
	let botId: string;
	let convId: string;

	before(async () => {
		userId = `wk-${randomUUID()}`;
		otherId = `wk-${randomUUID()}`;
		for (const id of [userId, otherId]) await prisma.user.create({ data: { id, name: id, email: `${id}@test.local` } });
		convId = (await prisma.conversation.create({ data: { userId } })).id;
		botId = (await prisma.bot.create({ data: { ownerId: userId, name: "A", isPrimary: true, conversationId: convId }, select: { id: true } })).id;
	});
	after(async () => {
		await prisma.$disconnect();
	});

	/** Um "worker": db real, só a criação do run e a fila são falsas (contam por dono do teste). */
	function worker(now: Date, sink: { created: string[]; delivered: string[] }, over: Partial<AgendaWakeDeps> = {}): AgendaWakeDeps {
		return {
			v4Gate: readEngineV4Gate("true", `${userId},${otherId}`),
			enqueueRun: async () => true,
			envDefaultModel: "test/model",
			now: () => now,
			log: () => undefined,
			resolveModel: async () => "test/model",
			activeRuns: async () => [],
			createRun: (async (input: { userId: string; request: { objective?: string; origin?: string } }) => {
				const id = `run-${randomUUID()}`;
				if (input.userId === userId) sink.created.push(id);
				return { id, origin: input.request.origin, objective: input.request.objective };
			}) as unknown as AgendaWakeDeps["createRun"],
			settleDead: (input) => settleAbortedAgendaRun({ ...input, db: { ...realAgendaRunDb, deliver: async (_c, text) => void sink.delivered.push(text) } }),
			...over,
		};
	}
	const sink = () => ({ created: [] as string[], delivered: [] as string[] });

	async function newItem(request: Parameters<typeof plan>[0]): Promise<AgendaItemRecord> {
		const created = await createAgendaItem({ userId, botId, plan: plan(request), grant: GRANT });
		assert.ok(created.ok, created.ok ? "" : created.error);
		return created.item;
	}

	test("T3 + B1: o run morreu sem resultado, volta na fila em 30 min e o wake o fecha ANTES do maxRuns: lembrete único não some em silêncio", async () => {
		const item = await newItem({ kind: "remind", note: `Ligar para a Ana ${randomUUID()}`, when: "2026-11-04T10:00" });
		const startedAt = at(180);
		await beginAgendaRun(item, "run-morto-1", startedAt);
		// antes de AGENDA_RUN_RETRY_MS a varredura não pega o item
		assert.equal((await claimDueAgendaItems(at(180 + 29))).some((i) => i.id === item.id), false);
		const claimed = (await claimDueAgendaItems(new Date(startedAt.getTime() + AGENDA_RUN_RETRY_MS))).find((i) => i.id === item.id);
		assert.ok(claimed, "volta à fila no prazo");
		assert.equal(claimed.runCount, 1);
		// lembrete único nasce com teto de 1 execução: é exatamente o que o `max_runs` do wake consumiria
		assert.equal(claimed.maxRuns, 1, "lembrete de uma vez só");
		const s = sink();
		const result = { run: 0, deferred: 0, stopped: 0, coalesced: 0 };
		await dispatchAgendaItem(claimed, worker(new Date(startedAt.getTime() + AGENDA_RUN_RETRY_MS), s), result);
		assert.equal(s.created.length, 0, "não cria outro run");
		assert.equal(result.stopped, 0, "o maxRuns não consome o item antes do fechamento");
		assert.equal(result.deferred, 1);
		const after = await getAgendaItem(userId, item.id);
		assert.equal(after?.lastResult?.runId, "run-morto-1");
		assert.equal(after?.lastResult?.outcome, "missing");
		// nunca em silêncio: ou continua na fila, ou o texto do lembrete foi entregue
		assert.ok(after?.status === "pending" || s.delivered.some((text) => text.includes("Ligar para a Ana")), `status=${after?.status} entregue=${JSON.stringify(s.delivered)}`);
	});

	test("B1: falha, cancelamento ou queda fecham o item pelo mesmo caminho (idempotente)", async () => {
		const item = await newItem({ kind: "remind", note: `Reunião ${randomUUID()}`, when: "2026-11-04T10:00" });
		await beginAgendaRun(item, "run-falhou-1", at(180));
		const s = sink();
		const deps = { userId, runId: "run-falhou-1", language: "pt-BR", db: { ...realAgendaRunDb, deliver: async (_c: string, text: string) => void s.delivered.push(text) } };
		assert.equal((await settleAbortedAgendaRun({ ...deps, now: at(181) })).closed, true);
		const first = await getAgendaItem(userId, item.id);
		assert.equal(first?.lastResult?.outcome, "missing");
		// reentrega do mesmo fechamento: não duplica o aviso
		const delivered = s.delivered.length;
		await settleAbortedAgendaRun({ ...deps, now: at(182) });
		assert.equal(s.delivered.length, delivered);
		assert.ok(first?.status === "pending" || delivered >= 1);
		// item de outro dono: o fechamento não encontra
		assert.deepEqual(await settleAbortedAgendaRun({ userId: otherId, runId: "run-falhou-1", db: { ...realAgendaRunDb, deliver: async () => undefined } }), { closed: false, delivered: false });
	});
});
