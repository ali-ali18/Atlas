"use client";

import { Avatar, type AvatarProps } from "@workspace/ui/components/avatar/avatar";
import { expressionForLegacyState } from "@workspace/ui/lib/avatar/model/expressions";

import type { BloubState } from "./data";

export type AgentAvatarProps = Omit<AvatarProps, "color" | "expression"> & {
	bodyColor?: string;
	/** Rosto pedido por nome (os nomes vêm do desenho antigo). */
	mood?: BloubState;
};

// Avatar do bot: forma e cor vêm do AvatarEditor (ou do id, se o bot nunca
// escolheu). Sem `id`, a semente do ritmo sai de forma+cor, então avatares
// diferentes não piscam em uníssono. O Avatar já cuida de `shrink-0` e de
// impedir que regras de ancestrais (ex.: SidebarMenuButton força `svg` a
// size-4) esmaguem o SVG.
export function AgentAvatar({
	bodyColor,
	id,
	shape,
	size = 56,
	mood,
	...props
}: AgentAvatarProps) {
	return (
		<Avatar
			{...props}
			color={bodyColor}
			expression={mood ? expressionForLegacyState(mood) : undefined}
			id={id ?? `${shape ?? ""}-${bodyColor ?? ""}`}
			shape={shape}
			size={size}
		/>
	);
}
