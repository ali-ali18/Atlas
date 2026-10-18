"use client";

import { Avatar, type AvatarProps } from "@workspace/ui/components/avatar/avatar";

import { useBotWorking } from "@/lib/bot-activity";

// Avatar vivo do bot: "trabalhando" vem do run ativo (ChatThread publica em
// lib/bot-activity) e vira o estado `working` do motor (gestos de trabalho). Forma e cor
// continuam vindo do AvatarEditor; sem elas, saem do id do bot.
export function LiveAgentAvatar({
	botId,
	bodyColor,
	...props
}: Omit<AvatarProps, "color" | "id" | "state"> & {
	botId: string;
	bodyColor?: string;
}) {
	const working = useBotWorking(botId);
	return (
		<Avatar
			{...props}
			color={bodyColor}
			id={botId}
			state={working ? "working" : "idle"}
		/>
	);
}
