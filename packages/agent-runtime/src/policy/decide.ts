import type { AutonomyExceptionMode, AutonomyLevel } from "@workspace/shared";
import type { ToolEffect } from "../tools/registry/types.js";

/**
 * Ponto único de permissões do harness v3 (desenho, seção 7). Função pura: sem I/O, sem relógio, sem ler o
 * texto do usuário ou do modelo. Decide pelo efeito da tool e pelo contexto do run, e devolve:
 * - `hide`: a tool nem aparece no catálogo (e, se vier mesmo assim, não executa);
 * - `deny`: existe, mas esta chamada não pode rodar (aprovar seria preciso e não há quem aprove);
 * - `ask`: roda depois de um cartão de aprovação do dono;
 * - `allow`: roda.
 * Regra de ouro: a mais restritiva vence (`hide` > `deny` > `ask` > `allow`). Escopo por dono (IDOR) NÃO é desta
 * camada: continua no executor e no db, pelo `userId` do run.
 */

export type PolicyDecision = "allow" | "ask" | "deny" | "hide";

export type PolicyTool = {
	name: string;
	/** Efeito desta chamada (`resolveToolEffect`) ou o pior caso na montagem do catálogo (`getToolMeta().effect`). */
	effect: ToolEffect;
	/** Conector MCP dono da tool (para `connectorReadOnly`). */
	connectorId?: string;
	/** A tool muda as próprias permissões ou depende de decisão humana. */
	needsHuman?: boolean;
};

export type PolicyUserRules = {
	/** Exceção da autonomia que vale para a tool (`autonomyExceptionMode`): tool vence conector. */
	mode?: AutonomyExceptionMode;
	/** Regra de lição `confirm_always` casou com a tool. */
	confirmAlways?: boolean;
};

export type PolicyContext = {
	/** Origem do run: chat | routine | webhook | proactive | email | bot | subagent. */
	origin: string;
	/** Origem do pai quando `origin` é `subagent`: o filho herda a do pai. Sem ela, o filho é tratado como sem humano. */
	parentOrigin?: string;
	/** Há uma pessoa na conversa para aprovar. Só vale com origem `chat` (ou subagente de um chat). */
	humanPresent: boolean;
	autonomy: AutonomyLevel;
	/** O conector é só-leitura (config do dono). Padrão: nenhum é. */
	connectorReadOnly?: (connectorId: string) => boolean;
	/** Conector com `confirmWrites`: escrita pede cartão em qualquer autonomia. */
	confirmWrites?: boolean;
	/** Caixa de e-mail com resposta automática ligada (`bot_mailboxes.autoReply`): com humano, `send` não pede cartão. */
	emailAutoReply?: boolean;
	/** Há um plano esperando aprovação: escrita pede cartão até o dono decidir. */
	planPending?: boolean;
	userRules?: PolicyUserRules;
};

export type PolicyResult = { decision: PolicyDecision; reason: string };

/** Ponto de extensão (PR futuro): cria um rascunho aprovável no chat do dono; é a única escrita permitida sem humano. */
export const PREPARE_FOR_OWNER_TOOL = "prepare_for_owner";

/** Efeitos que saem do Atlas ou tocam segredo: sem humano na conversa, nem aparecem. */
const EXTERNAL_EFFECTS: ReadonlySet<ToolEffect> = new Set(["write_external", "send", "money", "public_link", "credential"]);
/** Efeitos que pedem cartão em qualquer autonomia (70-padroes: link público e dado sensível; irreversível). */
const ALWAYS_ASK_EFFECTS: ReadonlySet<ToolEffect> = new Set(["send", "money", "public_link", "credential"]);
/** Tools de e-mail que respondem a alguém: a única exceção de `send` é a caixa com resposta automática. */
const EMAIL_SEND_TOOLS: ReadonlySet<string> = new Set(["email_send", "email_reply"]);

export function resolvePolicyOrigin(ctx: Pick<PolicyContext, "origin" | "parentOrigin">): string {
	return ctx.origin === "subagent" ? (ctx.parentOrigin ?? "subagent") : ctx.origin;
}

/** Só o chat direto tem alguém para responder; rotina, webhook, proativo, e-mail recebido e outro bot não. */
export function originHasHuman(resolvedOrigin: string): boolean {
	return resolvedOrigin === "chat";
}

/** O que a política espera de `humanPresent` para uma origem (o chamador pode usar para montar o contexto). */
export function humanPresentFor(origin: string, parentOrigin?: string): boolean {
	return originHasHuman(resolvePolicyOrigin({ origin, parentOrigin }));
}

export function explainDecision(tool: PolicyTool, ctx: PolicyContext): PolicyResult {
	const result = (decision: PolicyDecision, reason: string): PolicyResult => ({ decision, reason });
	const rules = ctx.userRules;

	if (rules?.mode === "blocked") return result("hide", "blocked by the user");

	// Rascunho aprovável para o dono: não escreve fora, só prepara. Vale em qualquer origem.
	if (tool.name === PREPARE_FOR_OWNER_TOOL) return result("allow", "draft for the owner to approve");

	// O filho herda a origem do pai (humano ou não); mas ele mesmo nunca mostra cartão, então `ask` vira `deny`.
	const resolved = resolvePolicyOrigin(ctx);
	const human = ctx.humanPresent && originHasHuman(resolved);
	const canAsk = human && ctx.origin !== "subagent";

	if (tool.needsHuman && !human) return result("hide", "needs a human in the conversation");
	if (tool.connectorId && ctx.connectorReadOnly?.(tool.connectorId) && tool.effect !== "read") return result("hide", "read-only connector");
	if (!human && EXTERNAL_EFFECTS.has(tool.effect)) return result("hide", `no human present: ${tool.effect} is never done alone`);

	const asks = (reason: string): PolicyResult => (canAsk ? result("ask", reason) : result("deny", `${reason}; nobody to approve`));

	if (tool.effect === "read") return rules?.confirmAlways ? asks("user rule: always confirm") : result("allow", "read");

	if (rules?.confirmAlways) return asks("user rule: always confirm");
	if (ctx.planPending) return asks("plan awaiting approval");
	if (tool.effect === "public_link" || tool.effect === "credential") return asks(`${tool.effect} always asks`);
	if (rules?.mode === "always_ask") return asks("autonomy exception: always ask");
	if (rules?.mode === "never_ask") return result("allow", "autonomy exception: never ask");

	if (tool.effect === "send" && EMAIL_SEND_TOOLS.has(tool.name)) return ctx.emailAutoReply ? result("allow", "mailbox auto-reply is on") : asks("email send needs approval");
	if (ALWAYS_ASK_EFFECTS.has(tool.effect)) return asks(`${tool.effect} needs approval`);

	if (tool.effect === "write_external") {
		if (ctx.confirmWrites) return asks("connector confirms writes");
		return ctx.autonomy === "autonomous" ? result("allow", "autonomous: external write") : asks(`autonomy ${ctx.autonomy}: external write`);
	}
	// write_internal: estado do próprio Atlas ou da VM do bot.
	return ctx.autonomy === "always_ask" ? asks("autonomy always_ask: internal write") : result("allow", "internal write");
}

export function decide(tool: PolicyTool, ctx: PolicyContext): PolicyDecision {
	return explainDecision(tool, ctx).decision;
}
