// Rotinas do v4 no worker (F9, parte 1): a porta `Routines` sobre `@workspace/db` (a tabela `routines` e os grupos, as mesmas
// que a Biblioteca mostra). NÃO importa o agent-runtime: o gatilho em frase vem de `@workspace/shared`
// (`describeRoutineTrigger`), a lógica de dados, do db.
//
// Escopo: o `userId` é o do RUN (nunca do modelo) e o bot já está fixo no adaptador. Toda leitura e escrita do db filtra por
// dono e bot; rotina ou grupo de outro dono volta como "não existe" (`null`). Escrita sincroniza o agendador (`onMutated`:
// pausar/apagar tira o cron, retomar volta) e mostra o cartão da rotina no chat (o mesmo evento `routine` do legado).
import type { RoutineGroupView, RoutineView, Routines } from "@workspace/agent";
import {
	createRoutineGroup,
	deleteRoutine,
	deleteRoutineGroup,
	listRoutineGroups,
	listRoutines,
	persistConversationCardFromEvent,
	setRoutineGroupEnabled,
	updateRoutine,
	updateRoutineGroup,
} from "@workspace/db";
import { describeRoutineAlertSentence, describeRoutineTrigger, routineNextRunAt, type ComputerUseEvent, type RoutineGroupRecord, type RoutineRecord } from "@workspace/shared";

/** Funções do db e do relógio; injetáveis para o teste (sem banco). */
export type V4RoutinesDeps = {
	list: typeof listRoutines;
	update: typeof updateRoutine;
	remove: typeof deleteRoutine;
	listGroups: typeof listRoutineGroups;
	createGroup: typeof createRoutineGroup;
	updateGroup: typeof updateRoutineGroup;
	deleteGroup: typeof deleteRoutineGroup;
	setGroupEnabled: typeof setRoutineGroupEnabled;
	persistCard: (conversationId: string, event: ComputerUseEvent) => Promise<void>;
	now: () => Date;
};

export const realV4RoutinesDeps: V4RoutinesDeps = {
	list: listRoutines,
	update: updateRoutine,
	remove: deleteRoutine,
	listGroups: listRoutineGroups,
	createGroup: createRoutineGroup,
	updateGroup: updateRoutineGroup,
	deleteGroup: deleteRoutineGroup,
	setGroupEnabled: setRoutineGroupEnabled,
	persistCard: (conversationId, event) => persistConversationCardFromEvent(conversationId, event),
	now: () => new Date(),
};

export type V4RoutinesScope = {
	/** O bot do run: as rotinas e os grupos são dele. */
	botId: string;
	conversationId?: string | null;
	/** Evento ao vivo (o cartão na tela agora). */
	emit: (event: ComputerUseEvent) => void | Promise<void>;
	/** Sincroniza o agendador depois de mudar uma rotina (o mesmo gancho do legado: `syncRoutineScheduler`). Ausente = não sincroniza. */
	onMutated?: (routine: RoutineRecord) => Promise<unknown>;
	log?: (message: string) => void;
};

const TASK_MAX = 280;

function oneLine(text: string): string {
	return text.split(/\s+/).filter(Boolean).join(" ");
}

export function toRoutineView(row: RoutineRecord, now: Date): RoutineView {
	const task = oneLine(row.prompt ?? "");
	const alert = describeRoutineAlertSentence(row);
	const next = routineNextRunAt(row, now);
	return {
		id: row.id,
		name: row.name,
		trigger: describeRoutineTrigger(row),
		kind: row.triggerType,
		enabled: row.enabled,
		...(row.group?.name && { group: row.group.name }),
		...(alert && { alert }),
		task: task.length > TASK_MAX ? `${task.slice(0, TASK_MAX - 1)}…` : task,
		...(next && { nextRunAt: next }),
		...(row.lastRunAt && { lastRunAt: row.lastRunAt }),
		...(row.lastRun?.status && { lastStatus: row.lastRun.status }),
	};
}

const toGroupView = (g: RoutineGroupRecord): RoutineGroupView => ({ id: g.id, name: g.name, routineCount: g.routineCount, enabledCount: g.enabledCount });

