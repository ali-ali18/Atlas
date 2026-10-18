"use client";

import { Button } from "@workspace/ui/components/button";
import { LiveAgentAvatar } from "../live-agent-avatar";
import { PrimaryBotBadge } from "../primary-bot-badge";

import type { Agent } from "../data";

export function PinnedBotButton({
	agent,
	onSelect,
}: {
	agent: Agent;
	onSelect: () => void;
}) {
	return (
		<Button
			className="h-full w-full flex-col gap-1.5 rounded-lg p-1.5 hover:bg-sidebar-accent/40 dark:hover:bg-sidebar-accent/40"
			onClick={onSelect}
			title={agent.name}
			type="button"
			variant="ghost"
		>
			<span className="grid size-20 place-items-center">
				<PrimaryBotBadge show={agent.isPrimary} size={72}>
					<LiveAgentAvatar
						bodyColor={agent.color}
						botId={agent.id}
						follow="hover"
						pokeOnClick
						shape={agent.shape}
						size={72}
					/>
				</PrimaryBotBadge>
			</span>
			<span className="w-full truncate text-center font-medium text-sidebar-foreground text-xs">
				{agent.name}
			</span>
			<span className="max-w-full truncate rounded-full bg-sidebar-accent px-2 py-0.5 text-[10px] text-sidebar-foreground/70">
				{agent.snippet}
			</span>
		</Button>
	);
}
