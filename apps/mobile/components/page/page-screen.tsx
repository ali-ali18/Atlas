import * as WebBrowser from "expo-web-browser";
import * as React from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaView } from "react-native-safe-area-context";
import { RoundButton } from "@/components/chat/chat-top-bar";
import { CloseIcon, ExternalLinkIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import type { PageData } from "@/lib/page-api";
import { pageStatusLine, sourceCountLabel } from "@/lib/page-format";
import type { PageState } from "@/lib/page-state";
import { pageSurface } from "@/lib/page-surface";
import { themeColor } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";
import { PageView } from "./page-view";

/** Hora de referência de "Atualizado há…": refaz a conta a cada minuto sem refazer o painel. */
function useNow(intervalMs = 60_000): number {
	const [now, setNow] = React.useState(() => Date.now());
	React.useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(id);
	}, [intervalMs]);
	return now;
}

const openUrl = (url: string) => void WebBrowser.openBrowserAsync(url).catch(() => undefined);

/** Fontes do painel no fim da tela: com endereço (http/https, já validado) abrem no navegador; sem, só o título. */
function Sources({ sources }: { sources: PageData["sources"] }) {
	const scheme = useAppColorScheme();
	const surface = pageSurface(scheme);
	const label = sourceCountLabel(sources.length);
	if (!label) return null;
	return (
		<View className="gap-3">
			<Text accessibilityRole="header" className="text-xl font-semibold tracking-tight">
				Fontes
			</Text>
			<View className="overflow-hidden" style={{ borderRadius: 10, borderWidth: 1, borderColor: surface.edge }}>
				{sources.map((source, index) => {
					const row = (
						<View className="min-w-0 flex-row items-center gap-3 px-3.5 py-3" style={index > 0 ? { borderTopWidth: 1, borderTopColor: surface.edge } : undefined}>
							<Text className="min-w-0 flex-1 text-control" numberOfLines={2}>
								{source.title}
							</Text>
							{source.url ? <ExternalLinkIcon /> : null}
						</View>
					);
					return source.url ? (
						<Pressable key={`${source.title}-${index}`} role="link" accessibilityLabel={`${source.title}. Abrir no navegador`} onPress={() => openUrl(source.url!)} className="active:opacity-70">
							{row}
						</Pressable>
					) : (
						<View key={`${source.title}-${index}`}>{row}</View>
					);
				})}
			</View>
		</View>
	);
}

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
	const now = useNow();
	const title = state.status === "ready" ? state.page.title : (fallbackTitle ?? "Painel");
	let body: React.ReactNode;
	if (state.status === "loading") {
		body = (
			<View className="items-center pt-24">
				<Spinner label="Carregando painel" />
			</View>
		);
	} else if (state.status === "error") {
		body = (
			<View className="items-center gap-4 px-8 pt-24">
				<Text variant="muted" className="text-center text-control">
					{state.message}
				</Text>
				{state.retryable ? (
					<Button variant="secondary" onPress={onRetry}>
						<Text>Tentar de novo</Text>
					</Button>
				) : (
					<Button variant="secondary" onPress={onBack}>
						<Text>Voltar</Text>
					</Button>
				)}
			</View>
		);
	} else {
		const status = pageStatusLine(state.refreshError, state.page.updatedAt, now);
		body = (
			<View style={{ gap: 36 }}>
				<View className="gap-2">
					<Text accessibilityRole="header" className="text-2xl font-semibold tracking-tight" style={{ lineHeight: 32 }}>
						{state.page.title}
					</Text>
					{state.page.spec.summary ? (
						<Text className="text-control" style={{ color: surface.muted }}>
							{state.page.spec.summary}
						</Text>
					) : null}
					{status ? (
						<Text className="text-caption" style={{ color: surface.muted, opacity: 0.8 }}>
							{status}
						</Text>
					) : null}
				</View>
				<PageView spec={state.page.spec} />
				<Sources sources={state.page.sources} />
			</View>
		);
	}
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
					{state.status === "ready" ? body : <View className="gap-6"><Text accessibilityRole="header" className="text-2xl font-semibold tracking-tight" style={{ lineHeight: 32 }}>{title}</Text>{body}</View>}
				</ScrollView>
			</SafeAreaView>
		</GestureHandlerRootView>
	);
}
