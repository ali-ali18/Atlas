import { resolveColor, resolveShape } from "@workspace/shared/avatar/identity";
import * as React from "react";
import { View } from "react-native";
import { Avatar } from "@/components/ui/avatar";
import { Text } from "@/components/ui/text";
import type { MobileAvatarState } from "@/lib/avatar-activity";
import type { HomeBot } from "@/lib/home-types";
import type { syncLine } from "@/lib/chat-sync";
import { BotDots } from "./bot-dots";

/** Linha discreta logo abaixo da última mensagem e acima do composer: conferindo o servidor (ou sem conexão). */
export function SyncLine({ line, color }: { line: NonNullable<ReturnType<typeof syncLine>>; color: string }) {
	return (
		<View accessibilityRole="text" accessibilityLiveRegion="polite" accessibilityLabel={line.text} className="min-h-11 flex-row items-center gap-3 px-5">
			{line.kind === "checking" ? <BotDots color={color} /> : null}
			<Text variant="muted" className="text-control">
				{line.text}
			</Text>
		</View>
	);
}

/** O que o bot está fazendo durante o run: o avatar pequeno no estado dele e o texto ("Lendo a página", "Pensando…"). */
export function ThinkingLine({ bot, avatar }: { bot: Pick<HomeBot, "id" | "color" | "shape">; avatar: { state: MobileAvatarState; label: string | null } }) {
	const text = avatar.label ?? "Trabalhando…";
	return (
		<View accessibilityRole="text" accessibilityLiveRegion="polite" accessibilityLabel={text} className="min-h-11 flex-row items-center gap-2.5 px-4">
			<Avatar color={resolveColor(bot.color, bot.id)} shape={resolveShape(bot.shape, bot.id)} size={AVATAR_SIZE} state={avatar.state} look={false} />
			<Text variant="muted" numberOfLines={1} className="min-w-0 shrink text-control">
				{text}
			</Text>
		</View>
	);
}

const AVATAR_SIZE = 24;
