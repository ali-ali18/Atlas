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
export function fnv1a(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i += 1) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

export const ruleId = (rule: { match: string; effect?: EffectClass | null }): string => `rule_${fnv1a(`${rule.match}\n${rule.effect ?? "*"}`)}`;

/** Erro honesto se a lista passaria do teto; `null` se cabe. Escrever acima do teto é recusado, nunca cortado. */
export function rulesCeilingError(count: number): string | null {
	return count > LEARNED_RULES_MAX ? `O bot já tem regras demais (${count}; o máximo é ${LEARNED_RULES_MAX}). Apague algumas antes de mudar.` : null;
}

function rawRules(policyJson: unknown): unknown[] {
	if (typeof policyJson !== "object" || policyJson === null || Array.isArray(policyJson)) return [];
	const list = (policyJson as Record<string, unknown>)[LEARNED_RULES_KEY];
	return Array.isArray(list) ? list : [];
}

/**
 * Leitura TOLERANTE de uma regra guardada. O autorizador só precisa de `match`, `effect` e `verdict`, então um campo
 * decorativo estragado (observação longa, origem desconhecida) não pode tirar a regra de vigor: vira o padrão. Duas
 * decisões de segurança: `verdict` desconhecido ou `match` vazio não é regra; `effect` desconhecido numa regra que
 * LIBERA ou PERGUNTA descarta a regra (liberaria mais do que o dono quis), e numa `deny` vira "qualquer efeito" (nega mais).
 */
function parseStoredRule(item: unknown): LearnedRuleView | null {
	if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
	const raw = item as Record<string, unknown>;
	const match = typeof raw.match === "string" ? raw.match.trim() : "";
	if (match.length === 0) return null;
	const verdict = (RULE_VERDICTS as readonly string[]).includes(raw.verdict as string) ? (raw.verdict as PolicyRule["verdict"]) : null;
	if (!verdict) return null;
	let effect: EffectClass | null = null;
	// `effect: null` explícito não é "qualquer efeito" para quem libera: só uma `deny` pode valer mais larga (reauditoria F5, N2).
	if (raw.effect === null && verdict !== "deny") return null;
	if (raw.effect !== undefined && raw.effect !== null) {
		if ((EFFECT_CLASSES as readonly string[]).includes(raw.effect as string)) effect = raw.effect as EffectClass;
		else if (verdict !== "deny") return null;
	}
	const note = typeof raw.note === "string" && raw.note.trim().length > 0 && raw.note.trim().length <= RULE_NOTE_MAX_CHARS ? raw.note.trim() : null;
	const source = (RULE_SOURCES as readonly string[]).includes(raw.source as string) ? (raw.source as RuleSource) : "owner";
	const learnedAt = typeof raw.learnedAt === "string" && raw.learnedAt.length <= 40 ? raw.learnedAt : null;
	return { id: ruleId({ match, effect }), match, effect, verdict, note, source, learnedAt };
}

/**
 * Regras da política, na ordem guardada, sem perder nenhuma que valha: item sem `match`/`verdict` válido é ignorado (o
 * autorizador também o ignoraria) e NENHUMA regra válida é cortada por teto (o teto vale na ESCRITA; ver
 * `rulesCeilingError`), então uma `deny` antiga continua valendo. Ler nunca grava.
 */
export function readLearnedRules(policyJson: unknown): LearnedRuleView[] {
	const byId = new Map<string, LearnedRuleView>();
	for (const item of rawRules(policyJson)) {
		const view = parseStoredRule(item);
		if (!view) continue;
		byId.delete(view.id);
		byId.set(view.id, view);
	}
	return [...byId.values()];
}

/** As regras no formato do autorizador (`PolicyContext.rules`): só o que ele lê. */
export function toPolicyRules(policyJson: unknown): PolicyRule[] {
	return readLearnedRules(policyJson).map((rule) => ({ match: rule.match, ...(rule.effect && { effect: rule.effect }), verdict: rule.verdict }));
}

function withRawRules(policyJson: unknown, rules: readonly unknown[]): Record<string, unknown> {
	const base = typeof policyJson === "object" && policyJson !== null && !Array.isArray(policyJson) ? { ...(policyJson as Record<string, unknown>) } : {};
	base[LEARNED_RULES_KEY] = rules;
	return base;
}

const idOfRaw = (item: unknown): string | null => parseStoredRule(item)?.id ?? null;

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

export type RuleEdit = { policyJson: Record<string, unknown>; rule: LearnedRuleView };
/** A edição foi recusada com um motivo para o dono (a rota responde 422). */
export type RuleEditRefused = { refused: string };

/**
 * Aplica a edição SÓ na regra alvo (a última com esse id): as outras ficam exatamente como estão guardadas, com os campos
 * que a tela não conhece. `null` se a regra não existe. A política devolvida mantém todas as outras chaves.
 */
export function patchRuleInPolicy(policyJson: unknown, id: string, patch: RulePatch): RuleEdit | RuleEditRefused | null {
	const raws = rawRules(policyJson);
	let index = -1;
	raws.forEach((item, i) => {
		if (idOfRaw(item) === id) index = i;
	});
	if (index < 0) return null;
	const ceiling = rulesCeilingError(raws.length);
	if (ceiling) return { refused: ceiling };
	const current = parseStoredRule(raws[index])!;
	const nextNote = patch.note !== undefined ? (patch.note && patch.note.length > 0 ? patch.note : null) : current.note;
	const stored: Record<string, unknown> = { ...(raws[index] as Record<string, unknown>) };
	if (patch.verdict) stored.verdict = patch.verdict;
	if (patch.note !== undefined) {
		if (nextNote) stored.note = nextNote;
		else delete stored.note;
	}
	const rule: LearnedRuleView = { ...current, verdict: patch.verdict ?? current.verdict, note: nextNote };
	return { policyJson: withRawRules(policyJson, raws.map((item, i) => (i === index ? stored : item))), rule };
}

/** Tira a regra alvo (todas as entradas com esse id são redundantes); as outras ficam como estão. `null` se não existe. */
export function removeRuleFromPolicy(policyJson: unknown, id: string): RuleEdit | null {
	const raws = rawRules(policyJson);
	const rule = readLearnedRules(policyJson).find((item) => item.id === id);
	if (!rule) return null;
	return { policyJson: withRawRules(policyJson, raws.filter((item) => idOfRaw(item) !== id)), rule };
}
