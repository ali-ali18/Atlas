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
	/** Efeito desta chamada (`resolveToolEffect`) ou, na montagem do catálogo, o mais permissivo possível (`nativePolicyTool(name)`). */
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
	/**
	 * O turno atual veio de uma pessoa (o mesmo `humanTurn` do motor v2: falso em run sintético de chat, como
	 * retomada, worker de grupo, evento de config do bot ou questionário respondido). Sem ele a origem `chat` não conta como humano.
	 * Em subagente, é o do pai.
	 */
	humanTurn: boolean;
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
	/** `catalog` (padrão): `hide` tira a tool do modelo. `execute`: a tool já foi chamada, então o que seria `hide` vira `deny` com o motivo. */
	stage?: "catalog" | "execute";
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

/** Tool nativa sem metadado de efeito: nunca `allow`. Some do catálogo e, se chamada mesmo assim, é negada. */
export function unknownToolResult(stage: PolicyContext["stage"]): PolicyResult {
	return { decision: stage === "execute" ? "deny" : "hide", reason: "unknown tool: no effect metadata" };
}

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

/** Dica acionável (para o modelo) quando uma chamada com estes args é negada sem humano. */
const NO_HUMAN_HINTS: Readonly<Record<string, string>> = {
	sandbox_download: "set use_browser_session false (the browser session cookies are not sent without a human present)",
	api_call: "only GET/HEAD requests are allowed without a human present",
};

export function explainDecision(tool: PolicyTool, ctx: PolicyContext): PolicyResult {
	const raw = explainStatic(tool, ctx);
	if (ctx.stage !== "execute" || raw.decision !== "hide") return raw;
	const hint = NO_HUMAN_HINTS[tool.name];
	return { decision: "deny", reason: hint && raw.reason.startsWith("no human present") ? `${raw.reason}: ${hint}` : raw.reason };
}

function explainStatic(tool: PolicyTool, ctx: PolicyContext): PolicyResult {
	const result = (decision: PolicyDecision, reason: string): PolicyResult => ({ decision, reason });
	const rules = ctx.userRules;

	if (rules?.mode === "blocked") return result("hide", "blocked by the user");

	// Rascunho aprovável para o dono: não escreve fora, só prepara. Vale em qualquer origem.
	if (tool.name === PREPARE_FOR_OWNER_TOOL) return result("allow", "draft for the owner to approve");

	// O filho herda a origem do pai (humano ou não); mas ele mesmo nunca mostra cartão, então `ask` vira `deny`.
	const resolved = resolvePolicyOrigin(ctx);
	const human = ctx.humanPresent && ctx.humanTurn && originHasHuman(resolved);
	const canAsk = human && ctx.origin !== "subagent";

	if (tool.needsHuman && !human) return result("hide", "needs a human in the conversation");
	if (tool.connectorId && ctx.connectorReadOnly?.(tool.connectorId) && tool.effect !== "read") return result("hide", "read-only connector");
	if (!human && EXTERNAL_EFFECTS.has(tool.effect)) return result("hide", `no human present: ${tool.effect} is never done alone`);

	const asks = (reason: string): PolicyResult => (canAsk ? result("ask", reason) : result("deny", `${reason}; nobody to approve`));

	if (tool.effect === "read") return rules?.confirmAlways ? asks("user rule: always confirm") : result("allow", "read");

	if (rules?.confirmAlways) return asks("user rule: always confirm");
	if (ctx.planPending) return asks("plan awaiting approval");
	if (rules?.mode === "always_ask" && !ALWAYS_ASK_EFFECTS.has(tool.effect)) return asks("autonomy exception: always ask");
	// Link público, segredo, envio e dinheiro pedem cartão com humano em qualquer autonomia, inclusive com `never_ask`.
	// Única exceção: e-mail numa caixa com resposta automática ligada.
	if (tool.effect === "send" && EMAIL_SEND_TOOLS.has(tool.name) && ctx.emailAutoReply) return result("allow", "mailbox auto-reply is on");
	if (ALWAYS_ASK_EFFECTS.has(tool.effect)) return asks(tool.effect === "send" && EMAIL_SEND_TOOLS.has(tool.name) ? "email send needs approval" : `${tool.effect} always asks`);
	if (rules?.mode === "never_ask") return result("allow", "autonomy exception: never ask");

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
