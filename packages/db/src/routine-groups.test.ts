import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeRoutineGroupName } from "./routine-groups.js";

describe("normalizeRoutineGroupName", () => {
	it("ignora caixa e espaços repetidos/nas pontas", () => {
		assert.equal(normalizeRoutineGroupName("  Relatório   Diário "), "relatório diário");
	});
});

describe("grupos de rotinas por dono", () => {
	it("findOrCreateRoutineGroup reaproveita grupo com o mesmo nome e só cria quando não existe", async () => {
		const { prisma } = await import("./client.js");
		const { findOrCreateRoutineGroup } = await import("./routine-groups.js");
		const botFind = prisma.bot.findFirst;
		const many = prisma.routineGroup.findMany;
		const create = prisma.routineGroup.create;
		let creates = 0;
		prisma.bot.findFirst = (async () => ({ id: "bot-1" })) as unknown as typeof prisma.bot.findFirst;
		prisma.routineGroup.findMany = (async () => [
			{ id: "g1", botId: "bot-1", name: "Vendas", description: "", createdAt: new Date(0), updatedAt: new Date(0), routines: [] },
		]) as unknown as typeof prisma.routineGroup.findMany;
		prisma.routineGroup.create = (async ({ data }: { data: Record<string, unknown> }) => {
			creates += 1;
			return { id: "g2", createdAt: new Date(0), updatedAt: new Date(0), ...data };
		}) as unknown as typeof prisma.routineGroup.create;
		try {
			const same = await findOrCreateRoutineGroup("u1", "bot-1", " vendas ");
			assert.equal(same.group.id, "g1");
			assert.equal(same.created, false);
			assert.equal(creates, 0);
			const fresh = await findOrCreateRoutineGroup("u1", "bot-1", "Financeiro");
			assert.equal(fresh.created, true);
			assert.equal(fresh.group.name, "Financeiro");
			assert.equal(creates, 1);
		} finally {
			prisma.bot.findFirst = botFind;
			prisma.routineGroup.findMany = many;
			prisma.routineGroup.create = create;
		}
	});

	it("assertGroupUsable recusa grupo de outro usuário", async () => {
		const { prisma } = await import("./client.js");
		const { assertGroupUsable } = await import("./routine-groups.js");
		const find = prisma.routineGroup.findFirst;
		prisma.routineGroup.findFirst = (async ({ where }: { where: { userId: { in: string[] } } }) =>
			where.userId.in.includes("owner") ? { id: "g1" } : null) as unknown as typeof prisma.routineGroup.findFirst;
		try {
			assert.equal(await assertGroupUsable("owner", "bot-1", "g1"), "g1");
			await assert.rejects(() => assertGroupUsable("intruso", "bot-1", "g1"), /Grupo não encontrado/);
		} finally {
			prisma.routineGroup.findFirst = find;
		}
	});
});
