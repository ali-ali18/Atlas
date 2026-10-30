"use client";

import { useCallback, useEffect, useRef } from "react";

import { Avatar, type AvatarController, type AvatarProps } from "@workspace/ui/components/avatar/avatar";

import { subscribeBotPulses, useBotAvatar } from "@/lib/bot-activity";

// Avatar vivo do bot: o que ele faz agora (pensando, pesquisando, lendo, programando,
// escrevendo, esperando você…) vem do run ativo (ChatThread publica em lib/bot-activity) e
// vira o estado do motor; os eventos do run (ferramenta começou, acabou, falhou) viram gestos
// curtos do cérebro. Run só do servidor (rotina) = gestos genéricos de trabalho.
// O movimento contínuo (cérebro) é só dos avatares do chat aberto (`follow="always"`: cabeçalho,
// indicador, painel); os da sidebar ficam com os clipes e não seguram o loop de quadros.
// Forma e cor continuam vindo do AvatarEditor; sem elas, saem do id do bot.
export function LiveAgentAvatar({
	botId,
	bodyColor,
	ref,
	brain,
	...props
}: Omit<AvatarProps, "color" | "id" | "state" | "progress" | "activity"> & {
	botId: string;
	bodyColor?: string;
}) {
	const { state, progress } = useBotAvatar(botId);
	const controller = useRef<AvatarController | null>(null);
	// Ref estável: um callback novo a cada render faria o React soltar e religar a ref toda vez.
	const setRef = useCallback(
		(node: AvatarController | null) => {
			controller.current = node;
			if (typeof ref === "function") ref(node);
			else if (ref) ref.current = node;
		},
		[ref],
	);
	useEffect(() => subscribeBotPulses(botId, (kind, strength) => controller.current?.pulse(kind, strength)), [botId]);
	return (
		<Avatar
			{...props}
			brain={brain ?? props.follow === "always"}
			color={bodyColor}
			id={botId}
			progress={progress}
			ref={setRef}
			state={state}
		/>
	);
}
