/**
 * Regras aprendidas do bot contra Postgres real (F5.2): só o dono do bot lê, edita e apaga.
 * Pulado sem ATLAS_TEST_DB_URL. Runner: `pnpm --filter @workspace/db test:db`.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ruleId } from "@workspace/shared";
import { prisma } from "./client.js";
import { listBotRulesForOwner, patchBotRuleForOwner, removeBotRuleForOwner } from "./bot-rules.js";
import { createTestBot, createTestUser, dbSkip } from "./testing/test-db.js";

describe("regras aprendidas (Postgres real)", { skip: dbSkip }, () => {
	let userA: string;
	let userB: string;
	let botA: string;
	const sendId = ruleId({ match: "gmail_send", effect: "send" });

	before(async () => {
		userA = (await createTestUser("rule-a")).id;
		userB = (await createTestUser("rule-b")).id;
		botA = (await createTestBot(userA, { name: "A" })).id;
		await prisma.bot.update({ where: { id: botA }, data: { policyJson: { engine: "v2", rules: [{ match: "gmail_send", effect: "send", verdict: "approve", source: "learned" }, { match: "web_*", verdict: "run" }] } } });
	});
	after(async () => {
		await prisma.$disconnect();
	});

	test("o dono lê, edita e apaga; o resto da política fica intacto", async () => {
		assert.deepEqual((await listBotRulesForOwner(userA, botA))?.map((r) => r.match), ["gmail_send", "web_*"]);
		const patched = await patchBotRuleForOwner(userA, botA, sendId, { verdict: "deny", note: "nunca sem eu ver" });
		assert.ok(patched.ok && patched.rule.verdict === "deny" && patched.rule.note === "nunca sem eu ver");
		const stored = (await prisma.bot.findUniqueOrThrow({ where: { id: botA } })).policyJson as { engine: string; rules: Array<{ verdict: string }> };
		assert.equal(stored.engine, "v2");
		assert.equal(stored.rules[0]?.verdict, "deny");
		const removed = await removeBotRuleForOwner(userA, botA, ruleId({ match: "web_*" }));
		assert.ok(removed.ok);
		assert.deepEqual((await listBotRulesForOwner(userA, botA))?.map((r) => r.match), ["gmail_send"]);
		assert.deepEqual(await removeBotRuleForOwner(userA, botA, "rule_00000000"), { ok: false, reason: "rule_not_found" });
	});

	test("IDOR: outro dono não vê, não edita e não apaga (bot some como inexistente)", async () => {
		assert.equal(await listBotRulesForOwner(userB, botA), null);
		assert.deepEqual(await patchBotRuleForOwner(userB, botA, sendId, { verdict: "run" }), { ok: false, reason: "not_found" });
		assert.deepEqual(await removeBotRuleForOwner(userB, botA, sendId), { ok: false, reason: "not_found" });
		const rules = await listBotRulesForOwner(userA, botA);
		assert.equal(rules?.find((r) => r.id === sendId)?.verdict, "deny");
	});
});
