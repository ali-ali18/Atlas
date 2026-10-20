import type { RoutineGroupRecord, RoutineRecord } from "@workspace/shared";
import { prisma } from "./client.js";
import { ownerIds } from "./mcp-connections.js";

const LEGACY_OWNER_ID = "default";
const MAX_NAME = 80;
const MAX_DESCRIPTION = 500;

/** Chave de comparação: sem diferença de caixa nem de espaços repetidos/nas pontas. */
export function normalizeRoutineGroupName(name: string): string {
	return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function cleanName(name: string): string {
	const cleaned = name.trim().replace(/\s+/g, " ").slice(0, MAX_NAME);
	if (!cleaned) throw new Error("Nome do grupo obrigatório");
	return cleaned;
}

function cleanDescription(value: string): string {
	return value.trim().slice(0, MAX_DESCRIPTION);
}

function validUser(userId: string | undefined): string | null {
	return userId?.trim() && userId !== LEGACY_OWNER_ID ? userId.trim() : null;
}

type GroupRow = {
	id: string;
	botId: string;
	name: string;
	description: string;
	createdAt: Date;
	updatedAt: Date;
	routines?: Array<{ enabled: boolean }>;
};

function toGroup(row: GroupRow): RoutineGroupRecord {
	const routines = row.routines ?? [];
	return {
		id: row.id,
		botId: row.botId,
		name: row.name,
		description: row.description,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		routineCount: routines.length,
		enabledCount: routines.filter((routine) => routine.enabled).length,
	};
}

/** Garante que o grupo é do mesmo usuário e bot. Lança "Grupo não encontrado" caso contrário. */
export async function assertGroupUsable(
	userId: string | undefined,
	botId: string,
	groupId: string,
): Promise<string> {
	const found = await prisma.routineGroup.findFirst({
		where: { id: groupId, botId, userId: { in: ownerIds(userId) } },
		select: { id: true },
	});
	if (!found) throw new Error("Grupo não encontrado");
	return found.id;
}

export async function listRoutineGroups(
	userId: string | undefined,
	botId: string,
): Promise<RoutineGroupRecord[]> {
	const rows = await prisma.routineGroup.findMany({
		where: { botId, userId: { in: ownerIds(userId) } },
		include: { routines: { select: { enabled: true } } },
		orderBy: { createdAt: "asc" },
	});
	return rows.map(toGroup);
}

async function findByName(userId: string, botId: string, name: string) {
	const key = normalizeRoutineGroupName(name);
	const rows = await prisma.routineGroup.findMany({
		where: { botId, userId },
		include: { routines: { select: { enabled: true } } },
	});
	return rows.find((row) => normalizeRoutineGroupName(row.name) === key) ?? null;
}

async function assertBotOwned(userId: string, botId: string): Promise<void> {
	const bot = await prisma.bot.findFirst({
		where: { id: botId, ownerId: userId },
		select: { id: true },
	});
	if (!bot) throw new Error("Bot não encontrado");
}

export async function createRoutineGroup(
	userId: string | undefined,
	botId: string,
	input: { name: string; description?: string },
): Promise<RoutineGroupRecord> {
	const uid = validUser(userId);
	if (!uid) throw new Error("Bot não encontrado");
	await assertBotOwned(uid, botId);
	const name = cleanName(input.name);
	if (await findByName(uid, botId, name)) throw new Error("Já existe um grupo com esse nome");
	const row = await prisma.routineGroup.create({
		data: { userId: uid, botId, name, description: cleanDescription(input.description ?? "") },
	});
	return toGroup(row);
}

/** Reaproveita o grupo de mesmo nome (sem caixa/espaços) ou cria um novo. */
export async function findOrCreateRoutineGroup(
	userId: string | undefined,
	botId: string,
	name: string,
): Promise<{ group: RoutineGroupRecord; created: boolean }> {
	const uid = validUser(userId);
	if (!uid) throw new Error("Bot não encontrado");
	await assertBotOwned(uid, botId);
	const clean = cleanName(name);
	const existing = await findByName(uid, botId, clean);
	if (existing) return { group: toGroup(existing), created: false };
	const row = await prisma.routineGroup.create({
		data: { userId: uid, botId, name: clean, description: "" },
	});
	return { group: toGroup(row), created: true };
}

export async function updateRoutineGroup(
	userId: string | undefined,
	botId: string,
	groupId: string,
	input: { name?: string; description?: string },
): Promise<RoutineGroupRecord | null> {
	const uid = validUser(userId);
	if (!uid) return null;
	const existing = await prisma.routineGroup.findFirst({
		where: { id: groupId, botId, userId: uid },
		select: { id: true },
	});
	if (!existing) return null;
	const data: { name?: string; description?: string } = {};
	if (input.name !== undefined) {
		const name = cleanName(input.name);
		const clash = await findByName(uid, botId, name);
		if (clash && clash.id !== groupId) throw new Error("Já existe um grupo com esse nome");
		data.name = name;
	}
	if (input.description !== undefined) data.description = cleanDescription(input.description);
	const row = await prisma.routineGroup.update({
		where: { id: groupId },
		data,
		include: { routines: { select: { enabled: true } } },
	});
	return toGroup(row);
}

/**
 * Liga/desliga todas as rotinas do grupo. Devolve as rotinas já atualizadas
 * (para o chamador sincronizar scheduler/GitHub). Cron sem schedule não
 * pode ser ativada e é pulada.
 */
export async function setRoutineGroupEnabled(
	userId: string | undefined,
	botId: string,
	groupId: string,
	enabled: boolean,
): Promise<RoutineRecord[] | null> {
	const uid = validUser(userId);
	if (!uid) return null;
	const group = await prisma.routineGroup.findFirst({
		where: { id: groupId, botId, userId: uid },
		select: { id: true },
	});
	if (!group) return null;
	const { updateRoutine, listRoutines } = await import("./routines.js");
	const rows = (await listRoutines(uid, botId)).filter((routine) => routine.groupId === groupId);
	const updated: RoutineRecord[] = [];
	for (const routine of rows) {
		if (routine.enabled === enabled) {
			updated.push(routine);
			continue;
		}
		if (enabled && routine.triggerType === "cron" && !routine.schedule) {
			updated.push(routine);
			continue;
		}
		const next = await updateRoutine(uid, botId, routine.id, { enabled });
		if (next) updated.push(next);
	}
	return updated;
}

/**
 * Apaga o grupo. Por padrão as rotinas ficam sem grupo; com `deleteRoutines`
 * elas também são apagadas. Devolve as rotinas afetadas (estado anterior)
 * para o chamador limpar scheduler/GitHub das apagadas.
 */
export async function deleteRoutineGroup(
	userId: string | undefined,
	botId: string,
	groupId: string,
	opts: { deleteRoutines?: boolean } = {},
): Promise<{ routines: RoutineRecord[]; deletedRoutines: boolean } | null> {
	const uid = validUser(userId);
	if (!uid) return null;
	const group = await prisma.routineGroup.findFirst({
		where: { id: groupId, botId, userId: uid },
		select: { id: true },
	});
	if (!group) return null;
	const { listRoutines } = await import("./routines.js");
	const routines = (await listRoutines(uid, botId)).filter((routine) => routine.groupId === groupId);
	const deleteRoutines = opts.deleteRoutines === true;
	if (deleteRoutines) {
		await prisma.routine.deleteMany({ where: { groupId, botId, userId: uid } });
	}
	await prisma.routineGroup.deleteMany({ where: { id: groupId, botId, userId: uid } });
	return { routines, deletedRoutines: deleteRoutines };
}
