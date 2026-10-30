"use client";

import { Avatar, type AvatarProps } from "@workspace/ui/components/avatar/avatar";

import { useBotAvatar } from "@/lib/bot-activity";

// Avatar vivo do bot: o que ele faz agora (pensando, pesquisando, lendo, programando,
// escrevendo, esperando você…) vem do run ativo (ChatThread publica em lib/bot-activity) e
// vira o estado do motor. Run só do servidor (rotina) = gestos genéricos de trabalho.
// Forma e cor continuam vindo do AvatarEditor; sem elas, saem do id do bot.
export function LiveAgentAvatar({
	botId,
	bodyColor,
	...props
}: Omit<AvatarProps, "color" | "id" | "state" | "progress"> & {
	botId: string;
	bodyColor?: string;
}) {
	const { state, progress } = useBotAvatar(botId);
	return <Avatar {...props} color={bodyColor} id={botId} progress={progress} state={state} />;
}
