"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SubagentTaskView } from "@workspace/shared";
import { Badge } from "@workspace/ui/components/badge";

import { markdownComponents } from "@/components/ui/templates/template-4/chat-thread/assistant-message";
import { formatElapsed } from "@/lib/dev-session/reducer";
import { subagentElapsedMs, type SubagentTrack } from "@/lib/dev-session/subagent-track";
import { useNow, useSubagentTasks, useSubagentTrack } from "@/lib/dev-session/store";

import { StatusPill } from "../dev-session/parts";
import { SubagentAvatar } from "./subagent-avatars";
import { SUBAGENT_STATUS_TONE, subagentModelLabel, subagentStatusLabel, subagentTitle } from "./subagent-status";
import { useTranslations } from "@/lib/i18n/provider";
import { defaultTranslator, type Translator } from "@/lib/i18n/translator";

export function subagentTimerLabel(track: SubagentTrack | undefined, running: boolean, now: number, { t }: Translator = defaultTranslator): string | null {
	const elapsed = subagentElapsedMs(track, running, now);
	if (elapsed === null) return null;
	return t(running ? "aiElements.subagents.timer.running" : "aiElements.subagents.timer.done", { elapsed: formatElapsed(elapsed) });
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="space-y-1.5">
			<h4 className="font-medium text-muted-foreground text-xs">{title}</h4>
			{children}
		</section>
	);
}

export function SubagentDetailView({
	groupId,
	task,
	track,
	now,
}: {
	groupId: string;
	task: SubagentTaskView;
	track?: SubagentTrack;
	now: number;
}) {
	const translator = useTranslations();
	const { t } = translator;
	const running = task.status === "running";
	const elapsed = subagentElapsedMs(track, running, now);
	const pill = [subagentStatusLabel(task.status, translator), elapsed === null ? null : formatElapsed(elapsed)].filter(Boolean).join(" · ");
	const tools = track?.tools.length
		? track.tools
		: task.toolsUsed.map((name) => ({ name, count: 0, failed: 0 }));
	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-4 pb-4" data-subagent-detail>
			<div className="flex min-w-0 flex-col gap-1.5">
				<div className="flex min-w-0 items-center gap-2">
					<span aria-hidden="true" className="shrink-0">
						<SubagentAvatar groupId={groupId} size={32} task={task} />
					</span>
					<h3 className="min-w-0 flex-1 truncate font-semibold text-sm">{subagentTitle(task, translator)}</h3>
				</div>
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
					<StatusPill label={pill} tone={SUBAGENT_STATUS_TONE[task.status]} />
					{task.model ? (
						<Badge className="h-4 px-1.5 font-normal text-[10px]" variant="outline">
							{subagentModelLabel(task.model)}
						</Badge>
					) : null}
				</div>
			</div>
			{task.goal ? (
				<Section title={t("aiElements.subagents.goal")}>
					<p className="wrap-break-word text-foreground/90 text-xs leading-relaxed">{task.goal}</p>
				</Section>
			) : null}
			<Section title={tools.length > 0 ? t("aiElements.subagents.toolsUsedCount", { count: tools.length }) : t("aiElements.subagents.toolsUsed")}>
				{tools.length === 0 ? (
					<p className="text-muted-foreground text-xs">{running ? t("aiElements.subagents.noneYet") : t("aiElements.subagents.none")}</p>
				) : (
					<ul className="flex flex-col gap-1">
						{tools.map((tool) => (
							<li
								className="flex items-center gap-2 rounded-xl border bg-card px-3 py-1.5 text-xs"
								key={tool.name}
							>
								<code className="min-w-0 flex-1 truncate font-mono">{tool.name}</code>
								{tool.count > 1 ? <span className="tabular-nums text-muted-foreground">×{tool.count}</span> : null}
								{tool.failed > 0 ? <span className="text-destructive">{t("aiElements.subagents.toolFailed", { count: tool.failed })}</span> : null}
							</li>
						))}
					</ul>
				)}
			</Section>
			{task.summary ? (
				<Section title={t("aiElements.subagents.summary")}>
					<div className="wrap-break-word text-muted-foreground text-xs [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_table]:text-xs">
						<ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
							{task.summary}
						</ReactMarkdown>
					</div>
				</Section>
			) : null}
		</div>
	);
}

/** Detalhe ligado ao store (coluna 3). */
export function SubagentDetail({ groupId, taskIndex }: { groupId: string; taskIndex: number }) {
	const { t } = useTranslations();
	const tasks = useSubagentTasks(groupId);
	const track = useSubagentTrack(groupId, taskIndex);
	const task = tasks.find((item) => item.taskIndex === taskIndex);
	const now = useNow(task?.status === "running");
	if (!task) {
		return <p className="px-6 py-8 text-center text-muted-foreground text-xs">{t("aiElements.subagents.notFound")}</p>;
	}
	return <SubagentDetailView groupId={groupId} now={now} task={task} track={track} />;
}
