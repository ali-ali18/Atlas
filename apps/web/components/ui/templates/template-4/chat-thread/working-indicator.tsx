"use client";

import type { SubagentTaskView } from "@workspace/shared";
import { expressionForLegacyState } from "@workspace/ui/lib/avatar/model/expressions";
import { Marker, MarkerContent, MarkerIcon } from "@workspace/ui/components/marker";

import {
	SubagentAvatars,
	subagentsWaitingLabel,
} from "@/components/ai-elements/subagents";
import { devLiveLine } from "@/lib/dev-session/live-line";
import { useDevSession, useNow } from "@/lib/dev-session/store";
import {
	type AgentActivity,
	workingStatusLabel,
} from "@/lib/working-status";

import { type Agent } from "../data";
import { LiveAgentAvatar } from "../live-agent-avatar";
import { usePreviewExpression } from "../use-preview-expression";

export function WorkingIndicator({
	activity,
	agent,
	paused = false,
	status = null,
	subagents = null,
	label: labelOverride,
	devSessionId = null,
	pendingApproval = false,
}: {
	/** Sessão de código da conversa: a linha mostra o que ela faz agora. */
	devSessionId?: string | null;
	/** Há um cartão de aprovação esperando o usuário. */
	pendingApproval?: boolean;
	activity: AgentActivity;
	agent: Agent;
	/** Grupo: texto próprio ("Bia está respondendo") no lugar do padrão. */
	label?: string;
	paused?: boolean;
	status?: string | null;
	/** Grupo de subagentes rodando: troca o avatar do bot pelos mini avatares. */
	subagents?: { groupId: string; tasks: readonly SubagentTaskView[] } | null;
}) {
	const { expression } = usePreviewExpression({
		enabled: !paused,
		mode: "working",
	});

	const waitingOnSubagents = !paused && subagents !== null && subagents.tasks.length > 0;
	const devView = useDevSession(devSessionId ?? "");
	const trackLive = devSessionId !== null || pendingApproval;
	const now = useNow(trackLive && !paused);
	const liveLine = trackLive && (!paused || pendingApproval) ? devLiveLine({ view: devView, activity, pendingApproval, now: now || Date.now() }) : null;
	const label = waitingOnSubagents
		? subagentsWaitingLabel(subagents.tasks)
		: (liveLine ?? labelOverride ?? workingStatusLabel(agent.name, activity, { paused, status }));

	return (
		<div
			aria-live="polite"
			className="pointer-events-none relative h-0 overflow-visible"
		>
			{waitingOnSubagents ? (
				<Marker className="absolute top-3 left-0 w-auto gap-2.5" role="status">
					<MarkerIcon className="size-auto">
						<SubagentAvatars groupId={subagents.groupId} size={30} tasks={subagents.tasks} />
					</MarkerIcon>
					<MarkerContent className="shimmer">{label}…</MarkerContent>
				</Marker>
			) : (
				<div className="absolute top-3 right-0 left-0 flex items-center gap-2.5">
					<LiveAgentAvatar
						bodyColor={agent.color}
						botId={agent.id}
						breathe
						className="pointer-events-auto"
						expression={expressionForLegacyState(expression)}
						follow="always"
						pokeOnClick
						shape={agent.shape}
						size={36}
					/>
					<span className="min-w-0 truncate text-muted-foreground text-sm" data-testid="working-line" title={label}>
						{label}
					</span>
				</div>
			)}
		</div>
	);
}
