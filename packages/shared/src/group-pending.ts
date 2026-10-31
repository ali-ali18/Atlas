/**
 * Grupos de bots: o bot principal aceita sozinho os pedidos SEGUROS dos membros
 * (cartão de comando, escrita ou conector). Decisão determinística e pura, sem
 * Jev/LLM: só aprova o que é leitura ou reversível e sem efeito fora da conta;
 * na dúvida, escala (o cartão segue esperando o usuário, como antes).
 */
import type { BotNeed } from "./bot-messaging.js";
import type { BotPendingItem } from "./bot-pending.js";
import { hasIrreversibleToolName, hasOutwardVerb, toolNameTokens } from "./autonomy-tools.js";
import { decideCommand, riskyReason, sensitiveReadReason } from "./dev-command-approval.js";
import { hasExternalTargetArgs } from "./mcp-task-grant.js";
import { redactSecrets } from "./redact-secrets.js";
import { findSecretRefs } from "./vault.js";

/** Teto de aceites automáticos por turno do grupo (contra laço de aprovações). */
export const GROUP_PENDING_MAX_AUTO = 8;

/** Origens de run que têm humano na conversa; o resto (rotina, webhook, subagente…) nunca é aceito sozinho. */
const ATTENDED_ORIGINS = new Set(["chat"]);

export type GroupPendingMcp = {
	/** Nome original da tool no servidor MCP. */
	toolName: string;
	/** Classe da ação registrada no cartão; ausente = desconhecida (escala). */
	actionClass?: "read" | "write" | "irreversible";
	args: Record<string, unknown>;
	/** `confirmWrites` do conector; `null` = não achei a conexão do dono (escala). */
	confirmWrites: boolean | null;
	/** O Jev levantou o cartão (instrução vinda de fora, alinhamento ou indisponível). */
	jevReview?: boolean;
	/** O run já tinha lido conteúdo que o usuário não escreveu. */
	untrustedSeen?: boolean;
};

export type GroupPendingEscalation =
	| "not-decidable"
	| "questionnaire"
	| "unattended"
	| "self-request"
	| "limit"
	| "hard-deny"
	| "irreversible"
	| "outward"
	| "confirm-writes"
	| "sensitive"
	| "file-write"
	| "command-not-read-only"
	| "external-instruction"
	| "unknown";

export type GroupPendingDecision =
	| { action: "approve"; /** Rótulo curto pt-BR do motivo do aceite ("leitura"). */ why: string }
	| { action: "escalate"; why: GroupPendingEscalation };

export type GroupPendingInput = {
	need: Pick<BotNeed, "type">;
	item: BotPendingItem | undefined;
	/** Origem do run que pediu (`chat` = há humano na conversa). */
	origin: string | undefined;
	/** Quem pediu é o próprio bot principal: não se autoaprova. */
	requesterIsPrimary: boolean;
	/** Aceites automáticos já feitos neste turno. */
	autoCount: number;
	mcp?: GroupPendingMcp;
};

const WHY_LABEL: Record<GroupPendingEscalation, string> = {
	"not-decidable": "só você resolve",
	questionnaire: "é uma pergunta para você",
	unattended: "sem pessoa na conversa",
	"self-request": "pedido do próprio bot principal",
	limit: "muitos aceites neste turno",
	"hard-deny": "comando bloqueado",
	irreversible: "ação sem volta",
	outward: "atinge terceiros",
	"confirm-writes": "o app pede sua confirmação",
	sensitive: "dado sensível",
	"file-write": "altera arquivos",
	"command-not-read-only": "comando que não é só leitura",
	"external-instruction": "pode vir de conteúdo de fora",
	unknown: "sem certeza",
};

/** Texto curto pt-BR de por que o pedido foi para o usuário (log/depuração). */
export function groupEscalationLabel(why: GroupPendingEscalation): string {
	return WHY_LABEL[why];
}

const escalate = (why: GroupPendingEscalation): GroupPendingDecision => ({ action: "escalate", why });

function containsSensitive(value: unknown): boolean {
	let text: string;
	try {
		text = JSON.stringify(value) ?? "";
	} catch {
		return true;
	}
	return findSecretRefs(text).length > 0 || redactSecrets(text) !== text;
}

/** Verbos de gasto/compra/cobrança: o aceite automático nunca cobre (lista própria, a global não muda). */
const SPEND_TOKEN = /^(purchas|buy|bought|subscri|checkout|upgrad|renew|pay(s|ing|ment|ments|out)?$|charg|refund|transfer|spend|bill|invoic)/;

function hasSpendVerb(toolName: string): boolean {
	const tokens = toolNameTokens(toolName);
	if (tokens.some((token) => SPEND_TOKEN.test(token))) return true;
	// create_order / place_order / submit_order…: compromete dinheiro ou estoque.
	return tokens.includes("order") && tokens.some((token) => token === "create" || token === "place" || token === "new" || token === "submit");
}

