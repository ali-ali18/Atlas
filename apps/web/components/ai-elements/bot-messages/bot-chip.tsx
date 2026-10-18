"use client";

import { AgentAvatar } from "@/components/ui/templates/template-4/agent-avatar";

/** Bot citado numa mensagem entre bots (o suficiente para desenhar o avatar). */
export type BotRef = { id?: string; name: string; color?: string; shape?: string };

/** Avatar pequeno + nome, na mesma linha do texto do marcador (só visual). */
export function BotChip({ bot }: { bot: BotRef }) {
	return (
		<span className="inline-flex items-center gap-1 align-middle">
			<AgentAvatar animated={false} bodyColor={bot.color} id={bot.id} shape={bot.shape} size={16} />
			<span className="max-w-[10rem] truncate font-medium text-foreground/80">{bot.name}</span>
		</span>
	);
}
