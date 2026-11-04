import * as React from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaView } from "react-native-safe-area-context";
import { RoundButton } from "@/components/chat/chat-top-bar";
import { CloseIcon, ExternalLinkIcon } from "@/components/icons";
import type { PageState } from "@/lib/page-state";
import { pageSurface } from "@/lib/page-surface";
import { themeColor } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";
import { PageContent } from "./page-content";

export type PageScreenProps = {
	state: PageState;
	/** Título provisório (do cartão do chat) enquanto o painel carrega. */
	fallbackTitle?: string;
	onBack: () => void;
	onRefresh: () => void;
	onRetry: () => void;
	/** Compartilhar o painel: o botão da ponta direita só aparece se houver ação (hoje o app não tem link público do painel). */
	onShare?: () => void;
};

/**
 * Tela de um painel no estilo do web (print do dono): fundo escuro, botão redondo X à esquerda (e compartilhar à
 * direita, se houver ação), título grande, descrição cinza, "Atualizado há…" discreto e bastante ar vertical entre os
 * blocos. Carregando, erro e puxar para atualizar. O `GestureHandlerRootView` é dos gráficos (toque para ver o valor).
 */
export function PageScreen({ state, fallbackTitle, onBack, onRefresh, onRetry, onShare }: PageScreenProps) {
	const scheme = useAppColorScheme();
	const surface = pageSurface(scheme);
	const title = state.status === "ready" ? state.page.title : (fallbackTitle ?? "Painel");
	const refreshing = state.status === "ready" && state.refreshing;
	return (
		<GestureHandlerRootView style={{ flex: 1 }}>
			<SafeAreaView className="flex-1" style={{ backgroundColor: surface.screen }}>
				<View className="z-10 flex-row items-center justify-between px-5 pb-2 pt-1.5" accessibilityLabel={title} style={{ backgroundColor: surface.screen }}>
					<RoundButton label="Fechar" onPress={onBack}>
						<CloseIcon size={20} tone="foreground" />
					</RoundButton>
					{onShare ? (
						<RoundButton label="Compartilhar painel" onPress={onShare}>
							<ExternalLinkIcon size={20} tone="foreground" />
						</RoundButton>
					) : null}
				</View>
				<ScrollView
					contentContainerClassName="px-5 pb-20 pt-5"
					refreshControl={state.status === "ready" ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={themeColor(scheme, "muted-foreground")} /> : undefined}
				>
					<PageContent state={state} fallbackTitle={fallbackTitle} onBack={onBack} onRetry={onRetry} />
				</ScrollView>
			</SafeAreaView>
		</GestureHandlerRootView>
	);
}
