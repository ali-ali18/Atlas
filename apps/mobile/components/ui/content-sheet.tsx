import * as React from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { RoundButton } from "@/components/chat/chat-top-bar";
import { CloseIcon, ShareIcon } from "@/components/icons";
import { DraggableSheet } from "@/components/ui/draggable-sheet";
import { Text } from "@/components/ui/text";
import { pageSurface } from "@/lib/page-surface";
import { useAppColorScheme } from "@/lib/use-theme";

type Props = {
	visible: boolean;
	onClose: () => void;
	/** Nome ao lado do X (documento). Painel não passa: o título grande fica no corpo. */
	title?: string;
	/** Botão redondo de compartilhar à direita; sem ação, o botão não aparece. */
	onShare?: () => void;
	shareLabel?: string;
	children: React.ReactNode;
};

/**
 * Folha de conteúdo (painel, documento): sobe de baixo POR CIMA do chat, quase na tela toda, com a conversa escurecida
 * numa faixa no topo. É o `DraggableSheet` do menu da mensagem em altura cheia: arrastar a alça ou o cabeçalho para
 * baixo fecha, toque no fundo escuro fecha, Voltar do Android fecha; o corpo rola sem brigar com o arraste.
 * Cabeçalho: X redondo à esquerda, nome (opcional) e compartilhar redondo à direita, os mesmos botões do topo do chat.
 */
export function ContentSheet({ visible, onClose, title, onShare, shareLabel = "Compartilhar", children }: Props) {
	const surface = pageSurface(useAppColorScheme());
	return (
		<DraggableSheet
			visible={visible}
			onClose={onClose}
			fullHeight
			backgroundColor={surface.screen}
			bodyPadding={20}
			header={
				<View className="flex-row items-center gap-3 pb-1">
					<RoundButton label="Fechar" onPress={onClose}>
						<CloseIcon size={20} tone="foreground" />
					</RoundButton>
					{title ? (
						<Text accessibilityRole="header" numberOfLines={1} ellipsizeMode="middle" className="min-w-0 flex-1 text-lg font-semibold">
							{title}
						</Text>
					) : (
						<View className="flex-1" />
					)}
					{onShare ? (
						<RoundButton label={shareLabel} onPress={onShare}>
							<ShareIcon size={20} tone="foreground" />
						</RoundButton>
					) : null}
				</View>
			}
		>
			{/* Os gráficos do painel usam gestos; dentro de um Modal do Android o gesto precisa da própria raiz. */}
			<GestureHandlerRootView style={{ width: "100%" }}>{children}</GestureHandlerRootView>
		</DraggableSheet>
	);
}
