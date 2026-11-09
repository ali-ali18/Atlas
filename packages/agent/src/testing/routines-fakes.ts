// Fake da porta `Routines` para teste: linhas por DONO (outro dono não lista, não muda e não apaga), com a mesma semântica do
// adaptador do worker (`null` = não existe ou é de outro dono) e o registro do que foi mudado.
import type { RoutineGroupView, RoutineView, Routines } from "../ports/routines.js";

export type FakeRoutineRow = RoutineView & { owner: string; groupId?: string };
export type FakeGroupRow = { owner: string; id: string; name: string };

export class FakeRoutines implements Routines {
	readonly calls: Array<{ method: string; userId: string; args: unknown[] }> = [];
	constructor(
		readonly rows: FakeRoutineRow[] = [],
		readonly groupRows: FakeGroupRow[] = [],
	) {}

	private log(method: string, userId: string, ...args: unknown[]) {
		this.calls.push({ method, userId, args });
	}
	private mine(userId: string) {
		return this.rows.filter((r) => r.owner === userId);
	}
	private view(row: FakeRoutineRow): RoutineView {
		const { owner: _owner, groupId: _groupId, ...view } = row;
		const group = this.groupRows.find((g) => g.id === row.groupId);
		return { ...view, ...(group && { group: group.name }) };
	}
	private groupView(userId: string, g: FakeGroupRow): RoutineGroupView {
		const inside = this.mine(userId).filter((r) => r.groupId === g.id);
		return { id: g.id, name: g.name, routineCount: inside.length, enabledCount: inside.filter((r) => r.enabled).length };
	}

	async list(userId: string) {
		this.log("list", userId);
		return this.mine(userId).map((r) => this.view(r));
	}
	async groups(userId: string) {
		this.log("groups", userId);
		return this.groupRows.filter((g) => g.owner === userId).map((g) => this.groupView(userId, g));
	}
	async setEnabled(userId: string, routineId: string, enabled: boolean) {
		this.log("setEnabled", userId, routineId, enabled);
		const row = this.mine(userId).find((r) => r.id === routineId);
		if (!row) return null;
		row.enabled = enabled;
		return this.view(row);
	}
	async remove(userId: string, routineId: string) {
		this.log("remove", userId, routineId);
		const index = this.rows.findIndex((r) => r.owner === userId && r.id === routineId);
		if (index < 0) return null;
		const [row] = this.rows.splice(index, 1);
		return this.view(row!);
	}
	async createGroup(userId: string, name: string) {
		this.log("createGroup", userId, name);
		if (this.groupRows.some((g) => g.owner === userId && g.name.toLowerCase() === name.trim().toLowerCase())) throw new Error("Já existe um grupo com esse nome");
		const group = { owner: userId, id: `grp-${this.groupRows.length + 1}`, name: name.trim() };
		this.groupRows.push(group);
		return this.groupView(userId, group);
	}
	async renameGroup(userId: string, groupId: string, name: string) {
		this.log("renameGroup", userId, groupId, name);
		const group = this.groupRows.find((g) => g.owner === userId && g.id === groupId);
		if (!group) return null;
		if (this.groupRows.some((g) => g.owner === userId && g.id !== groupId && g.name.toLowerCase() === name.trim().toLowerCase())) throw new Error("Já existe um grupo com esse nome");
		group.name = name.trim();
		return this.groupView(userId, group);
	}
	async deleteGroup(userId: string, groupId: string) {
		this.log("deleteGroup", userId, groupId);
		const index = this.groupRows.findIndex((g) => g.owner === userId && g.id === groupId);
		if (index < 0) return null;
		const [group] = this.groupRows.splice(index, 1);
		const inside = this.mine(userId).filter((r) => r.groupId === groupId);
		for (const r of inside) delete r.groupId;
		return { name: group!.name, routines: inside.length };
	}
	async setGroupEnabled(userId: string, groupId: string, enabled: boolean) {
		this.log("setGroupEnabled", userId, groupId, enabled);
		const group = this.groupRows.find((g) => g.owner === userId && g.id === groupId);
		if (!group) return null;
		const inside = this.mine(userId).filter((r) => r.groupId === groupId);
		const changing = inside.filter((r) => r.enabled !== enabled);
		for (const r of changing) r.enabled = enabled;
		return { name: group.name, total: inside.length, changed: changing.length };
	}
	async moveToGroup(userId: string, routineId: string, groupId: string | null) {
		this.log("moveToGroup", userId, routineId, groupId);
		const row = this.mine(userId).find((r) => r.id === routineId);
		if (!row) return null;
		if (groupId !== null) {
			if (!this.groupRows.some((g) => g.owner === userId && g.id === groupId)) return null;
			row.groupId = groupId;
		} else {
			delete row.groupId;
		}
		return this.view(row);
	}
}

export const sampleRoutines = (): FakeRoutineRow[] => [
	{ owner: "owner-1", id: "r1", name: "Resumo da manhã", trigger: "todo dia às 8h", kind: "cron", enabled: true, task: "Resume os e-mails importantes.", lastRunAt: "2026-11-08T11:00:00.000Z", lastStatus: "succeeded" },
	{ owner: "owner-1", id: "r2", name: "Alerta do estoque", trigger: "A cada 2 h", kind: "interval", enabled: true, alert: "Alerta · confere a cada 2 horas · avisa se o estoque cair de 10", task: "Confere o estoque.", nextRunAt: "2026-11-09T16:00:00.000Z" },
	{ owner: "owner-1", id: "r3", name: "Lembrar do aluguel", trigger: "Uma vez · 03/12 às 10:00", kind: "once", enabled: false, task: "Avisa do aluguel.", groupId: "g1" },
	{ owner: "owner-2", id: "rb1", name: "Rotina secreta do B", trigger: "todo dia às 9h", kind: "cron", enabled: true, task: "Faz algo do B." },
];
