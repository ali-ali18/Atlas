import { applyMaintenanceResult, friendlyMaintenanceError, parseMaintenanceStatus, type MaintenanceJobKind, type MaintenanceStatusStore } from "@workspace/shared";
import { prisma } from "./client.js";

export async function getMaintenanceStatus(userId: string): Promise<MaintenanceStatusStore> {
	const row = await prisma.userSettings.findUnique({ where: { userId }, select: { maintenanceStatusJson: true } });
	return parseMaintenanceStatus(row?.maintenanceStatusJson);
}

/** Grava o último sucesso ou erro de uma tarefa. Nunca lança: diagnóstico não pode derrubar o job. */
export async function recordMaintenanceResult(
	userId: string,
	kind: MaintenanceJobKind,
	outcome: { ok: true } | { ok: false; error: unknown },
	now: Date = new Date(),
): Promise<void> {
	try {
		const current = await getMaintenanceStatus(userId);
		const next = applyMaintenanceResult(current, kind, outcome.ok ? { ok: true, at: now } : { ok: false, at: now, message: friendlyMaintenanceError(outcome.error) });
		await prisma.userSettings.upsert({ where: { userId }, create: { userId, maintenanceStatusJson: next }, update: { maintenanceStatusJson: next } });
	} catch (error) {
		console.error("record maintenance status failed", error instanceof Error ? error.name : "unknown");
	}
}
