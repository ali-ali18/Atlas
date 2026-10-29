"use client";

import { useMemo } from "react";

import { useT } from "@/lib/i18n/provider";
import type { GroupBubbleLayout } from "@/lib/group-thread";

import { AgentAvatar } from "../agent-avatar";
import { botAccent } from "../chat-context-panel/bot-accent";
import type { Message } from "../data";
import { AssistantMessage } from "./assistant-message";
import { mentionMarkdownComponents, type MentionMember } from "./mention-text";

/** Membro com o que o balão precisa (cor do nome e avatar). */
export type GroupMessageMember = MentionMember;

const AVATAR_SIZE = 30;

/**
 * Fala de um membro na conversa do grupo: avatar + nome (na cor do membro) no
 * primeiro balão do trecho, balões conectados e chips nas menções. Falas
 * seguidas do mesmo membro deixam a coluna do avatar vazia.
 */
export function GroupAssistantRow({
	message,
	layout,
	author,
	members,
	live = false,
}: {
	message: Extract<Message, { kind: "assistant" }>;
	layout: GroupBubbleLayout;
	/** Membro autor (quando ainda existe no grupo). */
	author: GroupMessageMember | undefined;
	members: readonly GroupMessageMember[];
	live?: boolean;
}) {
	const t = useT();
	const components = useMemo(() => mentionMarkdownComponents(members), [members]);
	const name = author?.name ?? message.author?.name ?? t("groups.botFallback");
	const accent = botAccent(author?.color)?.accent;
	return (
		<div className="flex items-end gap-2" data-testid="group-message" data-author={layout.authorKey}>
			<div className="w-[30px] shrink-0 self-start pt-5" style={{ width: AVATAR_SIZE }}>
				{layout.first ? (
					<AgentAvatar animated={false} bodyColor={author?.color} id={author?.id ?? message.author?.id} shape={author?.shape} size={AVATAR_SIZE} />
				) : null}
			</div>
			<div className="min-w-0 flex-1">
				{layout.first ? (
					<span
						className="mb-0.5 ml-3 block truncate font-medium text-xs"
						data-slot="group-author"
						style={accent ? { color: accent } : undefined}
					>
						{name}
					</span>
				) : null}
				<AssistantMessage groupPosition={layout.position} live={live} markdownComponents={components} messageId={message.id} text={message.text} />
			</div>
		</div>
	);
}
