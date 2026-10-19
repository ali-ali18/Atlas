import type { Message } from "@/components/ui/templates/template-4/data";
import { isCardProtocolText } from "@/lib/card-decision";

type ConfirmMessage = Extract<Message, { kind: "confirm" }>;
type NeedsUserMessage = Extract<Message, { kind: "needs-user" }>;

/** Um pedido de aprovação que pode viver no dock: local (comando/escrita/MCP) ou repassado de outro bot. */
export type DockEntry = { id: string; type: "confirm"; message: ConfirmMessage } | { id: string; type: "relayed"; message: NeedsUserMessage };

export type ApprovalMarkerStatus = "pending" | "approved" | "rejected" | "skipped" | "expired" | "resolved";

const SHORT_MAX = 60;

function shorten(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > SHORT_MAX ? `${line.slice(0, SHORT_MAX - 1).trimEnd()}…` : line;
}

/** Cartão de aprovação local que vai para o dock (o pedido de segredos é um formulário e continua na conversa). */
function isDockConfirm(message: Message): message is ConfirmMessage {
	return message.kind === "confirm" && !message.secretsRequest && !message.emailKeyRequest;
}

/** Cartão repassado de outro bot que o usuário pode decidir daqui (questionário e logins ficam na conversa). */
export function isDockRelayed(message: Message): message is NeedsUserMessage {
	if (message.kind !== "needs-user") return false;
	const kind = message.need.item?.kind;
	return kind === "command" || kind === "write" || kind === "mcp";
}

/** Comando curto (ou arquivo, ou título) para o marcador. */
export function approvalShortLabel(message: ConfirmMessage | NeedsUserMessage): string {
	if (message.kind === "needs-user") {
		const info = message.need.item?.devApproval;
		if (info) return shorten(info.kind === "command" ? info.command : info.path);
		return shorten(message.need.item?.title ?? message.title);
	}
	const info = message.devApproval;
	if (info) return shorten(info.kind === "command" ? info.command : info.path);
	return shorten(message.title);
}

/**
 * Pedidos acionáveis agora, do mais antigo ao mais recente (o dock mostra o último).
 * O servidor guarda uma única intenção pendente por conversa: só o confirm local MAIS RECENTE
 * conta (os anteriores ainda "pendentes" estão expirados). Cartões repassados de outros bots
 * são independentes: cada um pendente é acionável.
 */
export function selectDockEntries(messages: Message[]): DockEntry[] {
	const entries: DockEntry[] = [];
	let lastConfirmIndex = -1;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (isDockConfirm(messages[index]!)) {
			lastConfirmIndex = index;
			break;
		}
	}
	const relayedSeen = new Set<string>();
	messages.forEach((message, index) => {
		if (index === lastConfirmIndex && isDockConfirm(message) && (message.status ?? "pending") === "pending") {
			entries.push({ id: message.id, type: "confirm", message });
		} else if (isDockRelayed(message) && message.status === "pending" && !relayedSeen.has(message.need.cardId)) {
			relayedSeen.add(message.need.cardId);
			entries.push({ id: message.id, type: "relayed", message });
		}
	});
	return entries;
}

export type ApprovalMarker = { status: ApprovalMarkerStatus; label: string; short: string };

const STATUS_WORD: Record<ApprovalMarkerStatus, string> = {
	pending: "Aguardando aprovação",
	approved: "Aprovado",
	rejected: "Recusado",
	skipped: "Pulado",
	expired: "Expirado",
	resolved: "Respondido",
};

export function approvalMarkerText(status: ApprovalMarkerStatus, short: string): string {
	return `${STATUS_WORD[status]} · ${short}`;
}

/** Recusa sem comentário ("cancela isso") = pulou; "recusado: …" = recusou. Olha a primeira decisão que vem depois do cartão. */
function skippedBy(following: readonly Message[]): boolean {
	for (const next of following) {
		if (next.kind !== "user" || !isCardProtocolText(next.text)) continue;
		return /^cancela isso$/i.test(next.text.trim());
	}
	return false;
}

/** Marcador da conversa para um cartão de aprovação; `null` se a mensagem não é um (segue inline). */
export function approvalMarkerFor(message: Message, activeIds: ReadonlySet<string>, following: readonly Message[] = []): ApprovalMarker | null {
	let status: ApprovalMarkerStatus;
	if (isDockConfirm(message)) {
		const base = message.status ?? "pending";
		status = base === "pending" ? (activeIds.has(message.id) ? "pending" : "expired") : base === "rejected" && message.superseded ? "expired" : base === "rejected" ? (skippedBy(following) ? "skipped" : "rejected") : base;
	} else if (isDockRelayed(message)) {
		status = message.status === "pending" ? (activeIds.has(message.id) ? "pending" : "expired") : "resolved";
	} else {
		return null;
	}
	const short = approvalShortLabel(message as ConfirmMessage | NeedsUserMessage);
	return { status, short, label: approvalMarkerText(status, short) };
}

/** "confirmado: …", "confirmado sempre: …", "recusado: …", "cancela isso": texto de protocolo, não fala do usuário. */
export function isHiddenProtocolBubble(message: Message): boolean {
	return message.kind === "user" && isCardProtocolText(message.text);
}

/** Camadas que espiam atrás da linha da frente quando há 2 ou mais pedidos. */
export const APPROVAL_STACK_PEEKS = 2;

/** Prefixos que "Sempre neste repositório" liberaria (só cartões locais de comando; cartões repassados de outro bot não têm essa ação). */
export function dockEntryPrefixes(entry: DockEntry): string[] {
	if (entry.type !== "confirm") return [];
	const info = entry.message.devApproval;
	return info?.kind === "command" ? [...(info.prefixes ?? [])] : [];
}

/** Texto da linha da barra: "Executar · pnpm test", "Editar · src/x.ts", "Dev: Executar · …" (cartão de outro bot). */
export function approvalBarLabel(entry: DockEntry): string {
	const info = entry.type === "confirm" ? entry.message.devApproval : entry.message.need.item?.devApproval;
	const short = approvalShortLabel(entry.message);
	const text = info ? `${info.kind === "command" ? "Executar" : "Editar"} · ${short}` : short;
	return entry.type === "relayed" ? `${entry.message.botName}: ${text}` : text;
}
