import { globMatch } from "./glob.js";
import { checkMandate } from "./mandate.js";
import type { DecideInput, EffectClass, PolicyRule, Surface, Verdict } from "./types.js";

/** Ações que são sempre do dono (cláusula 5). Nenhuma autonomia, regra ou mandato libera. */
export const HANDOFF_ACTIONS = ["change_password", "move_money_between_accounts", "accept_terms", "create_account", "invest"] as const;
export type HandoffKind = (typeof HANDOFF_ACTIONS)[number];

export function isHandoffKind(value: string | undefined): value is HandoffKind {
	return value !== undefined && (HANDOFF_ACTIONS as readonly string[]).includes(value);
}

/** Superfícies que nunca têm o dono na conversa. */
const NO_OWNER_SURFACES: ReadonlySet<Surface> = new Set(["agenda", "routine", "subagent", "bot_to_bot"]);
/** Sem dono, estes efeitos não são nem oferecidos (saída: `prepare_for_owner`). */
const OWNER_ONLY_EFFECTS: ReadonlySet<EffectClass> = new Set(["send", "money", "public_link", "credential", "destructive", "write_external"]);
/** Efeitos que saem do Atlas: com taint, `run` vira `approve` (cláusula 8). */
const TAINT_EFFECTS: ReadonlySet<EffectClass> = new Set(["send", "write_external", "public_link"]);
/** Única coisa que regra do dono pode afrouxar. Dinheiro, credencial, envio, link e destrutivo ficam fora. */
const LOOSENABLE_EFFECTS: ReadonlySet<EffectClass> = new Set(["draft", "write_internal", "write_external"]);

/** Base pela classe de efeito e autonomia, antes de taint, mandato e regras. */
function baseVerdict(effect: EffectClass, autonomy: DecideInput["autonomy"]): Verdict {
	switch (effect) {
		case "read":
		case "draft":
			return { kind: "run" };
		case "write_internal":
			return autonomy === "always_ask" ? { kind: "approve", reason: "autonomy always_ask: internal write" } : { kind: "run" };
		case "write_external":
			return autonomy === "autonomous" ? { kind: "run" } : { kind: "approve", reason: `autonomy ${autonomy}: external write` };
		default:
			// send, public_link, credential, money, destructive: cartão em qualquer autonomia.
			return { kind: "approve", reason: `${effect} always asks` };
	}
}

/** Última regra que casa vence (o dono acrescenta no fim para mudar de ideia). */
function lastMatchingRule(rules: readonly PolicyRule[], effect: EffectClass, toolName: string | undefined): PolicyRule | undefined {
	if (toolName === undefined) return undefined;
	for (let i = rules.length - 1; i >= 0; i--) {
		const rule = rules[i]!;
		if ((rule.effect === undefined || rule.effect === effect) && globMatch(rule.match, toolName)) return rule;
	}
	return undefined;
}

/**
 * Decisão de permissão do motor v4. PURA: só dados estruturados, nenhum texto livre, relógio injetado.
 * É a mesma função em todas as superfícies (cláusula 16).
 *
 * Precedência (a primeira que se aplica vence; o resto só aperta, nunca afrouxa o que está acima):
 *  1. handoff: ação da lista fixa. Vence tudo, até superfície sem dono (o run estaciona no "passo seu").
 *  2. regra do dono `deny` (a última que casa): `hidden`.
 *  3. sem dono (superfície agenda/rotina/subagente/bot_to_bot, ou dono ausente): efeito externo, dinheiro,
 *     credencial e destrutivo viram `hidden`. Não há quem aprove e a agenda não vê o que pode enviar.
 *  4. base pela classe de efeito e autonomia.
 *  5. taint: send/write_external/public_link (e tool com `egress`, mesmo `read`) nunca ficam em `run` com leitura ou
 *     argumento não confiável.
 *  6. mandato válido: só `money`, só sem taint, só pula o cartão (nunca o `hidden` do passo 3).
 *  7. `confirm` declarado pela tool: `always` (ou `when_untrusted` com leitura não confiável no run) faz `run` virar
 *     `approve`; sem dono vira `hidden` (não há quem confirme).
 *  8. regra do dono (a última que casa): `approve` aperta qualquer coisa; `run` só afrouxa
 *     draft/write_internal/write_external, e nunca por cima de taint nem de `confirm`.
 */
export function decide(input: DecideInput): Verdict {
	const { effect, surface, autonomy, taint, action } = input;

	if (isHandoffKind(action?.handoffKind)) return { kind: "handoff", reason: `${action.handoffKind} is always the owner's` };

	const rule = lastMatchingRule(input.rules, effect, action?.toolName);
	if (rule?.verdict === "deny") return { kind: "hidden", reason: "owner rule: denied" };

	if ((!input.ownerPresent || NO_OWNER_SURFACES.has(surface)) && OWNER_ONLY_EFFECTS.has(effect)) {
		return { kind: "hidden", reason: `no owner present: ${effect} is not offered here` };
	}

	let verdict = baseVerdict(effect, autonomy);

	const tainted = taint.untrustedReadInRun || taint.argsCarryUntrusted;
	// Egress (URL/consulta a terceiro) só pede aprovação com a trifeta completa: conteúdo não confiável E dado privado do
	// dono no mesmo run. Pesquisa pura na web (só dado público) segue autônoma: pedir cartão a cada página lida mataria a
	// pesquisa (decisão do dono, 06/11; cláusula 8 fala em efeito que carregue dado privado).
	// A trifeta da saída olha só o que ESTE run leu por tool (`...ThisRun`); sem o campo, vale o sinal herdado.
	const egressRisk = input.egress === true && (taint.untrustedReadThisRun ?? taint.untrustedReadInRun) && (taint.privateReadThisRun ?? taint.privateReadInRun === true);
	const taintFloor = (tainted && TAINT_EFFECTS.has(effect)) || egressRisk;
	// Sem dono não há quem veja o cartão: a saída na trifeta fica fora, como um envio sem dono (passo 3).
	if (egressRisk && (!input.ownerPresent || NO_OWNER_SURFACES.has(surface))) return { kind: "hidden", reason: "no owner present: egress after private and untrusted reads" };
	if (taintFloor && verdict.kind === "run") verdict = { kind: "approve", reason: "untrusted data in the run: confirm first" };

	// `confirm` declarado pela tool: o dono confirma. Sem dono, a tool fica fora; regra `run` não afrouxa (abaixo).
	const confirmFloor = input.confirm === "always" || (input.confirm === "when_untrusted" && taint.untrustedReadInRun);
	if (confirmFloor && (!input.ownerPresent || NO_OWNER_SURFACES.has(surface))) return { kind: "hidden", reason: "no owner present: this action needs the owner to confirm" };
	if (confirmFloor && verdict.kind === "run") verdict = { kind: "approve", reason: "owner confirms this action" };

	if (effect === "money" && input.mandate && input.riskFacts && !tainted) {
		const { amount, currency, merchant } = input.riskFacts;
		if (amount !== undefined && currency !== undefined && merchant !== undefined) {
			if (checkMandate(input.mandate, { amount, currency, merchant, now: input.now }).ok) return { kind: "run", reason: "mandate" };
		}
	}

	if (rule?.verdict === "approve" && verdict.kind === "run") return { kind: "approve", reason: "owner rule: always confirm" };
	if (rule?.verdict === "run" && verdict.kind === "approve" && LOOSENABLE_EFFECTS.has(effect) && !taintFloor && !confirmFloor) {
		return { kind: "run", reason: "owner rule: allowed" };
	}
	return verdict;
}
