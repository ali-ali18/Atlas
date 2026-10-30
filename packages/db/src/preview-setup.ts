import { parsePreviewSetupState, type PreviewSetupState } from "@workspace/shared";
import { prisma } from "./client.js";

/**
 * Estado da configuração da prévia completa (um por dono). Toda leitura e escrita filtra pelo `userId`
 * da sessão do run; o estado não guarda segredo (tokens ficam no cofre).
 */

export type PreviewSetupLoad = { kind: "none" } | { kind: "ok"; state: PreviewSetupState } | { kind: "corrupt" };

/** Distingue "não há setup" de "há um registro que não dá para ler" (não sobrescrever às cegas). */
export async function loadPreviewSetup(userId: string): Promise<PreviewSetupLoad> {
	const row = await prisma.previewSetup.findUnique({ where: { userId } });
	if (!row) return { kind: "none" };
	const state = parsePreviewSetupState(row.state);
	return state ? { kind: "ok", state } : { kind: "corrupt" };
}

export async function getPreviewSetup(userId: string): Promise<PreviewSetupState | null> {
	const loaded = await loadPreviewSetup(userId);
	return loaded.kind === "ok" ? loaded.state : null;
}

export async function savePreviewSetup(userId: string, state: PreviewSetupState): Promise<void> {
	const json = JSON.parse(JSON.stringify(state));
	await prisma.previewSetup.upsert({ where: { userId }, create: { userId, state: json }, update: { state: json } });
}

export async function deletePreviewSetup(userId: string): Promise<void> {
	await prisma.previewSetup.deleteMany({ where: { userId } });
}

/** O usuário é o administrador do servidor (`ATLAS_OWNER_EMAIL`)? Sem a variável, ninguém é. */
export async function isOwnerUserId(userId: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
	const ownerEmail = env.ATLAS_OWNER_EMAIL?.trim().toLowerCase();
	if (!ownerEmail || !userId) return false;
	const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
	return user?.email.toLowerCase() === ownerEmail;
}
