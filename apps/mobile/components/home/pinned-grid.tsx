import type { HomeBot } from "@/lib/home-types";
import * as React from "react";
import { Pressable, View } from "react-native";
import { Text } from "@/components/ui/text";
import { BotAvatar, PrimaryBadge } from "./bot-avatar";

const BODY = 86;

/**
 * Bots fixados em grade de 3 colunas. A última linha fica centralizada (como na referência do dono):
 * um bot sozinho cai no meio. O toque abre o chat do bot.
 */
export function PinnedGrid({ pinned, bots, onOpen }: { pinned: readonly HomeBot[]; bots: readonly HomeBot[]; onOpen: (bot: HomeBot) => void }) {
	if (pinned.length === 0) return null;
	return (
		<View className="flex-row flex-wrap justify-center px-3 pb-2 pt-4">
			{pinned.map((bot) => (
				<Pressable
					key={bot.id}
					role="button"
					accessibilityLabel={bot.isPrimary ? `${bot.name}, bot principal` : bot.name}
					onPress={() => onOpen(bot)}
					className="items-center px-1 pb-5 active:opacity-70"
					style={{ width: "33.3333%" }}
				>
					<View style={{ width: BODY + 8, height: BODY + 8, alignItems: "center", justifyContent: "center" }}>
						<BotAvatar bot={bot} bots={bots} body={BODY} />
						{bot.isPrimary ? <PrimaryBadge /> : null}
					</View>
					<Text numberOfLines={1} ellipsizeMode="tail" className="mt-2 max-w-full text-center text-control">
						{bot.name}
					</Text>
				</Pressable>
			))}
		</View>
	);
}
