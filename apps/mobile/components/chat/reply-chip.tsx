import * as React from "react";
import { Pressable, View } from "react-native";
import { CloseIcon, ReplyIcon } from "@/components/icons";
import { Text } from "@/components/ui/text";
import type { ReplyQuote } from "@/lib/chat-types";

/** Citação em andamento, dentro do container do campo de digitar (acima do input): o trecho em 1 linha e um X para cancelar. */
export function ReplyChip({ quote, onCancel }: { quote: ReplyQuote; onCancel: () => void }) {
	return (
		<View className="px-2 pt-2">
			<View className="flex-row items-center gap-2 rounded-full border border-border py-1 pl-3 pr-1">
				<ReplyIcon size={14} tone="muted-foreground" />
				<Text numberOfLines={1} ellipsizeMode="tail" variant="caption" className="flex-1">
					{quote.text}
				</Text>
				<Pressable role="button" accessibilityLabel="Cancelar resposta" onPress={onCancel} hitSlop={8} className="size-7 items-center justify-center rounded-full active:bg-foreground/10">
					<CloseIcon size={14} />
				</Pressable>
			</View>
		</View>
	);
}
