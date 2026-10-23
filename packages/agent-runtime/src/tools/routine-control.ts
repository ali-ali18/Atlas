import type { ChatTool } from "@workspace/llm";
import { describeRoutineAlertSentence, type RoutineNotifyMode, type RoutineRecord } from "@workspace/shared";

/**
 * `routine_control`: o que o usuário faz no cartão da rotina (pausar, retomar, apagar, ligar/desligar o aviso),
 * por conversa. Vale para qualquer rotina, inclusive alerta. Escrita sempre devolve um cartão visível.
 */
export const ROUTINE_CONTROL_TOOL_NAME = "routine_control";

export const ROUTINE_CONTROL_TOOL: ChatTool = {
	type: "function",
	function: {
		name: ROUTINE_CONTROL_TOOL_NAME,
		description:
			"Pause, resume, delete or change the notification mode of ONE existing routine or alert (by name or id from list_routines). Use for \"pausa o alerta do estoque\", \"volta com a rotina X\", \"apaga o alerta Y\", \"para de me avisar dessa rotina\". pause/resume keep everything and stop/restart the schedule. delete removes it for good: only when the user clearly asked to delete. notify_always = push at the end of every run; notify_important = run results stay in the chat and you only push what deserves attention. An alert (routine with an alert condition) pushes only when its condition turns true, so notify_* does not apply to it: to silence an alert use pause, or propose_routine edit with an empty alert.condition to turn it back into a normal routine. To change the condition or the frequency use propose_routine edit, not this tool. Not for groups (routine_group) and not inside a routine run.",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["pause", "resume", "delete", "notify_always", "notify_important"], description: "What to do." },
				target: { type: "string", description: "Routine name or id (from list_routines)." },
			},
			required: ["action", "target"],
		},
	},
};

type Routine = Pick<RoutineRecord, "id" | "name" | "enabled" | "triggerType" | "schedule" | "interval" | "alert" | "notify">;

export type RoutineControlDeps = {
	resolve: (target: string) => Promise<{ kind: "one"; routine: RoutineRecord } | { kind: "none" } | { kind: "ambiguous"; lines: string }>;
	/** Atualiza pelo dono do run (db escopado). null = não achou/sem permissão. */
	update: (routineId: string, patch: { enabled?: boolean; notify?: RoutineNotifyMode }) => Promise<RoutineRecord | null>;
	remove: (routineId: string) => Promise<boolean>;
	/** Sincroniza o agendador (pausar/apagar tira o cron). */
	onMutated?: (routine: RoutineRecord) => Promise<unknown>;
};

export type RoutineControlEvent = { type: "routine"; action: "updated"; routineId?: string; title: string; triggerType: RoutineRecord["triggerType"]; detail: string };

const ACTIONS = ["pause", "resume", "delete", "notify_always", "notify_important"] as const;
type Action = (typeof ACTIONS)[number];

function detailFor(routine: Routine, line: string): string {
	const sentence = describeRoutineAlertSentence(routine);
	return [line, sentence].filter(Boolean).join("\n");
}

export async function executeRoutineControl(
	args: Record<string, unknown>,
	deps: RoutineControlDeps,
): Promise<{ summary: string; routineEvent?: RoutineControlEvent }> {
	const action = String(args.action ?? "").trim() as Action;
	if (!ACTIONS.includes(action)) throw new Error(`action deve ser ${ACTIONS.join(", ")}`);
	const target = String(args.target ?? "").trim().slice(0, 200);
	if (!target) throw new Error("informe target (nome ou id da rotina; veja list_routines)");
	const found = await deps.resolve(target);
	if (found.kind === "none") return { summary: `Não achei rotina parecida com "${target.slice(0, 80)}". Use list_routines.` };
	if (found.kind === "ambiguous") return { summary: `Achei mais de uma rotina:\n${found.lines}\nPeça ao usuário qual.` };
	const routine = found.routine;
	const isAlert = Boolean(routine.alert?.condition);

	if (action === "delete") {
		if (!(await deps.remove(routine.id))) throw new Error("Não consegui apagar a rotina agora. Tente de novo.");
		await deps.onMutated?.({ ...routine, enabled: false }).catch(() => undefined);
		return {
			summary: `${isAlert ? "Alerta" : "Rotina"} "${routine.name}" apagado.`,
			routineEvent: { type: "routine", action: "updated", title: routine.name, triggerType: routine.triggerType, detail: `Apagada\n${routine.name}` },
		};
	}
	if (action === "notify_always" || action === "notify_important") {
		if (isAlert) {
			return { summary: `"${routine.name}" é um alerta: ele só avisa quando a condição passa a valer, então o modo de aviso não se aplica. Para parar os avisos, pause o alerta (routine_control pause) ou remova a condição (propose_routine edit com alert.condition vazio).` };
		}
		const notify: RoutineNotifyMode = action === "notify_always" ? "always" : "important";
		const updated = await deps.update(routine.id, { notify });
		if (!updated) throw new Error("Não consegui atualizar a rotina agora.");
		return {
			summary: `Rotina "${updated.name}": ${notify === "always" ? "avisa no fim de toda execução" : "só avisa quando o resultado merece atenção"}.`,
			routineEvent: { type: "routine", action: "updated", routineId: updated.id, title: updated.name, triggerType: updated.triggerType, detail: detailFor(updated, notify === "always" ? "Avisa a cada execução" : "Só avisa o que é importante") },
		};
	}
	const enabled = action === "resume";
	if (routine.enabled === enabled) {
		return { summary: `"${routine.name}" já está ${enabled ? "ativa" : "pausada"}. Nada mudou.` };
	}
	const updated = await deps.update(routine.id, { enabled });
	if (!updated) throw new Error("Não consegui atualizar a rotina agora.");
	await deps.onMutated?.(updated).catch(() => undefined);
	return {
		summary: `${isAlert ? "Alerta" : "Rotina"} "${updated.name}" ${enabled ? "retomado" : "pausado"}.`,
		routineEvent: { type: "routine", action: "updated", routineId: updated.id, title: updated.name, triggerType: updated.triggerType, detail: detailFor(updated, enabled ? "Retomada" : "Pausada") },
	};
}
