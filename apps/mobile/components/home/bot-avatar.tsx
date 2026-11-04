import { resolveColor, resolveShape } from "@workspace/shared/avatar/identity";
import type { HomeBot } from "@/lib/home-types";
import * as React from "react";
import { View } from "react-native";
import { StarFilledIcon } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { LIST_POSE } from "@/lib/avatar-pose";
import { useSurfaces } from "@/lib/use-surfaces";

/**
 * Cor de marca do selo do bot principal: a mesma do web (`primary-bot-badge.tsx`, `bg-[#ff9800]` com estrela
 * `#fcfcfc`). Não é um token do tema (`warning` é amarelo e muda no escuro); o selo tem a mesma cor nos dois temas.
 */
export const PRIMARY_BADGE_COLOR = "#ff9800";
const PRIMARY_BADGE_STAR = "#fcfcfc";

type BotAvatarProps = {
	bot: HomeBot;
	/** Bots do usuário, para achar os membros de um grupo. */
	bots: readonly HomeBot[];
	/** Lado do corpo em px (o SVG tem ~30% de margem). */
	body: number;
	/** Conversa não lida: bolinha no canto de baixo à direita (como o `AvatarStatus` do web). */
	unread?: boolean;
};

/** Tamanho da bolinha: 26% do avatar, entre 10 e 16 (mesma conta do web, `avatarDotMetrics`). */
export function unreadDotSize(body: number): number {
	return Math.min(16, Math.max(10, Math.round(body * 0.26)));
}

/**
 * Bolinha de não lida (`info`, a azul do tema) no canto de baixo à direita do avatar. O anel na cor do fundo faz o
 * papel do recorte do web (2px de folga entre avatar e bolinha).
 */
export function UnreadDot({ body }: { body: number }) {
	const { screen } = useSurfaces();
	const size = unreadDotSize(body);
	return (
		<View
			accessibilityLabel="Não lida"
			className="absolute rounded-full bg-info"
			style={{ right: -2, bottom: -2, width: size + 4, height: size + 4, borderWidth: 2, borderColor: screen }}
		/>
	);
}

// O corpo ocupa ~70,5% da caixa do SVG (ver Avatar).
const BOX_RATIO = 1 / 0.705;

/**
 * Avatar de um bot com a forma e a cor reais dele (mesmo motor do web); grupo mostra até 3 membros. Parado, de lado e
 * olhando para cima e para a direita (a pose da referência), sem animação: uma grade e uma lista com dezenas de avatares
 * animados custariam timers e valores compartilhados por avatar, e no web a lista também fica parada.
 */
export function BotAvatar({ bot, bots, body, unread = false }: BotAvatarProps) {
	const box = Math.round(body * BOX_RATIO);
	const members = bot.memberIds.length > 0 ? bot.memberIds.map((id) => bots.find((item) => item.id === id)).filter((item): item is HomeBot => Boolean(item)).slice(0, 3) : [];
	if (members.length === 0) {
		return (
			<View style={{ width: body, height: body, alignItems: "center", justifyContent: "center" }}>
				<Avatar color={resolveColor(bot.color, bot.id)} shape={resolveShape(bot.shape, bot.id)} size={box} animated={false} pose={LIST_POSE} />
				{unread ? <UnreadDot body={body} /> : null}
			</View>
		);
	}
	// Grupo: os membros menores dentro do mesmo quadrado de um bot (como o GroupAvatar do web).
	const small = Math.round(body * 0.62);
	const spots = members.length === 2 ? [{ left: 0, top: 0 }, { right: 0, bottom: 0 }] : [{ left: 0, top: 0 }, { right: 0, top: body * 0.12 }, { left: body * 0.2, bottom: 0 }];
	return (
		<View style={{ width: body, height: body }}>
			{members.map((member, index) => (
				<View key={member.id} style={[{ position: "absolute", width: small, height: small, alignItems: "center", justifyContent: "center" }, spots[index]]}>
					<Avatar color={resolveColor(member.color, member.id)} shape={resolveShape(member.shape, member.id)} size={Math.round(small * BOX_RATIO)} animated={false} pose={LIST_POSE} />
				</View>
			))}
			{unread ? <UnreadDot body={body} /> : null}
		</View>
	);
}

/** Bolinha laranja com a estrela, no canto do avatar do bot principal. */
export function PrimaryBadge({ size = 28 }: { size?: number }) {
	return (
		<View
			accessibilityLabel="Bot principal"
			style={{ position: "absolute", right: 0, bottom: 0, width: size, height: size, borderRadius: size / 2, backgroundColor: PRIMARY_BADGE_COLOR, alignItems: "center", justifyContent: "center" }}
		>
			<StarFilledIcon size={Math.round(size * 0.5)} color={PRIMARY_BADGE_STAR} />
		</View>
	);
}
