import type { HomeBot } from "@/lib/home-types";
import * as React from "react";
import { Pressable, View } from "react-native";
import { ChevronDownIcon, SendIcon } from "@/components/icons";
import { Text } from "@/components/ui/text";
import { formatListDate, type HomeSection } from "@/lib/home-list";
import { BotAvatar } from "./bot-avatar";

const ROW_BODY = 48;

/** Linha de uma conversa: avatar, título em negrito, data à direita e a prévia da última mensagem. */
export function ConversationRow({ bot, bots, now, onOpen }: { bot: HomeBot; bots: readonly HomeBot[]; now: Date; onOpen: (bot: HomeBot) => void }) {
	const date = formatListDate(bot.lastAt, now);
	const unread = bot.unread;
	return (
		<Pressable role="button" accessibilityLabel={`${bot.name}. ${bot.preview}`} onPress={() => onOpen(bot)} className="min-h-[72px] flex-row items-center gap-3 px-5 py-2 active:bg-muted/60">
			<BotAvatar bot={bot} bots={bots} body={ROW_BODY} />
			<View className="min-w-0 flex-1 gap-0.5">
				<View className="flex-row items-center gap-2">
					<Text numberOfLines={1} ellipsizeMode="tail" className="min-w-0 flex-1 text-control font-bold">
						{bot.name}
					</Text>
					{date ? <Text className="text-body text-muted-foreground">{date}</Text> : null}
				</View>
				<View className="flex-row items-center gap-1.5">
					{bot.previewSent ? <SendIcon size={16} /> : null}
					<Text numberOfLines={1} ellipsizeMode="tail" className={`min-w-0 flex-1 text-control ${unread ? "text-foreground" : "text-muted-foreground"}`}>
						{bot.preview || "Sem mensagens ainda"}
					</Text>
					{unread ? <View accessibilityLabel="Não lida" className="size-2.5 rounded-full bg-info" /> : null}
				</View>
			</View>
		</Pressable>
	);
}

/** Seção recolhível ("Codding ⌄") com as conversas dentro. Recolhida por toque no título. */
export function SectionBlock({
	section,
	bots,
	now,
	open,
	onToggle,
	onOpen,
	showEmpty,
}: {
	section: HomeSection;
	bots: readonly HomeBot[];
	now: Date;
	open: boolean;
	onToggle: () => void;
	onOpen: (bot: HomeBot) => void;
	showEmpty: boolean;
}) {
	return (
		<View>
			<Pressable role="button" accessibilityState={{ expanded: open }} accessibilityLabel={section.title} onPress={onToggle} className="min-h-11 flex-row items-center gap-1.5 self-start px-5 active:opacity-70">
				<Text numberOfLines={1} className="shrink text-control text-muted-foreground">
					{section.title}
				</Text>
				<View style={{ transform: [{ rotate: open ? "0deg" : "-90deg" }] }}>
					<ChevronDownIcon size={20} />
				</View>
			</Pressable>
			{open
				? section.bots.length > 0
					? section.bots.map((bot) => <ConversationRow key={bot.id} bot={bot} bots={bots} now={now} onOpen={onOpen} />)
					: showEmpty
						? <Text className="px-5 pb-3 text-body text-muted-foreground">Nenhuma conversa aqui ainda.</Text>
						: null
				: null}
		</View>
	);
}
