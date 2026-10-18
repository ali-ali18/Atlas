import { ATTACHMENT_LIMITS, attachmentKindOf, serializeConversationCard, parseConversationCard, type AttachmentKind, type PersistedFileCard } from "@workspace/shared";
import { prisma } from "./client.js";
import { ownerIds } from "./mcp-connections.js";

/**
 * Anexos de arquivo do usuário: artefatos `kind: "file"` com `meta.origin === "user"`
 * (os arquivos que o agente gera não têm essa marca). Todo acesso confere o dono.
 */

export type UserFileMeta = {
	artifactId: string;
	filename: string;
	mime: string;
	size: number;
	kind: AttachmentKind;
};

function metaOf(raw: unknown): Record<string, unknown> {
	return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function toFileMeta(row: { id: string; metaJson: unknown }): UserFileMeta | null {
	const meta = metaOf(row.metaJson);
	if (meta.origin !== "user") return null;
	const filename = typeof meta.filename === "string" && meta.filename.trim() ? meta.filename : `${row.id}.bin`;
	const mime = typeof meta.mime === "string" ? meta.mime : "application/octet-stream";
	return { artifactId: row.id, filename, mime, size: typeof meta.size === "number" ? meta.size : 0, kind: attachmentKindOf(filename, mime) };
}

/** Metadados (sem ler o arquivo) de anexos do usuário que são do dono; ids de outro dono ou que não são anexo somem. */
export async function loadUserFileMetas(ids: string[], userId: string): Promise<UserFileMeta[]> {
	if (!userId || userId === "default" || ids.length === 0) return [];
	const owners = ownerIds(userId);
	const rows = await prisma.artifact.findMany({
		where: { id: { in: ids }, kind: "file", userId: { in: owners } },
		select: { id: true, metaJson: true },
	});
	const byId = new Map(rows.map((row) => [row.id, toFileMeta(row)] as const));
	return ids.map((id) => byId.get(id) ?? null).filter((item): item is UserFileMeta => item !== null);
}

/** Quais ids da lista são anexos de arquivo do dono (os demais são imagens ou inválidos). */
export async function userFileIdSet(ids: string[], userId: string): Promise<Set<string>> {
	return new Set((await loadUserFileMetas(ids, userId)).map((item) => item.artifactId));
}

/**
 * Cartões dos arquivos da mensagem (um por arquivo), na ordem enviada. Lança se algum id
 * listado como arquivo não for do dono ou se passar de 5 arquivos.
 */
export async function resolveUserFileCards(attachments: Array<{ artifactId: string }>, userId: string): Promise<PersistedFileCard[]> {
	const ids = attachments.map((item) => item.artifactId);
	const files = await loadUserFileMetas(ids, userId);
	if (files.length > ATTACHMENT_LIMITS.maxPerMessage) throw new Error("anexos demais");
	return files.map((file) => ({
		v: 1,
		kind: "file",
		artifactId: file.artifactId,
		filename: file.filename.slice(0, 120),
		mime: file.mime.slice(0, 120),
		size: file.size,
		format: file.kind === "pdf" ? "pdf" : file.kind === "docx" ? "docx" : file.kind === "xlsx" ? "xlsx" : "text",
		version: 1,
		origin: "user",
	}));
}

export function userFileCardContent(card: PersistedFileCard): string {
	return serializeConversationCard(card);
}

/**
 * Anexos de arquivo que o usuário enviou nesta conversa (turnos anteriores incluídos), só os do dono,
 * do mais antigo ao mais novo. Conversa alheia devolve vazio.
 */
export async function loadUserFileHistory(conversationId: string, userId: string, limit = 80): Promise<UserFileMeta[]> {
	if (!conversationId || !userId || userId === "default") return [];
	const owners = ownerIds(userId);
	const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, userId: { in: owners } }, select: { id: true } });
	if (!conversation) return [];
	const rows = await prisma.conversationMessage.findMany({
		where: { conversationId, role: "file" },
		orderBy: { createdAt: "desc" },
		take: limit,
		select: { content: true },
	});
	const ids: string[] = [];
	for (const row of rows.reverse()) {
		const card = parseConversationCard(row.content);
		if (card?.kind === "file" && card.origin === "user" && !ids.includes(card.artifactId)) ids.push(card.artifactId);
	}
	return loadUserFileMetas(ids, userId);
}
