import * as WebBrowser from "expo-web-browser";
import * as React from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ExternalLinkIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ScreenHeader } from "@/components/ui/screen-header";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { routineSurface } from "@/lib/chat-surface";
import type { PageData } from "@/lib/page-api";
import { pageStatusLine, sourceCountLabel } from "@/lib/page-format";
import type { PageState } from "@/lib/page-state";
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
	const surface = routineSurface(scheme);
	const label = sourceCountLabel(sources.length);
	if (!label) return null;
	return (
		<View className="gap-2 pt-2">
			<Text accessibilityRole="header" variant="heading">
				Fontes
			</Text>
			<View className="overflow-hidden rounded-card" style={{ backgroundColor: surface.card, borderWidth: 1, borderColor: surface.edge }}>
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
	/** Abre o chat do bot no navegador (gráfico completo), se houver endereço. */
	onOpenWeb?: () => void;
};

/** Tela de um painel: topo com voltar e título, "Atualizado há…", o painel, as fontes; carregando, erro e puxar para atualizar. */
export function PageScreen({ state, fallbackTitle, onBack, onRefresh, onRetry, onOpenWeb }: PageScreenProps) {
	const scheme = useAppColorScheme();
	const surface = routineSurface(scheme);
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
			<View className="gap-4">
				{status ? (
					<Text variant="muted" className="text-caption">
						{status}
					</Text>
				) : null}
				{state.page.spec.summary ? <Text variant="muted" className="text-control">{state.page.spec.summary}</Text> : null}
				<PageView spec={state.page.spec} onOpenWeb={onOpenWeb} />
				<Sources sources={state.page.sources} />
			</View>
		);
	}
	const refreshing = state.status === "ready" && state.refreshing;
	return (
		<SafeAreaView className="flex-1" style={{ backgroundColor: surface.screen }}>
			<ScreenHeader title={title} onBack={onBack} />
			<ScrollView
				contentContainerClassName="px-4 pb-12 pt-4"
				refreshControl={state.status === "ready" ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={themeColor(scheme, "muted-foreground")} /> : undefined}
			>
				{body}
			</ScrollView>
		</SafeAreaView>
	);
}
