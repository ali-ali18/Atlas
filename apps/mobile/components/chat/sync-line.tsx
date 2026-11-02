import * as React from "react";
import { View } from "react-native";
import { Text } from "@/components/ui/text";
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

/** O que o bot está fazendo durante o run: bolinhas e "Pensando…" / "Trabalhando…". */
export function ThinkingLine({ color, working }: { color: string; working: boolean }) {
	return (
		<View accessibilityRole="text" accessibilityLabel={working ? "Trabalhando" : "Pensando"} className="min-h-11 flex-row items-center gap-3 px-5">
			<BotDots color={color} />
			<Text variant="muted" className="text-control">
				{working ? "Trabalhando…" : "Pensando…"}
			</Text>
		</View>
	);
}
