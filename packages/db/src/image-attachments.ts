import { ATTACHMENT_LIMITS, groupUserImageRows, IMAGE_LIMITS, serializeConversationCard, type HistoryImageGroup, type PersistedImagesCard } from "@workspace/shared";
import { loadArtifactForUser } from "./artifacts.js";
import { userFileIdSet } from "./file-attachments.js";
import { prisma } from "./client.js";
import { ownerIds } from "./mcp-connections.js";

export function parseImageAttachments(raw: unknown): Array<{ artifactId: string }> | null {
	if (raw === undefined) return [];
	if (!Array.isArray(raw) || raw.length > IMAGE_LIMITS.maxPerMessage + ATTACHMENT_LIMITS.maxPerMessage) return null;
	const ids = new Set<string>();
	for (const item of raw) {
		if (!item || typeof item !== "object" || typeof item.artifactId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(item.artifactId) || ids.has(item.artifactId)) return null;
		ids.add(item.artifactId);
	}
	return [...ids].map((artifactId) => ({ artifactId }));
}

/** Anexos de imagem entre os ids da mensagem (os de arquivo seguem por `resolveUserFileCards`). */
export async function imageAttachmentsOf(attachments: Array<{ artifactId: string }>, userId: string): Promise<Array<{ artifactId: string }>> {
	if (attachments.length === 0) return [];
	const files = await userFileIdSet(attachments.map((item) => item.artifactId), userId);
	return attachments.filter((item) => !files.has(item.artifactId));
}

export async function resolveUserImagesCard(all: Array<{ artifactId: string }>, userId: string): Promise<PersistedImagesCard | null> {
	const attachments = await imageAttachmentsOf(all, userId);
	if (attachments.length === 0) return null;
	if (attachments.length > IMAGE_LIMITS.maxPerMessage) throw new Error("anexo inválido");
	const items: PersistedImagesCard["items"] = [];
	for (const { artifactId } of attachments) {
		const artifact = await loadArtifactForUser(artifactId, userId);
		if (!artifact || artifact.kind !== "image" || !artifact.meta.mime.startsWith("image/")) throw new Error("anexo inválido");
		const width = artifact.meta.width;
		const height = artifact.meta.height;
		if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) throw new Error("anexo inválido");
		items.push({ artifactId, mime: artifact.meta.mime, width, height, ...(typeof artifact.meta.name === "string" ? { name: artifact.meta.name } : {}) });
	}
	return { v: 1, kind: "images", origin: "user", items };
}

export function userImagesCardContent(card: PersistedImagesCard): string {
	return serializeConversationCard(card);
}

/**
 * Imagens que o usuário anexou em turnos anteriores desta conversa, só as do dono
 * (conversa e artefato). Id de outro dono, inexistente ou que não é imagem vai
 * para `missing` em vez de virar `image_ref`. Conversa alheia devolve vazio.
 */
export async function loadUserImageHistory(conversationId: string, userId: string, limit = 60): Promise<HistoryImageGroup[]> {
	if (!conversationId || !userId) return [];
	const owners = ownerIds(userId);
	const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, userId: { in: owners } }, select: { id: true } });
	if (!conversation) return [];
	const rows = await prisma.conversationMessage.findMany({
		where: { conversationId, role: { in: ["user", "images"] } },
		orderBy: { createdAt: "desc" },
		take: limit,
		select: { role: true, content: true },
	});
	const groups = groupUserImageRows(rows.reverse());
	const ids = [...new Set(groups.flatMap((group) => group.items.map((item) => item.artifactId)))];
	if (ids.length === 0) return [];
	const owned = await prisma.artifact.findMany({
		where: { id: { in: ids }, kind: "image", OR: [{ userId: { in: owners } }, { userId: null, run: { userId: { in: owners } } }] },
		select: { id: true },
	});
	const ownedIds = new Set(owned.map((row) => row.id));
	return groups.map((group) => ({
		userText: group.userText,
		items: group.items.filter((item) => ownedIds.has(item.artifactId)),
		missing: group.items.filter((item) => !ownedIds.has(item.artifactId)).map((item) => item.name ?? "image"),
	}));
}
