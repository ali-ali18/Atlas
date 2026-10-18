/**
 * Modo proativo contra Postgres de verdade: lembrete -> vencimento -> criação do run (runner
 * simulado), silêncio, teto diário, reflexão, cartão de rotina (aceitar/desfazer, clique duplo,
 * outro usuário). Só roda com `PROACTIVE_TEST_DATABASE_URL` (banco descartável, migrations
 * aplicadas); sem ela, o arquivo inteiro é ignorado.
 *
 * pnpm: PROACTIVE_TEST_DATABASE_URL=postgresql://... ATLAS_HOOK_PEPPER=x pnpm exec tsx --test src/proactive.integration.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { DEFAULT_PROACTIVE_SETTINGS, parseConversationCard, readProactiveSettings, withProactiveSettings, type ProactiveSettings } from "@workspace/shared";

const url = process.env.PROACTIVE_TEST_DATABASE_URL || process.env.ATLAS_TEST_DB_URL;
if (url) process.env.DATABASE_URL = url;
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const enabled = Boolean(url);
const { prisma } = enabled ? await import("./client.js") : { prisma: null as never };
const proactive = enabled ? await import("./proactive.js") : null;
const proposals = enabled ? await import("./routine-proposals.js") : null;

const SUFFIX = Math.random().toString(36).slice(2, 8);
const USER = `u-proactive-${SUFFIX}`;
const OTHER = `u-other-${SUFFIX}`;
const SP = "America/Sao_Paulo";
// Terça 2026-10-13 12:00 em São Paulo.
const NOON = new Date("2026-10-13T15:00:00.000Z");
const QUIET = new Date("2026-10-14T02:00:00.000Z"); // 23:00 em SP

let botId = "";
let conversationId = "";
let otherBotId = "";

function settings(patch: Partial<ProactiveSettings> = {}): ProactiveSettings {
	return { ...DEFAULT_PROACTIVE_SETTINGS, enabled: true, timezone: SP, ...patch };
}

async function resetBotData(): Promise<void> {
	await prisma.botFollowup.deleteMany({ where: { botId } });
	await prisma.proactiveEvent.deleteMany({ where: { botId } });
	await prisma.agentRun.deleteMany({ where: { botId } });
	await prisma.conversationMessage.deleteMany({ where: { conversationId } });
	await prisma.routine.deleteMany({ where: { botId } });
}

function deps(overrides: Partial<import("./proactive.js").ProactiveDeps> = {}) {
	const created: Array<{ origin?: string; conversationId?: string; objective?: string; silent?: boolean }> = [];
	const enqueued: string[] = [];
	const logs: string[] = [];
	const base: import("./proactive.js").ProactiveDeps = {
		enqueueRun: async (id) => {
			enqueued.push(id);
			return true;
		},
		envDefaultModel: "test/model",
		now: () => NOON,
		resolveModel: async () => "test/model",
		log: (line) => logs.push(line),
		createRun: async (input) => {
			created.push({
				origin: input.request.origin,
				conversationId: input.request.conversationId,
				objective: input.request.objective,
				silent: input.request.silent,
			});
			return { id: `run-${created.length}`, origin: "proactive", objective: input.request.objective?.trim() ?? "" } as never;
		},
		createDetachedRun: async (input) => {
			created.push({ origin: "proactive", objective: input.objective, silent: true });
			return { id: `detached-${created.length}` } as never;
		},
		activeRuns: async () => [],
		...overrides,
	};
	return { deps: base, created, enqueued, logs };
}

describe("modo proativo (Postgres)", { skip: !enabled }, () => {
	before(async () => {
		await prisma.user.createMany({
			data: [
				{ id: USER, name: "Proactive", email: `${USER}@test.local` },
				{ id: OTHER, name: "Other", email: `${OTHER}@test.local` },
			],
		});
		const conversation = await prisma.conversation.create({ data: { userId: USER } });
		conversationId = conversation.id;
		const bot = await prisma.bot.create({
			data: {
				ownerId: USER,
				name: "Principal",
				isPrimary: true,
				conversationId,
				policyJson: withProactiveSettings(null, { enabled: true, timezone: SP }) as never,
			},
		});
		botId = bot.id;
		const otherConversation = await prisma.conversation.create({ data: { userId: OTHER } });
		const otherBot = await prisma.bot.create({
			data: { ownerId: OTHER, name: "Outro", isPrimary: true, conversationId: otherConversation.id },
		});
		otherBotId = otherBot.id;
	});

	after(async () => {
		await resetBotData();
		await prisma.bot.deleteMany({ where: { ownerId: { in: [USER, OTHER] } } });
		await prisma.conversation.deleteMany({ where: { userId: { in: [USER, OTHER] } } });
		await prisma.agentRun.deleteMany({ where: { userId: { in: [USER, OTHER] } } });
		await prisma.user.deleteMany({ where: { id: { in: [USER, OTHER] } } });
		await prisma.$disconnect();
	});

	test("configuração persiste no bot (policyJson) sem perder o resto da política", async () => {
		const { updateBot, listBots } = await import("./bots.js");
		const before = await prisma.bot.findUniqueOrThrow({ where: { id: botId } });
		await prisma.bot.update({ where: { id: botId }, data: { policyJson: { subagentModel: "x/y" } } });
		const policy = withProactiveSettings({ subagentModel: "x/y" }, { enabled: true, routineMode: "auto", maxPerDay: 5, quietStart: "23:00", quietEnd: "07:30", timezone: "America/New_York" });
		await updateBot(botId, { policyJson: policy }, USER);
		const listed = (await listBots(USER)).find((bot) => bot.id === botId);
		assert.deepEqual(readProactiveSettings(listed?.policyJson), {
			enabled: true,
			routineMode: "auto",
			maxPerDay: 5,
			quietStart: "23:00",
			quietEnd: "07:30",
			timezone: "America/New_York",
		});
		assert.equal((listed?.policyJson as { subagentModel?: string }).subagentModel, "x/y");
		await prisma.bot.update({ where: { id: botId }, data: { policyJson: before.policyJson as never } });
	});

	test("agenda, deduplica e isola por dono", async () => {
		await resetBotData();
		const dueAt = new Date("2026-10-14T12:00:00Z");
		const first = await proactive!.createFollowup({ userId: USER, botId, note: "Pagar o boleto da internet", kind: "reminder", dueAt, requestedFor: dueAt, source: "chat" });
		assert.equal(first.duplicate, false);
		const again = await proactive!.createFollowup({ userId: USER, botId, note: "pagar o boleto da internet", kind: "reminder", dueAt: new Date("2026-10-14T13:00:00Z"), requestedFor: dueAt, source: "chat" });
		assert.equal(again.duplicate, true);
		assert.equal(again.followup.id, first.followup.id);
		assert.equal((await proactive!.listFollowups(USER, botId)).length, 1);
		// outro usuário não vê, não cancela e não agenda no bot alheio
		assert.equal((await proactive!.listFollowups(OTHER, botId)).length, 0);
		assert.equal(await proactive!.cancelFollowup(OTHER, first.followup.id), false);
		await assert.rejects(() => proactive!.createFollowup({ userId: OTHER, botId, note: "x", kind: "reminder", dueAt, requestedFor: dueAt, source: "chat" }), /Bot não encontrado/);
		assert.equal(await proactive!.cancelFollowup(USER, first.followup.id), true);
		assert.equal(await proactive!.cancelFollowup(USER, first.followup.id), false);
	});

	test("bot que não é o principal não agenda", async () => {
		const secondary = await prisma.bot.create({ data: { ownerId: USER, name: "Secundário", isPrimary: false } });
		const dueAt = new Date("2026-10-14T12:00:00Z");
		await assert.rejects(
			() => proactive!.createFollowup({ userId: USER, botId: secondary.id, note: "x", kind: "reminder", dueAt, requestedFor: dueAt, source: "chat" }),
			/bot principal/,
		);
		await prisma.bot.delete({ where: { id: secondary.id } });
	});

	test("vencido vira run proativo silencioso na conversa do bot, uma única vez", async () => {
		await resetBotData();
		const dueAt = new Date("2026-10-13T14:00:00Z"); // 11:00 SP, já venceu
		const { followup } = await proactive!.createFollowup({ userId: USER, botId, note: "Entregar o relatório ao João", kind: "reminder", dueAt, requestedFor: dueAt, source: "chat" });
		const ctx = deps();
		const result = await proactive!.processProactive(ctx.deps);
		assert.equal(result.followupsRun, 1);
		assert.equal(ctx.created.length >= 1, true);
		const run = ctx.created.find((item) => item.conversationId === conversationId);
		assert.ok(run, "run criado na conversa do bot");
		assert.equal(run.origin, "proactive");
		assert.equal(run.silent, true);
		assert.match(run.objective ?? "", /\[SCHEDULED FOLLOW-UP\]/);
		assert.match(run.objective ?? "", /Entregar o relatório ao João/);
		assert.ok(ctx.enqueued.includes("run-1")); // a reflexão do dia também sai na mesma passada
		const row = await prisma.botFollowup.findUniqueOrThrow({ where: { id: followup.id } });
		assert.equal(row.status, "done");
		assert.equal(row.runId, "run-1");
		// segunda varredura: nada a fazer
		const second = deps();
		await proactive!.processProactive(second.deps);
		assert.equal(second.created.filter((item) => item.conversationId === conversationId).length, 0);
		// sem texto do usuário nos logs
		assert.ok(ctx.logs.every((line) => !line.includes("relatório")));
	});

	test("vários avisos num lembrete só: dispara em ordem e só conclui no último", async () => {
		await resetBotData();
		const at = (iso: string) => new Date(iso);
		const stages = [at("2026-10-12T12:00:00Z"), at("2026-10-30T12:00:00Z"), at("2026-11-11T12:00:00Z")];
		const { followup, duplicate } = await proactive!.createFollowup({ userId: USER, botId, note: "Entrega do relatório trimestral", kind: "reminder", dueAt: stages[0]!, requestedFor: stages[0]!, stages, source: "chat" });
		assert.equal(duplicate, false);
		assert.equal(followup.stages.length, 3);
		assert.equal((await proactive!.listFollowups(USER, botId)).length, 1, "um card só");
		// 1º aviso venceu: dispara, avança dueAt para o 2º e segue pendente
		const first = await proactive!.processProactive(deps().deps);
		assert.equal(first.followupsRun, 1);
		let row = await prisma.botFollowup.findUniqueOrThrow({ where: { id: followup.id } });
		assert.equal(row.status, "pending");
		assert.equal(row.dueAt.toISOString(), "2026-10-30T12:00:00.000Z");
		assert.equal((row.stages as Array<{ firedAt?: string | null }>)[0]!.firedAt != null, true);
		// varredura seguinte: nada vence
		const idle = await proactive!.processProactive(deps().deps);
		assert.equal(idle.followupsRun, 0);
		// 2º e 3º avisos
		for (const [now, expected] of [["2026-10-30T13:00:00Z", "pending"], ["2026-11-11T13:00:00Z", "done"]] as const) {
			const ctx = deps({ now: () => at(now) });
			assert.equal((await proactive!.processProactive(ctx.deps)).followupsRun, 1);
			row = await prisma.botFollowup.findUniqueOrThrow({ where: { id: followup.id } });
			assert.equal(row.status, expected);
		}
		assert.equal((row.stages as Array<{ firedAt?: string | null }>).every((st) => st.firedAt != null), true);
	});

	test("lembrete antigo (sem stages) segue como aviso único e conclui ao disparar", async () => {
		await resetBotData();
		const row = await prisma.botFollowup.create({
			data: { userId: USER, botId, conversationId, dueAt: new Date("2026-10-12T12:00:00Z"), requestedFor: new Date("2026-10-12T12:00:00Z"), note: "Antigo sem etapas" },
		});
		const listed = await proactive!.listFollowups(USER, botId);
		assert.equal(listed[0]!.stages.length, 1);
		assert.equal((await proactive!.processProactive(deps().deps)).followupsRun, 1);
		assert.equal((await prisma.botFollowup.findUniqueOrThrow({ where: { id: row.id } })).status, "done");
	});

	test("reagendar: próximo aviso por padrão, `stage` escolhe outro; passado, enviado e outro dono são recusados", async () => {
		await resetBotData();
		const stages = [new Date("2026-10-15T12:00:00Z"), new Date("2026-10-30T12:00:00Z"), new Date("2026-11-11T12:00:00Z")];
		const { followup } = await proactive!.createFollowup({ userId: USER, botId, note: "Prazo do contrato", kind: "reminder", dueAt: stages[0]!, requestedFor: stages[0]!, stages, source: "chat" });
		const now = NOON;
		const base = { userId: USER, botId, followupId: followup.id, now };
		const moved = await proactive!.rescheduleOwnedFollowup({ ...base, when: "2026-10-20T09:00" });
		assert.ok(moved.ok);
		assert.equal(moved.ok && moved.followup.dueAt.toISOString(), "2026-10-20T12:00:00.000Z");
		const third = await proactive!.rescheduleOwnedFollowup({ ...base, when: "2026-11-05T23:00", stage: 3 });
		assert.ok(third.ok && third.movedForQuietHours);
		assert.equal(third.ok && third.followup.stages[2]!.at, "2026-11-06T11:00:00.000Z");
		assert.equal((await proactive!.rescheduleOwnedFollowup({ ...base, when: "2026-10-01T09:00" })).ok, false);
		assert.equal((await proactive!.rescheduleOwnedFollowup({ userId: OTHER, botId, followupId: followup.id, when: "2026-10-20T09:00", now })).ok, false);
		// após o 1º sair, o aviso 1 não pode mais ser movido
		await prisma.botFollowup.update({ where: { id: followup.id }, data: { stages: [{ at: "2026-10-13T12:00:00.000Z", firedAt: "2026-10-13T12:01:00.000Z" }, { at: "2026-10-30T12:00:00.000Z" }] } });
		const fired = await proactive!.rescheduleOwnedFollowup({ ...base, when: "2026-10-25T09:00", stage: 1 });
		assert.equal(fired.ok, false);
		assert.equal(!fired.ok && fired.status, 400);
	});

	test("duas varreduras ao mesmo tempo não disparam duas vezes", async () => {
		await resetBotData();
		const dueAt = new Date("2026-10-13T14:00:00Z");
		await proactive!.createFollowup({ userId: USER, botId, note: "Lembrete concorrente", kind: "reminder", dueAt, requestedFor: dueAt, source: "chat" });
		const a = deps();
		const b = deps();
		await Promise.all([proactive!.processProactive(a.deps), proactive!.processProactive(b.deps)]);
		const total = [...a.created, ...b.created].filter((item) => item.conversationId === conversationId).length;
		assert.equal(total, 1);
	});

	test("horário de silêncio adia para o fim da janela, sem criar run", async () => {
		await resetBotData();
		const dueAt = new Date("2026-10-14T01:00:00Z"); // 22:00 SP
		const { followup } = await proactive!.createFollowup({ userId: USER, botId, note: "Ligar para a mãe", kind: "reminder", dueAt, requestedFor: dueAt, source: "chat" });
		const ctx = deps({ now: () => QUIET });
		const result = await proactive!.processProactive(ctx.deps);
		assert.equal(result.followupsDeferred, 1);
		assert.equal(ctx.created.filter((item) => item.conversationId === conversationId).length, 0);
		const row = await prisma.botFollowup.findUniqueOrThrow({ where: { id: followup.id } });
		assert.equal(row.status, "pending");
		assert.equal(row.dueAt.toISOString(), "2026-10-14T11:00:00.000Z"); // 08:00 SP
		assert.equal(row.claimedUntil, null);
	});

	test("conversa ocupada: tenta de novo em 2 min", async () => {
		await resetBotData();
		const dueAt = new Date("2026-10-13T14:00:00Z");
		const { followup } = await proactive!.createFollowup({ userId: USER, botId, note: "Revisar contrato", kind: "check", dueAt, requestedFor: dueAt, source: "chat" });
		const ctx = deps({ activeRuns: async () => [{ id: "busy" } as never] });
		await proactive!.processProactive(ctx.deps);
		assert.equal(ctx.created.filter((item) => item.conversationId === conversationId).length, 0);
		const row = await prisma.botFollowup.findUniqueOrThrow({ where: { id: followup.id } });
		assert.equal(row.status, "pending");
		assert.equal(row.dueAt.toISOString(), new Date(NOON.getTime() + 2 * 60_000).toISOString());
	});

	test("teto diário vale só para lembretes que o bot decidiu sozinho", async () => {
		await resetBotData();
		for (let i = 0; i < 3; i += 1) await proactive!.recordProactiveEvent({ userId: USER, botId, kind: "message" });
		await prisma.proactiveEvent.updateMany({ where: { botId }, data: { createdAt: NOON } });
		const dueAt = new Date("2026-10-13T14:00:00Z");
		const user = await proactive!.createFollowup({ userId: USER, botId, note: "Pedido do usuário", kind: "reminder", dueAt, requestedFor: dueAt, source: "chat" });
		const bot = await proactive!.createFollowup({ userId: USER, botId, note: "Ideia do bot sobre o prazo", kind: "reminder", dueAt, requestedFor: dueAt, source: "reflection" });
		const ctx = deps();
		await proactive!.processProactive(ctx.deps);
		assert.equal((await prisma.botFollowup.findUniqueOrThrow({ where: { id: user.followup.id } })).status, "done");
		const botRow = await prisma.botFollowup.findUniqueOrThrow({ where: { id: bot.followup.id } });
		assert.equal(botRow.status, "pending");
		assert.equal(botRow.dueAt.toISOString(), "2026-10-14T03:00:00.000Z"); // meia-noite de SP
	});

	test("reserveProactiveMessage: 8 envios simultâneos respeitam o teto de 3", async () => {
		await resetBotData();
		const s = settings({ maxPerDay: 3 });
		const gates = await Promise.all(Array.from({ length: 8 }, () => proactive!.reserveProactiveMessage({ userId: USER, botId, settings: s, now: NOON })));
		assert.equal(gates.filter((gate) => gate.allowed).length, 3);
		assert.equal(gates.filter((gate) => !gate.allowed && gate.reason === "daily_cap").length, 5);
		const quiet = await proactive!.reserveProactiveMessage({ userId: USER, botId, settings: settings({ maxPerDay: 9 }), now: QUIET });
		assert.deepEqual({ allowed: quiet.allowed, reason: quiet.allowed ? null : quiet.reason }, { allowed: false, reason: "quiet_hours" });
		assert.equal(await proactive!.countProactiveEvents(botId, "message", { start: new Date("2026-10-13T03:00:00Z"), end: new Date("2026-10-14T03:00:00Z") }), 3);
	});

	test("reflexão: uma por dia, com contexto, só com o modo ligado", async () => {
		await resetBotData();
		await prisma.routine.create({ data: { userId: USER, botId, name: "Resumo da manhã", prompt: "Resuma os e-mails", schedule: "0 8 * * 1-5", createdBy: "bot" } });
		const dueAt = new Date("2026-10-20T12:00:00Z");
		await proactive!.createFollowup({ userId: USER, botId, note: "Prova de cálculo", kind: "reminder", dueAt, requestedFor: dueAt, source: "chat" });
		await prisma.conversationMessage.create({ data: { conversationId, role: "user", content: "Toda segunda eu peço o resumo da semana" } });
		const first = deps();
		const r1 = await proactive!.processProactive(first.deps);
		assert.equal(r1.reflections, 1);
		const detached = first.created.find((item) => item.conversationId === undefined);
		assert.ok(detached, "run sem conversa");
		assert.match(detached.objective ?? "", /\[PROACTIVE REFLECTION\]/);
		assert.match(detached.objective ?? "", /Resumo da manhã/);
		assert.match(detached.objective ?? "", /created by you/);
		assert.match(detached.objective ?? "", /Prova de cálculo/);
		assert.match(detached.objective ?? "", /Toda segunda eu peço o resumo da semana/);
		const second = deps();
		const r2 = await proactive!.processProactive(second.deps);
		assert.equal(r2.reflections, 0);
		// dia seguinte, depois do slot: roda de novo
		const tomorrow = deps({ now: () => new Date("2026-10-14T15:00:00Z") });
		assert.equal((await proactive!.processProactive(tomorrow.deps)).reflections, 1);
		// desligado: nada
		await prisma.bot.update({ where: { id: botId }, data: { policyJson: withProactiveSettings(null, { enabled: false, timezone: SP }) as never } });
		await prisma.proactiveEvent.deleteMany({ where: { botId } });
		const off = deps();
		assert.equal((await proactive!.processProactive(off.deps)).reflections, 0);
		await prisma.bot.update({ where: { id: botId }, data: { policyJson: withProactiveSettings(null, { enabled: true, timezone: SP }) as never } });
	});

	test("reflexão não roda no silêncio nem para bot que não é o principal", async () => {
		await resetBotData();
		const quiet = deps({ now: () => QUIET });
		assert.equal((await proactive!.processProactive(quiet.deps)).reflections, 0);
		await prisma.bot.update({ where: { id: botId }, data: { isPrimary: false } });
		const notPrimary = deps();
		assert.equal((await proactive!.processProactive(notPrimary.deps)).reflections, 0);
		await prisma.bot.update({ where: { id: botId }, data: { isPrimary: true } });
	});

	test("createDetachedProactiveRun grava run sem conversa e só do dono", async () => {
		await resetBotData();
		const run = await proactive!.createDetachedProactiveRun({ userId: USER, botId, model: "test/model", objective: "x", messages: [{ role: "user", content: "x" }] });
		assert.equal(run.origin, "proactive");
		assert.equal(run.conversationId, null);
		assert.equal(run.status, "queued");
		await assert.rejects(() => proactive!.createDetachedProactiveRun({ userId: OTHER, botId, model: "m", objective: "x", messages: [] }), /Bot não encontrado/);
	});

	describe("cartão de rotina proposta", () => {
		const spec = { name: "Resumo da semana", prompt: "Resuma a semana do usuário", schedule: "0 8 * * 1", timezone: SP };

		async function seedCard(mode: "suggest" | "auto", routineId?: string) {
			return proposals!.appendRoutineProposalCard(conversationId, {
				v: 1,
				kind: "routine-proposal",
				proposalId: `p-${Math.random().toString(36).slice(2, 7)}`,
				mode,
				status: "pending",
				spec,
				...(routineId ? { routineId } : {}),
			});
		}
		async function cardOf(messageId: string) {
			const row = await prisma.conversationMessage.findUniqueOrThrow({ where: { id: messageId } });
			const card = parseConversationCard(row.content);
			assert.equal(card?.kind, "routine-proposal");
			return card as Extract<NonNullable<typeof card>, { kind: "routine-proposal" }>;
		}

		test("Sugerir + Criar cria a rotina marcada como do bot; clique duplo não duplica", async () => {
			await resetBotData();
			const messageId = await seedCard("suggest");
			const [a, b] = await Promise.all([
				proposals!.resolveRoutineProposal({ userId: USER, messageId, decision: "accept" }),
				proposals!.resolveRoutineProposal({ userId: USER, messageId, decision: "accept" }),
			]);
			assert.equal(a.ok && b.ok, true);
			const routines = await prisma.routine.findMany({ where: { botId } });
			assert.equal(routines.length, 1);
			assert.equal(routines[0]!.createdBy, "bot");
			assert.equal(routines[0]!.schedule, "0 8 * * 1");
			assert.equal(routines[0]!.timezone, SP);
			const card = await cardOf(messageId);
			assert.equal(card.status, "accepted");
			assert.equal(card.routineId, routines[0]!.id);
			assert.equal([a, b].filter((r) => r.ok && r.created).length, 1);
		});

		test("Sugerir + Agora não não cria nada e fica recusado", async () => {
			await resetBotData();
			const messageId = await seedCard("suggest");
			const result = await proposals!.resolveRoutineProposal({ userId: USER, messageId, decision: "decline" });
			assert.equal(result.ok, true);
			assert.equal(await prisma.routine.count({ where: { botId } }), 0);
			assert.equal((await cardOf(messageId)).status, "declined");
			// depois de resolvido, aceitar não faz nada
			const late = await proposals!.resolveRoutineProposal({ userId: USER, messageId, decision: "accept" });
			assert.equal(late.ok && late.unchanged, true);
			assert.equal(await prisma.routine.count({ where: { botId } }), 0);
			const found = await proposals!.findRecentProposalByName(conversationId, "resumo da semana");
			assert.equal(found?.status, "declined");
		});

		test("Automático: Manter mantém, Desfazer apaga a rotina", async () => {
			await resetBotData();
			const created = await proposals!.createRoutineFromProposal(USER, botId, spec);
			assert.ok("routine" in created);
			const routineId = (created as { routine: { id: string } }).routine.id;
			const keepId = await seedCard("auto", routineId);
			const kept = await proposals!.resolveRoutineProposal({ userId: USER, messageId: keepId, decision: "accept" });
			assert.equal(kept.ok && kept.card.status, "accepted");
			assert.equal(await prisma.routine.count({ where: { id: routineId } }), 1);

			const undoId = await seedCard("auto", routineId);
			const undone = await proposals!.resolveRoutineProposal({ userId: USER, messageId: undoId, decision: "decline" });
			assert.equal(undone.ok && undone.deletedRoutineId, routineId);
			assert.equal(await prisma.routine.count({ where: { id: routineId } }), 0);
			assert.equal((await cardOf(undoId)).status, "declined");
		});

		test("rotina parecida que já existe não é duplicada ao aceitar", async () => {
			await resetBotData();
			await prisma.routine.create({ data: { userId: USER, botId, name: "Resumo da semana", prompt: "x", schedule: "0 9 * * 1" } });
			const messageId = await seedCard("suggest");
			const result = await proposals!.resolveRoutineProposal({ userId: USER, messageId, decision: "accept" });
			assert.equal(result.ok && !result.created, true);
			assert.equal(await prisma.routine.count({ where: { botId } }), 1);
		});

		test("outro usuário não resolve o cartão (404) nem toca na rotina", async () => {
			await resetBotData();
			const messageId = await seedCard("suggest");
			const result = await proposals!.resolveRoutineProposal({ userId: OTHER, messageId, decision: "accept" });
			assert.deepEqual(result.ok, false);
			assert.equal(!result.ok && result.status, 404);
			assert.equal((await cardOf(messageId)).status, "pending");
			assert.equal(await prisma.routine.count({ where: { botId: otherBotId } }), 0);
			const none = await proposals!.resolveRoutineProposal({ userId: USER, messageId: "nao-existe", decision: "accept" });
			assert.equal(none.ok, false);
		});
	});
});
