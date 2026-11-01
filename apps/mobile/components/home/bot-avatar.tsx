import { resolveColor, resolveShape } from "@workspace/shared/avatar/identity";
import type { Bot } from "@workspace/shared";
import * as React from "react";
import { View } from "react-native";
import { StarFilledIcon } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";

/** Laranja do selo do bot principal (a estrelinha da referência). */
export const PRIMARY_BADGE_COLOR = "#ff9f0a";

type BotAvatarProps = {
	bot: Bot;
	/** Bots do usuário, para achar os membros de um grupo. */
	bots: readonly Bot[];
	/** Lado do corpo em px (o SVG tem ~30% de margem). */
	body: number;
	animated?: boolean;
};

// O corpo ocupa ~70,5% da caixa do SVG (ver Avatar).
const BOX_RATIO = 1 / 0.705;

/** Avatar de um bot com a forma e a cor reais dele (mesmo motor do web); grupo mostra até 3 membros. */
export function BotAvatar({ bot, bots, body, animated = false }: BotAvatarProps) {
	const box = Math.round(body * BOX_RATIO);
	const members = bot.memberIds.length > 0 ? bot.memberIds.map((id) => bots.find((item) => item.id === id)).filter((item): item is Bot => Boolean(item)).slice(0, 3) : [];
	if (members.length === 0) {
		return (
			<View style={{ width: body, height: body, alignItems: "center", justifyContent: "center" }}>
				<Avatar color={resolveColor(bot.color, bot.id)} shape={resolveShape(bot.shape, bot.id)} size={box} animated={animated} look={false} />
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
					<Avatar color={resolveColor(member.color, member.id)} shape={resolveShape(member.shape, member.id)} size={Math.round(small * BOX_RATIO)} animated={false} look={false} />
				</View>
			))}
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
			<StarFilledIcon size={Math.round(size * 0.5)} />
		</View>
	);
}
