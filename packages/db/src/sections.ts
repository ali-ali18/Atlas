import { Prisma } from "@prisma/client";
import type {
	CreateSectionInput,
	Section,
	UpdateSectionInput,
} from "@workspace/shared";
import { prisma } from "./client.js";

type SectionRow = Prisma.SectionGetPayload<Record<string, never>>;

function toSection(row: SectionRow): Section {
	return {
		id: row.id,
		name: row.name,
		order: row.order,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

export async function listSections(_ownerId?: string): Promise<Section[]> {
	// Conta única: sem filtro por enquanto — lista tudo (inclui legado sem dono).
	// O vínculo ao dono acontece depois via backfill claim-default.
	const rows = await prisma.section.findMany({
		orderBy: [{ order: "asc" }, { createdAt: "asc" }],
	});
	return rows.map(toSection);
}

export async function createSection(input: CreateSectionInput, ownerId?: string): Promise<Section> {
	const maxOrder = await prisma.section.aggregate({
		_max: { order: true },
	});
	const row = await prisma.section.create({
		data: {
			name: input.name,
			order: (maxOrder._max.order ?? -1) + 1,
			...(ownerId ? { ownerId } : {}),
		},
	});
	return toSection(row);
}

export async function updateSection(
	id: string,
	patch: UpdateSectionInput,
	ownerId?: string,
): Promise<Section> {
	try {
		if (ownerId) {
			const owned = await prisma.section.findUnique({
				where: { id },
				select: { id: true, ownerId: true },
			});
			// Legado sem dono continua editável; com dono, só o dono.
			if (!owned || (owned.ownerId && owned.ownerId !== ownerId)) {
				throw new Error("Section not found");
			}
		}
		const data: Prisma.SectionUpdateInput = {};
		if (patch.name !== undefined) data.name = patch.name;
		if (patch.order !== undefined) data.order = patch.order;
		const row = await prisma.section.update({ where: { id }, data });
		return toSection(row);
	} catch (error) {
		if (error instanceof Error && error.message === "Section not found") throw error;
		if ((error as { code?: string }).code === "P2025") {
			throw new Error("Section not found");
		}
		throw error;
	}
}

export async function deleteSection(id: string, ownerId?: string): Promise<void> {
	try {
		if (ownerId) {
			const owned = await prisma.section.findUnique({
				where: { id },
				select: { id: true, ownerId: true },
			});
			// Legado sem dono continua apagável; com dono, só o dono.
			if (!owned || (owned.ownerId && owned.ownerId !== ownerId)) {
				throw new Error("Section not found");
			}
		}
		// Bots voltam para "Sem sessão" (onDelete: SetNull no schema).
		await prisma.section.delete({ where: { id } });
	} catch (error) {
		if (error instanceof Error && error.message === "Section not found") throw error;
		if ((error as { code?: string }).code === "P2025") {
			throw new Error("Section not found");
		}
		throw error;
	}
}
