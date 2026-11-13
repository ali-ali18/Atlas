/**
 * Regras aprendidas do bot (F5.2): leitura, edição e remoção de `Bot.policyJson.rules` pelo DONO. Toda função confere
 * o dono do bot na própria consulta (`ownerId`); bot de outro dono é indistinguível de inexistente. A edição é
 * otimista (só grava se o `updatedAt` lido não mudou) para não atropelar um PATCH concorrente da política.
 */
import { Prisma } from "@prisma/client";
import { patchRuleInPolicy, readLearnedRules, removeRuleFromPolicy, type LearnedRuleView, type RuleEdit, type RuleEditRefused, type RulePatch } from "@workspace/shared";
import { prisma } from "./client.js";

/** `null` = bot inexistente ou de outro dono. */
export async function listBotRulesForOwner(userId: string, botId: string): Promise<LearnedRuleView[] | null> {
	const bot = await prisma.bot.findFirst({ where: { id: botId, ownerId: userId }, select: { policyJson: true } });
	return bot ? readLearnedRules(bot.policyJson) : null;
}

type Outcome = { ok: true; rule: LearnedRuleView } | { ok: false; reason: "not_found" | "rule_not_found" | "conflict" } | { ok: false; reason: "refused"; message: string };

async function mutate(userId: string, botId: string, ruleId: string, apply: (policyJson: unknown) => RuleEdit | RuleEditRefused | null): Promise<Outcome> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const bot = await prisma.bot.findFirst({ where: { id: botId, ownerId: userId }, select: { policyJson: true, updatedAt: true } });
		if (!bot) return { ok: false, reason: "not_found" };
		const next = apply(bot.policyJson);
		if (!next) return { ok: false, reason: "rule_not_found" };
		if ("refused" in next) return { ok: false, reason: "refused", message: next.refused };
		const saved = await prisma.bot.updateMany({ where: { id: botId, ownerId: userId, updatedAt: bot.updatedAt }, data: { policyJson: next.policyJson as Prisma.InputJsonValue } });
		if (saved.count === 1) return { ok: true, rule: next.rule };
	}
	return { ok: false, reason: "conflict" };
}

export const patchBotRuleForOwner = (userId: string, botId: string, ruleId: string, patch: RulePatch): Promise<Outcome> => mutate(userId, botId, ruleId, (policyJson) => patchRuleInPolicy(policyJson, ruleId, patch));
export const removeBotRuleForOwner = (userId: string, botId: string, ruleId: string): Promise<Outcome> => mutate(userId, botId, ruleId, (policyJson) => removeRuleFromPolicy(policyJson, ruleId));
