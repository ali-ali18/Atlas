import type { PlanInfo } from "@workspace/shared";
import { prisma } from "./client.js";

export type SkillPendingKind = "need-name" | "pick-skill" | "confirm";
export type SkillPendingAction = "dev-pr-create" | "request-secrets" | "dev-command" | "rename" | "edit" | "show" | "delete" | "delete-all" | "clean-drafts" | "mcp-call" | "generate-image" | "set-primary-bot" | "vault-use" | "email-send" | "email-key" | "email-create-mailbox" | "plan" | "infra-setup";
export type SkillPendingCandidate = { skillId: string; capabilityKey: string; title: string };
/** Chamada de conector MCP que escreve dados, aguardando o "confirmado". */
export type SkillPendingMcpCall = {
	connectionId: string;
	connectorName: string;
	/** Nome original da tool no servidor MCP. */
	toolName: string;
	/** Nome exposto ao modelo (`mcp__<slug>__<tool>`). */
	exposedName: string;
	/** Classe da ação: só `write` aceita "Não perguntar mais para isto". */
	actionClass?: "write" | "irreversible";
	args: Record<string, unknown>;
	/** Confirmação exigida pelo avaliador Jev, sem opção de exceção permanente. */
	jevReview?: boolean;
	/** Por que o Jev pediu o cartão: `external_instruction` nunca ganha "Sempre para…" nem aprovação por tarefa. */
	jevReviewReason?: "external_instruction" | "alignment" | "unavailable";
	/** O run já tinha lido conteúdo que o usuário não escreveu quando o cartão foi criado: aprovar não concede a tarefa. */
	untrustedSeen?: boolean;
	/** Run que pediu a aprovação: o run seguinte continua a conversa dele. */
	runId?: string;
};
export type SkillPendingPayload = {
	kind: SkillPendingKind;
	action: SkillPendingAction;
	skillId?: string;
	capabilityKey?: string;
	title?: string;
	candidates?: SkillPendingCandidate[];
	spec?: string;
	newName?: string;
	draftCount?: number;
	skillCount?: number;
	confirmId?: string;
	botId?: string;
	mcpCall?: SkillPendingMcpCall;
	primaryBot?: { botId: string; name: string };
	/** E-mail do bot aguardando o "confirmado" (corpo completo: só o dono vê no cartão). */
	/** Criar a caixa de e-mail do bot (sempre confirmada): o nome já foi escolhido, o cartão mostra o endereço. */
	emailCreate?: { mailboxName: string; /** Domínio próprio verificado escolhido; ausente = domínio padrão do provedor. */ domain?: string };
	emailSend?: { mailboxId: string; to: string; subject: string; body: string; bodyHtml?: string; threadId?: string };
	imageGeneration?: { prompt: string; aspectRatio?: string; n: number; runId: string };
	/** Criação de PR de sessão de código aguardando o "confirmado" (o agente repete a chamada depois). */
	/** Comando (ou escrita) de sessão de código aguardando aprovação; o agente repete a chamada depois. */
	devCommand?: { callKey: string; sessionId: string; repo: string | null; tool: "shell" | "write_file" | "edit_file" | "read_file" | "repeat_call"; label: string; prefixes: string[] };
	devPrCreate?: { callKey: string; sessionId: string; title: string; base: string; head: string };
	/** Pedido de segredos do projeto: só nomes e o ambiente; os valores vão do cartão direto para a API. */
	secretsRequest?: { environmentId: string; repo: string; names: string[] };
	/** Escrita de infraestrutura da prévia completa (DNS) aguardando o "confirmado"; o agente repete a chamada depois. Nenhum segredo aqui. */
	infraSetup?: { callKey: string; label: string };
	/** Plano proposto (`propose_plan`) aguardando "Aprovar plano"; aprovar não aprova escritas. */
	plan?: PlanInfo;
	/** Uso de um login do Cofre pelo bot (aprovação por conversa); nenhum valor aqui. */
	vaultUse?: { secretId: string; name: string; label: string; domain: string };
};

export type SkillPendingIntent = {
	id: string;
	userId: string;
	conversationId: string;
	kind: SkillPendingKind;
	payload: SkillPendingPayload;
	expiresAt: Date;
};

const PENDING_TTL_MS = 10 * 60 * 1000;
/** Aprovação de comando/escrita: o usuário pode voltar ao app horas depois (os 10 min comuns deixavam o cartão sem intenção). */
export const DEV_APPROVAL_TTL_MS = 2 * 60 * 60 * 1000;

function toIntent(row: { id: string; userId: string; conversationId: string; kind: string; payload: unknown; expiresAt: Date }): SkillPendingIntent | null {
	if (row.kind !== "need-name" && row.kind !== "pick-skill" && row.kind !== "confirm") return null;
	const payload = row.payload as SkillPendingPayload | null;
	if (!payload || typeof payload !== "object") return null;
	return { id: row.id, userId: row.userId, conversationId: row.conversationId, kind: row.kind, payload, expiresAt: row.expiresAt };
}

export async function saveSkillPendingIntent(input: {
	userId: string;
	conversationId: string;
	payload: SkillPendingPayload;
	ttlMs?: number;
}): Promise<void> {
	const expiresAt = new Date(Date.now() + (input.ttlMs ?? PENDING_TTL_MS));
	await prisma.skillPendingIntent.upsert({
		where: { conversationId: input.conversationId },
		create: { userId: input.userId, conversationId: input.conversationId, kind: input.payload.kind, payload: JSON.parse(JSON.stringify(input.payload)), expiresAt },
		update: { userId: input.userId, kind: input.payload.kind, payload: JSON.parse(JSON.stringify(input.payload)), expiresAt },
	});
}

export async function getSkillPendingIntent(userId: string, conversationId: string): Promise<SkillPendingIntent | null> {
	const row = await prisma.skillPendingIntent.findUnique({ where: { conversationId } }).catch(() => null);
	if (!row || row.userId !== userId) return null;
	if (row.expiresAt.getTime() <= Date.now()) {
		await prisma.skillPendingIntent.deleteMany({ where: { conversationId } }).catch(() => undefined);
		return null;
	}
	return toIntent(row as { id: string; userId: string; conversationId: string; kind: string; payload: unknown; expiresAt: Date });
}

export async function clearSkillPendingIntent(userId: string, conversationId: string): Promise<void> {
	await prisma.skillPendingIntent.deleteMany({ where: { conversationId, userId } }).catch(() => undefined);
}

/** Reserva uma confirmação paga uma única vez, mesmo com dois cliques simultâneos. */
export async function claimSkillPendingIntent(id: string, userId: string, conversationId: string): Promise<boolean> {
	const claimed = await prisma.skillPendingIntent.deleteMany({
		where: { id, userId, conversationId, expiresAt: { gt: new Date() } },
	});
	return claimed.count === 1;
}
