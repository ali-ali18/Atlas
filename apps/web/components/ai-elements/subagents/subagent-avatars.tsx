"use client";

import { DRAWABLE_SHAPES } from "@workspace/ui/lib/avatar/geometry/shapes";
import { subagentLookSeed, type SubagentTaskView } from "@workspace/shared";

import { AgentAvatar } from "@/components/ui/templates/template-4/agent-avatar";
import type { BloubState } from "@/components/ui/templates/template-4/data";
import { bodyColors } from "@/components/ui/templates/template-4/data";

/** Rostos fixos por estado (sem animação): pensando enquanto trabalha, depois assentado. */
const STATUS_MOOD: Record<SubagentTaskView["status"], BloubState> = {
	running: "attentif",
	ok: "heureux",
	partial: "neutre",
	failed: "triste",
};

/** Cor e forma fixas por (groupId, taskIndex): não piscam ao re-renderizar. */
export function subagentLook(groupId: string, taskIndex: number) {
	const seed = subagentLookSeed(groupId, taskIndex);
	return {
		color: bodyColors[seed % bodyColors.length]!.value,
		shape: DRAWABLE_SHAPES[Math.floor(seed / bodyColors.length) % DRAWABLE_SHAPES.length]!,
	};
}

/** Mini avatar de um subagente: rosto estático (leve) que muda com o estado. */
export function SubagentAvatar({
	groupId,
	task,
	size = 28,
}: {
	groupId: string;
	task: SubagentTaskView;
	size?: number;
}) {
	const look = subagentLook(groupId, task.taskIndex);
	return (
		<AgentAvatar
			animated={false}
			bodyColor={look.color}
			mood={STATUS_MOOD[task.status]}
			shape={look.shape}
			size={size}
		/>
	);
}

/** Avatares lado a lado, um por subagente (decorativos: o texto ao lado informa). */
export function SubagentAvatars({
	groupId,
	tasks,
	size = 30,
}: {
	groupId: string;
	tasks: readonly SubagentTaskView[];
	size?: number;
}) {
	return (
		<span aria-hidden="true" className="flex shrink-0 items-center -space-x-1.5">
			{tasks.map((task) => (
				<span className="rounded-full" key={task.taskIndex}>
					<SubagentAvatar groupId={groupId} size={size} task={task} />
				</span>
			))}
		</span>
	);
}
