/**
 * Regras aprendidas (Motor v4, F5.2): as regras de política do bot (`Bot.policyJson.rules`) que o dono pode ver, editar
 * e apagar. Funções puras sobre o JSON da política. A forma guardada estende `PolicyRule` de modo aditivo (`note`,
 * `source`, `learnedAt`); o autorizador só lê `match`, `effect` e `verdict`, então o resto é para a tela.
 *
 * Identidade: `id` deriva de `match` + `effect` (o que a regra cobre). Duas regras para o mesmo alvo são redundantes
 * (vale a última), então a leitura as junta. Ler nunca grava.
 */
import { z } from "zod";
import { EFFECT_CLASSES, type EffectClass, type PolicyRule } from "./agent-policy/types.js";

export const LEARNED_RULES_KEY = "rules";
export const LEARNED_RULES_MAX = 100;
export const RULE_MATCH_MAX_CHARS = 120;
export const RULE_NOTE_MAX_CHARS = 240;
export const RULE_SOURCES = ["owner", "learned"] as const;
export type RuleSource = (typeof RULE_SOURCES)[number];
export const RULE_VERDICTS = ["run", "approve", "deny"] as const;

export type LearnedRuleView = {
	id: string;
	match: string;
	effect: EffectClass | null;
	verdict: PolicyRule["verdict"];
	note: string | null;
	source: RuleSource;
	learnedAt: string | null;
};

/** Hash FNV-1a de 32 bits: estável, sem dependência (o shared roda também no celular). */
function fnv1a(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i += 1) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

export const ruleId = (rule: { match: string; effect?: EffectClass | null }): string => `rule_${fnv1a(`${rule.match}\n${rule.effect ?? "*"}`)}`;

const ruleSchema = z.object({
	match: z.string().trim().min(1).max(RULE_MATCH_MAX_CHARS),
	effect: z.enum(EFFECT_CLASSES).optional(),
	verdict: z.enum(RULE_VERDICTS),
	note: z.string().trim().max(RULE_NOTE_MAX_CHARS).optional(),
	source: z.enum(RULE_SOURCES).optional(),
	learnedAt: z.string().max(40).optional(),
});

function rawRules(policyJson: unknown): unknown[] {
	if (typeof policyJson !== "object" || policyJson === null || Array.isArray(policyJson)) return [];
	const list = (policyJson as Record<string, unknown>)[LEARNED_RULES_KEY];
	return Array.isArray(list) ? list : [];
}

/** Regras válidas da política, na ordem guardada. Entrada inválida é ignorada (o autorizador também a ignoraria). */
export function readLearnedRules(policyJson: unknown): LearnedRuleView[] {
	const byId = new Map<string, LearnedRuleView>();
	for (const item of rawRules(policyJson)) {
		const parsed = ruleSchema.safeParse(item);
		if (!parsed.success) continue;
		const rule = parsed.data;
		const view: LearnedRuleView = { id: ruleId(rule), match: rule.match, effect: rule.effect ?? null, verdict: rule.verdict, note: rule.note ?? null, source: rule.source ?? "owner", learnedAt: rule.learnedAt ?? null };
		byId.delete(view.id);
		byId.set(view.id, view);
	}
	return [...byId.values()].slice(-LEARNED_RULES_MAX);
}

/** As regras no formato do autorizador (`PolicyContext.rules`): só o que ele lê. */
export function toPolicyRules(policyJson: unknown): PolicyRule[] {
	return readLearnedRules(policyJson).map((rule) => ({ match: rule.match, ...(rule.effect && { effect: rule.effect }), verdict: rule.verdict }));
}

const toStored = (rule: LearnedRuleView) => ({
	match: rule.match,
	...(rule.effect && { effect: rule.effect }),
	verdict: rule.verdict,
	...(rule.note && { note: rule.note }),
	source: rule.source,
	...(rule.learnedAt && { learnedAt: rule.learnedAt }),
});

function withRules(policyJson: unknown, rules: readonly LearnedRuleView[]): Record<string, unknown> {
	const base = typeof policyJson === "object" && policyJson !== null && !Array.isArray(policyJson) ? { ...(policyJson as Record<string, unknown>) } : {};
	base[LEARNED_RULES_KEY] = rules.map(toStored);
	return base;
}

/** Corpo de `PATCH /v1/bots/:id/rules/:ruleId`: o dono muda o veredito e/ou a observação. O alvo (`match`) não muda. */
export const rulePatchSchema = z
	.strictObject({ verdict: z.enum(RULE_VERDICTS).optional(), note: z.string().trim().max(RULE_NOTE_MAX_CHARS).nullable().optional() })
	.refine((value) => Object.keys(value).length > 0, "Informe o que mudar: a decisão ou a observação.");
export type RulePatch = z.infer<typeof rulePatchSchema>;

export function parseRulePatch(raw: unknown): { ok: true; value: RulePatch } | { ok: false; error: string } {
	const parsed = rulePatchSchema.safeParse(raw);
	if (parsed.success) return { ok: true, value: parsed.data };
	const issue = parsed.error.issues[0];
	if (issue?.code === "unrecognized_keys") return { ok: false, error: `Campo desconhecido: ${issue.keys.join(", ")}.` };
	return { ok: false, error: issue?.message ?? "Pedido inválido." };
}

/** Aplica a edição; `null` se a regra não existe. A política devolvida mantém todas as outras chaves. */
export function patchRuleInPolicy(policyJson: unknown, id: string, patch: RulePatch): { policyJson: Record<string, unknown>; rule: LearnedRuleView } | null {
	const rules = readLearnedRules(policyJson);
	const index = rules.findIndex((rule) => rule.id === id);
	if (index < 0) return null;
	const current = rules[index]!;
	const rule: LearnedRuleView = { ...current, ...(patch.verdict && { verdict: patch.verdict }), ...(patch.note !== undefined && { note: patch.note && patch.note.length > 0 ? patch.note : null }) };
	return { policyJson: withRules(policyJson, rules.map((item, i) => (i === index ? rule : item))), rule };
}

/** Tira a regra; `null` se não existe. */
export function removeRuleFromPolicy(policyJson: unknown, id: string): { policyJson: Record<string, unknown>; rule: LearnedRuleView } | null {
	const rules = readLearnedRules(policyJson);
	const rule = rules.find((item) => item.id === id);
	if (!rule) return null;
	return { policyJson: withRules(policyJson, rules.filter((item) => item.id !== id)), rule };
}