const ENV_DUMPERS = /(^|[\s;&|()`])(env|printenv|set|export|declare|typeset|compgen)(\s|$|[;&|)])/;
const CREDENTIAL_PATH = /(\.ssh|\.aws|\.netrc|\.npmrc|\.git-credentials|\.pgpass|\.docker\/config\.json|\.gnupg|\.kube|id_rsa|id_ed25519|id_ecdsa|id_dsa|credentials|secrets?\b|\.pem\b|\.key\b|\.p12\b|\.pfx\b|(^|[/\s'"=])\.env)/i;
/** Caminho absoluto fora do workspace (`/workspace` e abaixo é o único lugar que o aceite automático lê). */
const OUTSIDE_ABSOLUTE = /(^|[\s'"=:<>(])\/(?!workspace(\/|\s|$|['"]))/;

/**
 * Comando que pode expor segredo mesmo "só lendo": expansão de variável, despejo de ambiente, `~`, `/proc`,
 * caminho fora do workspace, `..` e arquivos de credencial. Na dúvida, escala.
 */
function commandMaySeeSecrets(cmd: string): boolean {
	if (/[$`]/.test(cmd) || cmd.includes("~") || /\.\.(\/|$|\s)/.test(cmd)) return true;
	if (/environ|\/proc\b/i.test(cmd)) return true;
	return ENV_DUMPERS.test(cmd) || OUTSIDE_ABSOLUTE.test(cmd) || CREDENTIAL_PATH.test(cmd);
}

function decideCommandCard(item: BotPendingItem): GroupPendingDecision {
	if (item.hardDeny) return escalate("hard-deny");
	const command = item.devApproval?.kind === "command" ? item.devApproval.command : "";
	if (!command.trim()) return escalate("unknown");
	if (sensitiveReadReason(command) || containsSensitive(command) || commandMaySeeSecrets(command)) return escalate("sensitive");
	if (riskyReason(command)) return escalate("irreversible");
	// Lista vazia de propósito: a padrão libera `pnpm install`/`git commit`, que executam código do repositório.
	// Aqui todo trecho precisa ser só leitura (modo "allowlist" sem prefixos extras).
	const decision = decideCommand({ cmd: command, mode: "allowlist", allowlist: [] });
	if (decision.action !== "run") return escalate(decision.reason === "hard-deny" ? "hard-deny" : "command-not-read-only");
	return { action: "approve", why: "comando de leitura" };
}

function decideMcpCard(item: BotPendingItem, mcp: GroupPendingMcp | undefined): GroupPendingDecision {
	if (item.irreversible) return escalate("irreversible");
	if (!mcp || !mcp.actionClass) return escalate("unknown");
	if (mcp.actionClass === "irreversible" || hasIrreversibleToolName(mcp.toolName)) return escalate("irreversible");
	if (mcp.actionClass !== "read" && hasSpendVerb(mcp.toolName)) return escalate("irreversible");
	if (hasOutwardVerb(mcp.toolName) || hasExternalTargetArgs(mcp.args)) return escalate("outward");
	if (containsSensitive(mcp.args)) return escalate("sensitive");
	if (mcp.jevReview) return escalate("external-instruction");
	if (mcp.actionClass === "read") return { action: "approve", why: "leitura" };
	// Escrita reversível: só em conector que o dono liberou (`confirmWrites` desligado) e sem conteúdo de fora no contexto.
	if (mcp.confirmWrites !== false) return escalate("confirm-writes");
	if (mcp.untrustedSeen) return escalate("external-instruction");
	return { action: "approve", why: "escrita reversível" };
}

/**
 * Cartão de um membro do grupo → aceitar ou escalar ao usuário. Aprova só:
 *  - conector de leitura (sem verbo que atinge terceiros);
 *  - conector de escrita reversível, sem verbo de saída/destinatário/URL, sem segredo, em conector com
 *    `confirmWrites` desligado e sem conteúdo de fora lido;
 *  - comando em que todo trecho é só leitura (ls, cat, git status…).
 * Sempre escala: questionário, login/captcha/conector/perfil, irreversível, saída (enviar, publicar, pagar,
 * apagar), `confirmWrites`, dado sensível, escrita de arquivo, origem sem pessoa, o próprio principal e o teto.
 */
export function decideGroupPending(input: GroupPendingInput): GroupPendingDecision {
	if (input.requesterIsPrimary) return escalate("self-request");
	if (!input.origin || !ATTENDED_ORIGINS.has(input.origin)) return escalate("unattended");
	if (input.autoCount >= GROUP_PENDING_MAX_AUTO) return escalate("limit");
	const { item } = input;
	if (!item) return escalate("not-decidable");
	if (item.kind === "questionnaire") return escalate("questionnaire");
	if (input.need.type !== "confirm") return escalate("not-decidable");
	if (item.kind === "command") return decideCommandCard(item);
	if (item.kind === "mcp") return decideMcpCard(item, input.mcp);
	if (item.kind === "write") return escalate("file-write");
	return escalate("not-decidable");
}
