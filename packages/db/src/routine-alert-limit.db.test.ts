/** Limite de 30 alertas com chamadas em paralelo e ida e volta do JSON da regra no Postgres real. */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ALERT_ACTIVE_LIMIT, parseAlertRule, parseRoutineAlert } from "@workspace/shared";
import { prisma } from "./client.js";
import { AlertLimitError, countActiveAlerts, createRoutine, recordRoutineAlertState, updateRoutine } from "./routines.js";
import { createTestBot, createTestUser, dbSkip } from "./testing/test-db.js";

const input = (botId: string, name: string, extra: Record<string, unknown> = {}) => ({
	botId, name, prompt: "verifique", triggerType: "interval" as const, trigger: { kind: "interval" as const, everyMinutes: 120 }, alert: { condition: `alerta ${name}` }, ...extra,
});

describe("limite de alertas e regra no Postgres real", { skip: dbSkip }, () => {
	let userId: string;
	let otherId: string;
	let botId: string;
	before(async () => {
		userId = (await createTestUser("alert-limit")).id;
		otherId = (await createTestUser("alert-limit-b")).id;
		botId = (await createTestBot(userId)).id;
	});
	after(async () => {
		await prisma.$disconnect();
	});

	test("duas criações em paralelo com 29 alertas: exatamente uma passa", async () => {
		for (let i = 0; i < ALERT_ACTIVE_LIMIT - 1; i += 1) await createRoutine(userId, input(botId, `base-${i}`));
		assert.equal(await countActiveAlerts(userId), 29);
		const results = await Promise.allSettled([createRoutine(userId, input(botId, "corrida-a")), createRoutine(userId, input(botId, "corrida-b"))]);
		assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
		const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
		assert.ok(failed.reason instanceof AlertLimitError);
		assert.equal(await countActiveAlerts(userId), 30);
	});

	test("muitas em paralelo: nunca passa de 30; os alertas de outro usuário não contam", async () => {
		const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => createRoutine(userId, input(botId, `extra-${i}`))));
		assert.equal(results.filter((r) => r.status === "fulfilled").length, 0);
		assert.equal(await countActiveAlerts(userId), 30);
		const otherBot = (await createTestBot(otherId)).id;
		await createRoutine(otherId, input(otherBot, "do-outro"));
		assert.equal(await countActiveAlerts(otherId), 1);
	});

	test("religar dois alertas pausados em paralelo com 29 ativos: só um volta", async () => {
		const mine = await prisma.routine.findMany({ where: { userId, botId }, orderBy: { createdAt: "asc" }, take: 3, select: { id: true } });
		await prisma.routine.updateMany({ where: { id: { in: mine.map((r) => r.id) } }, data: { enabled: false } });
		assert.equal(await countActiveAlerts(userId), 27);
		await updateRoutine(userId, botId, mine[0]!.id, { enabled: true });
		const results = await Promise.allSettled([updateRoutine(userId, botId, mine[1]!.id, { enabled: true }), updateRoutine(userId, botId, mine[2]!.id, { enabled: true }), createRoutine(userId, input(botId, "tentativa"))]);
		assert.equal(results.filter((r) => r.status === "fulfilled").length, 2, "27 + 1 = 28: sobram 2 vagas para 3 tentativas");
		assert.equal(await countActiveAlerts(userId), 30);
	});

	test("a regra gravada volta idêntica do JSONB e o guarda do record a reconhece (o estado grava)", async () => {
		const parsed = parseAlertRule({
			source: { type: "page", url: "https://loja.example.com/p?id=7#x", extract: { kind: "css", selector: "span.price", attribute: "content" } },
			check: { kind: "value", parse: "money", op: "lt", value: 400, currency: "BRL" },
			label: "tênis Nike", message: "baixou para {value}", intervalMinutes: 5,
		});
		assert.ok(parsed.ok);
		const owner = (await createTestUser("alert-rt")).id;
		const bot = (await createTestBot(owner)).id;
		const { routine } = await createRoutine(owner, input(bot, "rt", { alert: { rule: parsed.rule } }));
		const stored = parseRoutineAlert((await prisma.routine.findUniqueOrThrow({ where: { id: routine.id }, select: { alertJson: true } })).alertJson);
		assert.deepEqual(stored?.rule, parsed.rule);
		// Reparse do que veio do banco é idempotente e o record (que compara a regra no JSONB) grava.
		const again = parseAlertRule(stored?.rule);
		assert.ok(again.ok);
		assert.deepEqual(again.rule, parsed.rule);
		const next = { ...stored!, active: true, ruleState: { lastValue: 389.9, consecutive: 2 } };
		assert.equal(await recordRoutineAlertState(owner, routine.id, next), true);
		const after = parseRoutineAlert((await prisma.routine.findUniqueOrThrow({ where: { id: routine.id }, select: { alertJson: true } })).alertJson);
		assert.deepEqual(after?.ruleState, { lastValue: 389.9, consecutive: 2 });
		// regra editada no meio: o resultado velho não grava
		assert.equal(await recordRoutineAlertState(owner, routine.id, { ...next, rule: { ...parsed.rule, label: "outro" } }), false);
		assert.equal(await recordRoutineAlertState("alguem-else", routine.id, next), false);
	});
});
