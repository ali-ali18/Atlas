/**
 * Rotas das regras aprendidas (F5.2). Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/routes/bot-rules.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { LEARNED_RULES_MAX, patchRuleInPolicy, readLearnedRules, removeRuleFromPolicy, ruleId } from "@workspace/shared";
import type { AuthEnv } from "../middleware/auth.js";
import { createBotRuleRoutes, type BotRuleRouteDeps } from "./bot-rules.js";

const SEND = ruleId({ match: "gmail_send", effect: "send" });

function appWith(userId = "u1") {
	const bots = new Map<string, { ownerId: string; policy: Record<string, unknown> }>([["b1", { ownerId: "u1", policy: { engine: "v2", rules: [{ match: "gmail_send", effect: "send", verdict: "approve", source: "learned" }, { match: "web_*", verdict: "run" }] } }]]);
	const owned = (user: string, botId: string) => (bots.get(botId)?.ownerId === user ? bots.get(botId)! : null);
	const deps: BotRuleRouteDeps = {
		list: async (user, botId) => {
			const bot = owned(user, botId);
			return bot ? readLearnedRules(bot.policy) : null;
		},
		patch: async (user, botId, id, patch) => {
			const bot = owned(user, botId);
			if (!bot) return { ok: false, reason: "not_found" };
			const next = patchRuleInPolicy(bot.policy, id, patch);
			if (!next) return { ok: false, reason: "rule_not_found" };
			if ("refused" in next) return { ok: false, reason: "refused", message: next.refused };
			bot.policy = next.policyJson;
			return { ok: true, rule: next.rule };
		},
		remove: async (user, botId, id) => {
			const bot = owned(user, botId);
			if (!bot) return { ok: false, reason: "not_found" };
			const next = removeRuleFromPolicy(bot.policy, id);
			if (!next) return { ok: false, reason: "rule_not_found" };
			bot.policy = next.policyJson;
			return { ok: true, rule: next.rule };
		},
	};
	const app = new Hono<AuthEnv>();
	app.use("*", async (c, next) => {
		c.set("session", { user: { id: userId } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	app.route("/", createBotRuleRoutes(deps));
	return { app, bots };
}

const send = (method: string, body?: unknown) => ({ method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test("o dono lista, edita e apaga as regras; o resto da política fica", async () => {
	const { app, bots } = appWith();
	const listed = (await (await app.request("/v1/bots/b1/rules")).json()) as { rules: Array<{ id: string; match: string; verdict: string }> };
	assert.deepEqual(listed.rules.map((r) => [r.match, r.verdict]), [["gmail_send", "approve"], ["web_*", "run"]]);
	const patched = await app.request(`/v1/bots/b1/rules/${SEND}`, send("PATCH", { verdict: "deny", note: "nunca sem eu ver" }));
	assert.equal(patched.status, 200);
	assert.deepEqual(((await patched.json()) as { rule: { verdict: string; note: string } }).rule, { id: SEND, match: "gmail_send", effect: "send", verdict: "deny", note: "nunca sem eu ver", source: "learned", learnedAt: null });
	assert.equal(bots.get("b1")?.policy.engine, "v2");
	assert.equal((await app.request(`/v1/bots/b1/rules/${ruleId({ match: "web_*" })}`, send("DELETE"))).status, 200);
	assert.deepEqual(readLearnedRules(bots.get("b1")?.policy).map((r) => r.match), ["gmail_send"]);
});

test("regra inexistente é 404 e corpo inválido é 400", async () => {
	const { app } = appWith();
	assert.equal((await app.request("/v1/bots/b1/rules/rule_00000000", send("PATCH", { verdict: "run" }))).status, 404);
	assert.equal((await app.request("/v1/bots/b1/rules/rule_00000000", send("DELETE"))).status, 404);
	for (const bad of [{}, { verdict: "tudo" }, { match: "outro" }, { note: "x".repeat(300) }]) assert.equal((await app.request(`/v1/bots/b1/rules/${SEND}`, send("PATCH", bad))).status, 400, JSON.stringify(bad).slice(0, 40));
});

test("IDOR: o usuário B não vê, edita nem apaga as regras do bot do A (404) e nada muda", async () => {
	const { app, bots } = appWith("u2");
	assert.equal((await app.request("/v1/bots/b1/rules")).status, 404);
	assert.equal((await app.request(`/v1/bots/b1/rules/${SEND}`, send("PATCH", { verdict: "run" }))).status, 404);
	assert.equal((await app.request(`/v1/bots/b1/rules/${SEND}`, send("DELETE"))).status, 404);
	assert.equal(readLearnedRules(bots.get("b1")?.policy).find((r) => r.id === SEND)?.verdict, "approve");
});

test("edição acima do teto de regras é recusada com 422 e mensagem honesta, sem cortar nada (auditoria F5, S2)", async () => {
	const { app, bots } = appWith();
	const many = Array.from({ length: LEARNED_RULES_MAX + 1 }, (_, i) => ({ match: `tool_${i}`, verdict: "run" }));
	bots.get("b1")!.policy = { rules: many };
	const res = await app.request(`/v1/bots/b1/rules/${ruleId({ match: "tool_0" })}`, send("PATCH", { verdict: "deny" }));
	assert.equal(res.status, 422);
	assert.match(((await res.json()) as { error: string }).error, /máximo é 100/);
	assert.equal((bots.get("b1")!.policy.rules as unknown[]).length, LEARNED_RULES_MAX + 1);
});
