import { resolveColor, resolveShape } from "@workspace/shared/avatar/identity";
import * as React from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronLeftIcon, DotsIcon } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { Text } from "@/components/ui/text";
import type { HomeBot } from "@/lib/home-types";

/** Altura do topo flutuante (sem a área segura): a lista deixa esse espaço para as mensagens passarem por baixo. */
export const TOP_BAR_HEIGHT = 44 + 12;

/** Botão redondo do topo (voltar, menu): fundo do cartão e borda, como na referência. */
export function RoundButton({ label, onPress, children }: { label: string; onPress: () => void; children: React.ReactNode }) {
	return (
		<Pressable role="button" accessibilityLabel={label} onPress={onPress} className="size-11 items-center justify-center rounded-full border border-border bg-card/95 active:opacity-70">
			{children}
		</Pressable>
	);
}

/**
 * Topo flutuante sobre as mensagens: voltar à esquerda, a pílula com o avatar do bot (vivo, só aqui) e o nome, e o
 * menu "…" à direita. Fica por cima da lista (posição absoluta), sem barra de fundo.
 */
export function ChatTopBar({ bot, onBack, onMenu, onProfile }: { bot: HomeBot; onBack: () => void; onMenu: () => void; onProfile: () => void }) {
	const insets = useSafeAreaInsets();
	return (
		<View pointerEvents="box-none" style={{ position: "absolute", top: insets.top + 6, left: 16, right: 16 }} className="flex-row items-center gap-2">
			<RoundButton label="Voltar" onPress={onBack}>
				<ChevronLeftIcon />
			</RoundButton>
			<Pressable role="button" accessibilityLabel={`Ver perfil de ${bot.name}`} onPress={onProfile} className="h-11 min-w-0 shrink flex-row items-center gap-2 rounded-full border border-border bg-card/95 pl-2.5 pr-4 active:opacity-80">
				<Avatar color={resolveColor(bot.color, bot.id)} shape={resolveShape(bot.shape, bot.id)} size={32} animated look />
				<Text numberOfLines={1} className="min-w-0 shrink text-control font-semibold">
					{bot.name}
				</Text>
			</Pressable>
			<View className="flex-1" />
			<RoundButton label="Mais opções" onPress={onMenu}>
				<DotsIcon />
			</RoundButton>
		</View>
	);
}