export function createV4Routines(input: { scope: V4RoutinesScope; deps?: V4RoutinesDeps }): Routines {
	const deps = input.deps ?? realV4RoutinesDeps;
	const { scope } = input;
	const log = scope.log ?? console.warn;

	const rows = (userId: string) => deps.list(userId, scope.botId);
	const own = async (userId: string, routineId: string) => (await rows(userId)).find((row) => row.id === routineId) ?? null;

	/** Cartão da rotina no chat: o mesmo evento `routine` do legado. `persist` grava na conversa (pausar/retomar/apagar, como no legado). */
	async function showCard(routine: RoutineRecord, line: string, opts: { persist: boolean; gone?: boolean }) {
		const sentence = describeRoutineAlertSentence(routine);
		const event: ComputerUseEvent = {
			type: "routine",
			action: "updated",
			...(!opts.gone && { routineId: routine.id }),
			title: routine.name,
			triggerType: routine.triggerType,
			detail: [line, sentence, ...(opts.gone ? [routine.name] : [])].filter(Boolean).join("\n"),
		};
		if (opts.persist && scope.conversationId) {
			await deps.persistCard(scope.conversationId, event).catch(() => log("[engine-v4] não consegui gravar o cartão da rotina na conversa"));
		}
		await scope.emit(event);
	}

	async function sync(routine: RoutineRecord) {
		// O agendador é melhor esforço (como no legado): a rotina já mudou no banco, e o worker reconcilia no boot.
		try {
			await scope.onMutated?.(routine);
		} catch {
			log("[engine-v4] não consegui sincronizar o agendador da rotina");
		}
	}

	return {
		async list(userId) {
			const now = deps.now();
			return (await rows(userId)).map((row) => toRoutineView(row, now));
		},
		async groups(userId) {
			return (await deps.listGroups(userId, scope.botId)).map(toGroupView);
		},
		async setEnabled(userId, routineId, enabled) {
			if (!(await own(userId, routineId))) return null;
			const updated = await deps.update(userId, scope.botId, routineId, { enabled });
			if (!updated) return null;
			await sync(updated);
			await showCard(updated, enabled ? "Retomada" : "Pausada", { persist: true });
			return toRoutineView(updated, deps.now());
		},
		async remove(userId, routineId) {
			const existing = await own(userId, routineId);
			if (!existing) return null;
			if (!(await deps.remove(userId, scope.botId, routineId))) throw new Error("The routine could not be deleted right now.");
			await sync({ ...existing, enabled: false });
			await showCard(existing, "Apagada", { persist: true, gone: true });
			return toRoutineView(existing, deps.now());
		},
		async createGroup(userId, name) {
			return toGroupView(await deps.createGroup(userId, scope.botId, { name }));
		},
		async renameGroup(userId, groupId, name) {
			const groups = await deps.listGroups(userId, scope.botId);
			if (!groups.some((g) => g.id === groupId)) return null;
			const renamed = await deps.updateGroup(userId, scope.botId, groupId, { name });
			return renamed ? toGroupView(renamed) : null;
		},
		async deleteGroup(userId, groupId) {
			const group = (await deps.listGroups(userId, scope.botId)).find((g) => g.id === groupId);
			if (!group) return null;
			const result = await deps.deleteGroup(userId, scope.botId, groupId);
			if (!result) return null;
			const first = result.routines[0];
			if (first) await showCard({ ...first, groupId: null, group: null }, "Grupo desfeito", { persist: false });
			return { name: group.name, routines: result.routines.length };
		},
		async setGroupEnabled(userId, groupId, enabled) {
			const group = (await deps.listGroups(userId, scope.botId)).find((g) => g.id === groupId);
			if (!group) return null;
			const before = (await rows(userId)).filter((row) => row.groupId === groupId);
			const updated = await deps.setGroupEnabled(userId, scope.botId, groupId, enabled);
			if (!updated) return null;
			for (const routine of updated) await sync(routine);
			const changed = updated.filter((routine) => routine.enabled === enabled && before.find((b) => b.id === routine.id)?.enabled !== enabled).length;
			const first = updated[0];
			if (first) await showCard(first, enabled ? "Grupo retomado" : "Grupo pausado", { persist: false });
			return { name: group.name, total: updated.length, changed };
		},
		async moveToGroup(userId, routineId, groupId) {
			if (!(await own(userId, routineId))) return null;
			if (groupId !== null && !(await deps.listGroups(userId, scope.botId)).some((g) => g.id === groupId)) return null;
			const updated = await deps.update(userId, scope.botId, routineId, { groupId });
			if (!updated) return null;
			await showCard(updated, groupId === null ? "Fora do grupo" : `Movida para o grupo ${updated.group?.name ?? ""}`.trim(), { persist: false });
			return toRoutineView(updated, deps.now());
		},
	};
}
