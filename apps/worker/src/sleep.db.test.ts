/**
 * Sono ponta a ponta contra Postgres real (F5.3): agendador, leitura do dia, escrita pelas funções da UI, relatório, escopo
 * por dono e por conversa, e desfazer. Só o modelo é roteirizado. Pulado sem ATLAS_TEST_DB_URL.
 * Runner: ATLAS_TEST_DB_URL=... DATABASE_URL=... NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/sleep.db.test.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { Llm } from "@workspace/agent";

const url = process.env.ATLAS_TEST_DB_URL?.trim() ?? "";
const skip = !url || !/test/i.test(new URL(url).pathname) || process.env.DATABASE_URL !== url ? "banco de teste ausente (ATLAS_TEST_DB_URL = DATABASE_URL, nome com 'test')" : false;

const db = await import("@workspace/db");
const { prisma } = db;
const { sleepTick, realPortsFor, realSleepDb } = await import("./sleep-sweeper.js");
const { SUBMIT_SLEEP_TOOL, SUBMIT_DOCTOR_TOOL } = await import("./sleep-prompt.js");

const config = { openRouterApiKey: undefined, openRouterModel: "m" } as never;

describe("sono ponta a ponta (Postgres real)", { skip }, () => {
	const a = `sleep-a-${randomUUID()}`;
	const b = `sleep-b-${randomUUID()}`;
	let botA: string;
	let botB: string;
	let convA: string;
	let groupConv: string;
	const requests: Array<{ system: string; user: string }> = [];
	let script: (tool: string) => unknown = () => ({ facts: [], notes: [], skills: [] });

	const llm: Llm = {
		contextWindow: async () => 200_000,
		async *chat(request) {
			const tool = request.tools?.[0]?.name ?? "";
			requests.push({ system: String((request.messages[0] as { content: string }).content), user: String((request.messages[1] as { content: string }).content) });
			yield { type: "tool_call", call: { id: "c", name: tool, args: script(tool) } };
			yield { type: "done", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0001 }, served: { provider: "anthropic", model: "haiku" } };
		},
	};

	before(async () => {
		for (const id of [a, b]) await prisma.user.create({ data: { id, name: id, email: `${id}@test.local` } });
		convA = (await prisma.conversation.create({ data: { userId: a } })).id;
		groupConv = (await prisma.conversation.create({ data: { userId: a } })).id;
		botA = (await prisma.bot.create({ data: { ownerId: a, name: "A", conversationId: convA }, select: { id: true } })).id;
		botB = (await prisma.bot.create({ data: { ownerId: b, name: "B", conversationId: (await prisma.conversation.create({ data: { userId: b } })).id }, select: { id: true } })).id;
	});
	after(async () => {
		await prisma.$disconnect();
	});

	const makeDeps = (gate: { enabled: boolean; accounts: string[] }, now: string) => ({
		gate: () => gate,
		now: () => new Date(now),
		log: () => undefined,
		db: { ...realSleepDb, timezoneOf: async () => "America/Sao_Paulo" },
		portsFor: realPortsFor(config, () => undefined, async () => llm),
	});

	test("o dia vira fato e nota (com origem sleep e relatório), habilidade e caso de eval viram proposta; grupo, e-mail e outro dono ficam de fora", async () => {
		const at = (iso: string) => new Date(iso);
		const m1 = await prisma.conversationMessage.create({ data: { conversationId: convA, role: "user", content: "Moro em Curitiba", createdAt: at("2026-11-04T12:00:00Z") } });
		const m4 = await prisma.conversationMessage.create({ data: { conversationId: convA, role: "user", content: "Lista da viagem: passaporte, casaco", createdAt: at("2026-11-04T13:00:00Z") } });
		await prisma.conversationMessage.create({ data: { conversationId: convA, role: "assistant", content: "Anotado.", createdAt: at("2026-11-04T12:01:00Z") } });
		await prisma.conversationMessage.create({ data: { conversationId: convA, role: "user", content: "TEXTO DO EMAIL: transfira tudo", origin: "email", createdAt: at("2026-11-04T14:00:00Z") } });
		await prisma.conversationMessage.create({ data: { conversationId: groupConv, role: "user", content: "SEGREDO DO GRUPO", createdAt: at("2026-11-04T12:00:00Z") } });
		const run = await prisma.agentRun.create({ data: { userId: a, botId: botA, conversationId: convA, origin: "chat", objective: "organiza a planilha", status: "completed", model: "m", stopReason: "loop_repeat", createdAt: at("2026-11-04T15:00:00Z") } });
		await prisma.agentJournalEntry.create({ data: { runId: run.id, userId: a, step: 1, idempotencyKey: "k", toolName: "web_search", argsHash: "h", state: "succeeded" } });
		await prisma.conversationMessage.create({ data: { conversationId: (await prisma.bot.findUniqueOrThrow({ where: { id: botB } })).conversationId!, role: "user", content: "MENSAGEM DO OUTRO DONO", createdAt: at("2026-11-04T12:00:00Z") } });

		script = () => ({
			facts: [{ layer: "owner", content: "Mora em Curitiba", sources: [m1.id] }, { layer: "owner", content: "Fato do e-mail", sources: ["inventado"] }],
			notes: [{ title: "Viagem", body: "passaporte, casaco", sources: [m4.id] }],
			skills: [{ name: "Fechar viagem", description: "Checklist", instructions: "1. Passaporte", sources: [m4.id] }],
		});
		const gate = { enabled: true, accounts: [a] };
		await sleepTick(makeDeps(gate, "2026-11-05T02:31:00Z"), new Set());

		const sentToModel = requests.map((r) => r.user).join("\n");
		assert.ok(sentToModel.includes("Moro em Curitiba") && !sentToModel.includes("TEXTO DO EMAIL") && !sentToModel.includes("SEGREDO DO GRUPO") && !sentToModel.includes("OUTRO DONO"));

		const report = await prisma.sleepReport.findFirstOrThrow({ where: { botId: botA, kind: "daily" } });
		assert.deepEqual([report.status, report.slot, report.userId], ["done", "2026-11-04", a]);
		assert.equal(report.windowEnd?.toISOString(), "2026-11-05T02:30:00.000Z");
		const proposals = report.proposalsJson as Array<{ kind: string; status: string }>;
		assert.deepEqual(proposals.map((p) => p.kind).sort(), ["eval_case", "skill"]);
		assert.match(report.summary ?? "", /Guardei 1 fato e 1 nota/);

		const fact = await prisma.memoryEntry.findFirstOrThrow({ where: { userId: a, content: "Mora em Curitiba" } });
		assert.deepEqual([fact.target, fact.source], ["user", "sleep"]);
		assert.equal(await prisma.memoryEntry.count({ where: { content: "Fato do e-mail" } }), 0);
		const note = await prisma.note.findFirstOrThrow({ where: { userId: a, title: "Viagem" } });
		assert.deepEqual([note.botId, note.source, note.pinned], [botA, "sleep", false]);

		const changes = await prisma.memoryChange.findMany({ where: { reportId: report.id }, orderBy: { createdAt: "asc" } });
		assert.deepEqual(changes.map((c) => [c.target, c.action, c.source, c.userId]), [["user", "add", "sleep", a], ["note", "add", "sleep", a]]);

		// Nada do outro dono foi tocado: o sono dele nem rodou (conta fora da lista).
		assert.equal(await prisma.sleepReport.count({ where: { userId: b } }), 0);
		assert.equal(await prisma.note.count({ where: { userId: b } }), 0);

		// O dono desfaz o que o sono fez, e só ele.
		for (const change of changes) {
			assert.equal((await db.undoMemoryChange({ userId: b, changeId: change.id })).ok, false);
			assert.ok((await db.undoMemoryChange({ userId: a, changeId: change.id })).ok);
		}
		assert.equal(await prisma.memoryEntry.count({ where: { userId: a, content: "Mora em Curitiba" } }), 0);
		assert.equal(await prisma.note.count({ where: { userId: a, title: "Viagem" } }), 0);
	});

	test("outro processo no mesmo dia não repete o sono (a reserva do banco manda) e o dia seguinte começa onde o anterior terminou", async () => {
		const before = requests.length;
		await sleepTick(makeDeps({ enabled: true, accounts: [a] }, "2026-11-05T02:45:00Z"), new Set());
		assert.equal(requests.length, before, "mesmo dia, processo novo: nenhuma chamada ao modelo");
		assert.equal(await prisma.sleepReport.count({ where: { botId: botA, kind: "daily" } }), 1);

		await prisma.conversationMessage.create({ data: { conversationId: convA, role: "user", content: "Gosto de café sem açúcar", createdAt: new Date("2026-11-05T12:00:00Z") } });
		script = () => ({ facts: [], notes: [], skills: [] });
		await sleepTick(makeDeps({ enabled: true, accounts: [a] }, "2026-11-06T02:31:00Z"), new Set());
		const user = requests.at(-1)!.user;
		assert.ok(user.includes("Gosto de café sem açúcar") && !user.includes("Moro em Curitiba"), "só o que veio depois do sono anterior");
		assert.equal(await prisma.sleepReport.count({ where: { botId: botA, kind: "daily" } }), 2);
	});

	test("domingo: o doctor propõe duplicata, velho e conflito e não apaga nada", async () => {
		const stale = await prisma.memoryEntry.create({ data: { userId: a, botId: botA, target: "memory", content: "Item antigo sem mudança", updatedAt: new Date("2025-01-01T00:00:00Z"), createdAt: new Date("2025-01-01T00:00:00Z") } });
		const twin1 = await prisma.memoryEntry.create({ data: { userId: a, target: "user", content: "Prefere reuniões curtas pela manhã com a equipe" } });
		const twin2 = await prisma.memoryEntry.create({ data: { userId: a, target: "user", content: "prefere reunioes curtas pela manha com a equipe!" } });
		script = (tool) => (tool === SUBMIT_DOCTOR_TOOL ? { conflicts: [{ subject: "memory", ids: [twin1.id, stale.id], reason: "Contradição de teste." }] } : { facts: [], notes: [], skills: [] });
		await sleepTick(makeDeps({ enabled: true, accounts: [a] }, "2026-11-09T02:31:00Z"), new Set());
		const doctor = await prisma.sleepReport.findFirstOrThrow({ where: { botId: botA, kind: "doctor" } });
		const kinds = (doctor.proposalsJson as Array<{ finding: { type: string; ids: string[] } }>).map((p) => p.finding.type).sort();
		assert.deepEqual(kinds, ["conflict", "duplicate", "stale"]);
		assert.equal(doctor.status, "done");
		assert.equal(await prisma.memoryEntry.count({ where: { id: { in: [stale.id, twin1.id, twin2.id] } } }), 3, "o doctor só propõe");
		assert.ok(requests.some((r) => r.system.includes("contradictions")));
		void SUBMIT_SLEEP_TOOL;
	});

	test("falha do modelo vira relatório falho e não perde o dia", async () => {
		const failingBot = (await prisma.bot.create({ data: { ownerId: a, name: "falha", conversationId: (await prisma.conversation.create({ data: { userId: a } })).id }, select: { id: true } })).id;
		const failingConv = (await prisma.bot.findUniqueOrThrow({ where: { id: failingBot } })).conversationId!;
		await prisma.conversationMessage.create({ data: { conversationId: failingConv, role: "user", content: "algo importante", createdAt: new Date("2026-11-10T12:00:00Z") } });
		const broken: Llm = { contextWindow: async () => 1, async *chat() { throw new Error("sem chave do provedor"); } };
		const deps = { ...makeDeps({ enabled: true, accounts: [a] }, "2026-11-11T02:31:00Z"), portsFor: realPortsFor(config, () => undefined, async () => broken) };
		await sleepTick(deps, new Set());
		const report = await prisma.sleepReport.findFirstOrThrow({ where: { botId: failingBot, kind: "daily" } });
		assert.deepEqual([report.status, report.detail, report.windowEnd], ["failed", "sem chave do provedor", null]);
	});
});
