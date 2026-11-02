import { resolveColor, resolveShape } from "@workspace/shared/avatar/identity";
import * as React from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronLeftIcon, DotsIcon } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { Text } from "@/components/ui/text";
import type { MobileAvatarState } from "@/lib/avatar-activity";
import type { HomeBot } from "@/lib/home-types";
import { chatChrome } from "@/lib/chat-surface";
import { useAppColorScheme } from "@/lib/use-theme";

/** Altura do topo flutuante (sem a área segura): a lista deixa esse espaço para as mensagens passarem por baixo. */
export const TOP_BAR_HEIGHT = 47 + 12;
/** Altura dos botões e da pílula do topo (47 dp, medido no print do Grok) e margem lateral (19,5). */
export const TOP_BAR_CONTROL = 47;
export const TOP_BAR_SIDE = 19.5;
const CONTROL = TOP_BAR_CONTROL;
const SIDE = TOP_BAR_SIDE;

/** Botão redondo do topo (voltar, menu): fundo do cartão e borda, como na referência. */
export function RoundButton({ label, onPress, children }: { label: string; onPress: () => void; children: React.ReactNode }) {
	const chrome = chatChrome(useAppColorScheme());
	return (
		<Pressable role="button" accessibilityLabel={label} onPress={onPress} style={{ width: CONTROL, height: CONTROL, borderColor: chrome.edge, backgroundColor: chrome.fill }} className="items-center justify-center rounded-full border active:opacity-70">
			{children}
		</Pressable>
	);
}

/**
 * Topo flutuante sobre as mensagens: voltar à esquerda, a pílula com o avatar do bot (vivo, só aqui) e o nome, e o
 * menu "…" à direita. O avatar muda de estado com o que o bot faz (repouso fora de um run). Fica por cima da lista (posição absoluta), sem barra de fundo.
 */
export function ChatTopBar({ bot, avatarState = "idle", onBack, onMenu, onProfile }: { bot: HomeBot; avatarState?: MobileAvatarState; onBack: () => void; onMenu: () => void; onProfile: () => void }) {
	const insets = useSafeAreaInsets();
	const chrome = chatChrome(useAppColorScheme());
	return (
		<View pointerEvents="box-none" style={{ position: "absolute", top: insets.top + 6, left: SIDE, right: SIDE }} className="flex-row items-center gap-2">
			<RoundButton label="Voltar" onPress={onBack}>
				<ChevronLeftIcon />
			</RoundButton>
			<Pressable role="button" accessibilityLabel={`Ver perfil de ${bot.name}`} onPress={onProfile} style={{ height: CONTROL, borderColor: chrome.edge, backgroundColor: chrome.fill }} className="min-w-0 shrink flex-row items-center gap-2 rounded-full border pl-2.5 pr-4 active:opacity-80">
				<Avatar color={resolveColor(bot.color, bot.id)} shape={resolveShape(bot.shape, bot.id)} size={32} animated look state={avatarState} eyeColor={chrome.fill} />
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
