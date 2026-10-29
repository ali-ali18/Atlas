"use client";

import { useEffect } from "react";
import type { SubagentTaskView } from "@workspace/shared";

import { formatElapsed } from "@/lib/dev-session/reducer";
import { openActivity, registerSubagentTasks, useActivitySelection, useNow, useSubagentTrack } from "@/lib/dev-session/store";
import { subagentElapsedMs, type SubagentTrack } from "@/lib/dev-session/subagent-track";

import { SubagentAvatar } from "./subagent-avatars";
import { ActivityCard } from "../dev-session/parts";
import { SUBAGENT_STATUS_TONE, subagentFailureReason, subagentStatusLabel, subagentTitle } from "./subagent-status";
import { useTranslations } from "@/lib/i18n/provider";
import { defaultTranslator, type Translator } from "@/lib/i18n/translator";

/** Texto do indicador enquanto rodam ("Esperando resposta dos subagentes (2 de 3)"). */
export function subagentsWaitingLabel(tasks: readonly SubagentTaskView[], { t }: Translator = defaultTranslator): string {
	const done = tasks.filter((task) => task.status !== "running").length;
	return t("aiElements.subagents.waiting", { done, total: tasks.length });
}

/** Linha compacta do grupo já pronto ("3 subagentes · ver detalhes"). */
export function subagentsHeadline(tasks: readonly SubagentTaskView[], { tn }: Translator = defaultTranslator): string {
	const failed = tasks.filter((task) => task.status === "failed").length;
	const parts = [tn("aiElements.subagents.headline", tasks.length)];
	if (failed > 0) parts.push(tn("aiElements.subagents.failed", failed));
	return parts.join(" · ");
}

/** Linha compacta de um subagente; o clique abre o detalhe na 3ª coluna. */
export function SubagentCardView({
	groupId,
	task,
	track,
	now,
	selected = false,
	onOpen,
}: {
	groupId: string;
	task: SubagentTaskView;
	track?: SubagentTrack;
	now: number;
	selected?: boolean;
	onOpen?: () => void;
}) {
	const translator = useTranslations();
	const { t, tn } = translator;
	const elapsed = subagentElapsedMs(track, task.status === "running", now);
	const time = elapsed === null ? null : formatElapsed(elapsed);
	const running = task.status === "running";
	const status = running ? (time ?? subagentStatusLabel("running", translator)) : [subagentStatusLabel(task.status, translator), time].filter(Boolean).join(" · ");
	const toolCount = track?.tools.reduce((sum, tool) => sum + tool.count, 0) || task.toolsUsed.length;
	const reason = subagentFailureReason(task);
	const extra = running
		? track?.lastTool
			? <span className="font-mono">{track.lastTool}</span>
			: null
		: reason
			? <span data-subagent-reason title={reason}>{reason}</span>
			: toolCount > 0
				? tn("aiElements.subagents.toolCount", toolCount)
				: null;
	return (
		<ActivityCard
			extra={extra}
			dataAttr="data-subagent-card"
			icon={<SubagentAvatar groupId={groupId} size={20} task={task} />}
			label={t("aiElements.subagents.open", { name: subagentTitle(task, translator) })}
			onOpen={onOpen}
			selected={selected}
			status={status}
			title={subagentTitle(task, translator)}
			tone={SUBAGENT_STATUS_TONE[task.status]}
		/>
	);
}

function SubagentCard({ groupId, task }: { groupId: string; task: SubagentTaskView }) {
	const track = useSubagentTrack(groupId, task.taskIndex);
	const selection = useActivitySelection();
	const now = useNow(task.status === "running");
	return (
		<SubagentCardView
			groupId={groupId}
			now={now}
			onOpen={() => openActivity({ kind: "subagent", groupId, taskIndex: task.taskIndex })}
			selected={
				selection?.kind === "subagent" && selection.groupId === groupId && selection.taskIndex === task.taskIndex
			}
			task={task}
			track={track}
		/>
	);
}

/** Subagentes de uma chamada de `delegate_task`: uma linha compacta por tarefa. */
export function SubagentsBlock({
	groupId,
	tasks,
}: {
	groupId: string;
	tasks: readonly SubagentTaskView[];
}) {
	useEffect(() => {
		registerSubagentTasks(groupId, tasks);
	}, [groupId, tasks]);
	if (tasks.length === 0) return null;
	return (
		<div className="flex w-full min-w-0 flex-col gap-1.5">
			{tasks.map((task) => (
				<SubagentCard groupId={groupId} key={task.taskIndex} task={task} />
			))}
		</div>
	);
}
