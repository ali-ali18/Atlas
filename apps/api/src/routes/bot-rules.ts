import { Hono } from "hono";
import { parseRulePatch, type LearnedRuleView, type RulePatch } from "@workspace/shared";
import { listBotRulesForOwner, patchBotRuleForOwner, removeBotRuleForOwner } from "@workspace/db";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

type RuleOutcome = { ok: true; rule: LearnedRuleView } | { ok: false; reason: "not_found" | "rule_not_found" | "conflict" } | { ok: false; reason: "refused"; message: string };

/** Portas do banco (injetáveis nos testes). Toda porta confere o dono do bot na própria consulta. */
export type BotRuleRouteDeps = {
	list(userId: string, botId: string): Promise<LearnedRuleView[] | null>;
	patch(userId: string, botId: string, ruleId: string, patch: RulePatch): Promise<RuleOutcome>;
	remove(userId: string, botId: string, ruleId: string): Promise<RuleOutcome>;
};

const defaultDeps: BotRuleRouteDeps = { list: listBotRulesForOwner, patch: patchBotRuleForOwner, remove: removeBotRuleForOwner };

const BOT_NOT_FOUND = { error: "Bot não encontrado" } as const;
const RULE_NOT_FOUND = { error: "Regra não encontrada" } as const;

const answer = (c: { json: (body: unknown, status?: 404 | 409 | 422) => Response }, outcome: RuleOutcome, ok: (rule: LearnedRuleView) => Response): Response => {
	if (outcome.ok) return ok(outcome.rule);
	if (outcome.reason === "conflict") return c.json({ error: "As regras mudaram enquanto você editava. Abra de novo e refaça.", code: "conflict" }, 409);
	if (outcome.reason === "refused") return c.json({ error: outcome.message, code: "refused" }, 422);
	return c.json(outcome.reason === "not_found" ? BOT_NOT_FOUND : RULE_NOT_FOUND, 404);
};

/**
 * Regras aprendidas do bot (F5.2): o dono vê, edita e apaga as regras de política (`policyJson.rules`) que o bot aprendeu.
 * Só o dono do bot: bot de outro usuário é 404, igual a inexistente. O `userId` vem da sessão. A regra não se cria aqui:
 * nasce de um "sempre permitir/perguntar" no chat. A edição muda a decisão (`run`, `approve`, `deny`) e a observação.
 */
export function createBotRuleRoutes(deps: BotRuleRouteDeps = defaultDeps) {
	const app = new Hono<AuthEnv>();

	app.get("/v1/bots/:botId/rules", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const rules = await deps.list(userId, c.req.param("botId"));
			return rules ? c.json({ rules }) : c.json(BOT_NOT_FOUND, 404);
		} catch (error) {
			console.error("list bot rules failed", error);
			return c.json({ error: "Failed to load rules" }, 503);
		}
	});

	app.patch("/v1/bots/:botId/rules/:ruleId", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		const parsed = parseRulePatch(body);
		if (!parsed.ok) return c.json({ error: parsed.error }, 400);
		try {
			const { userId } = scopeFor(c.get("session"));
			return answer(c, await deps.patch(userId, c.req.param("botId"), c.req.param("ruleId"), parsed.value), (rule) => c.json({ rule }));
		} catch (error) {
			console.error("patch bot rule failed", error);
			return c.json({ error: "Failed to save rule" }, 503);
		}
	});

	app.delete("/v1/bots/:botId/rules/:ruleId", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			return answer(c, await deps.remove(userId, c.req.param("botId"), c.req.param("ruleId")), (rule) => c.json({ rule }));
		} catch (error) {
			console.error("remove bot rule failed", error);
			return c.json({ error: "Failed to remove rule" }, 503);
		}
	});

	return app;
}
