import { PUSH_AVATAR_BACKGROUND, renderAvatarSvg } from "@workspace/shared";
import * as React from "react";
import { View } from "react-native";
import { SvgXml } from "react-native-svg";
import { cn } from "@/lib/cn";

export type AvatarProps = {
	/** Rótulo acessível (vira `accessibilityLabel` com `role="img"`). */
	ariaLabel?: string;
	className?: string;
	/** Cor do corpo (o avatar branco do Atlas é `#ffffff`). */
	color?: string;
	shape?: string;
	size?: number;
};

/**
 * Avatar do Atlas. Mesmo nome e props do Avatar de packages/ui, mas estático: usa o SVG de repouso do
 * mesmo motor (`renderAvatarSvg`, em @workspace/shared), sem o loop de animação do web.
 * O branco precisa de um fundo escuro para aparecer nos dois temas: o disco usa o mesmo `#09090b` do avatar
 * das notificações push (PUSH_AVATAR_BACKGROUND).
 */
export function Avatar({ ariaLabel, className, color = "#ffffff", shape = "blob", size = 56 }: AvatarProps) {
	const xml = React.useMemo(() => renderAvatarSvg({ shape, color, size: Math.round(size * 0.8) }), [shape, color, size]);
	return (
		<View
			role="img"
			accessibilityLabel={ariaLabel}
			accessible={Boolean(ariaLabel)}
			style={{ width: size, height: size, backgroundColor: PUSH_AVATAR_BACKGROUND }}
			className={cn("items-center justify-center overflow-hidden rounded-full border border-border", className)}
		>
			<SvgXml xml={xml} />
		</View>
	);
}
