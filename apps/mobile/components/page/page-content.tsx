import * as WebBrowser from "expo-web-browser";
import * as React from "react";
import { Pressable, View } from "react-native";
import { ExternalLinkIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import type { PageData } from "@/lib/page-api";
import { pageStatusLine, sourceCountLabel } from "@/lib/page-format";
import type { PageState } from "@/lib/page-state";
import { pageSurface } from "@/lib/page-surface";
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

/**
 * Conteúdo de um painel (título grande, descrição, "Atualizado há…", blocos e fontes; ou carregando/erro), sem o
 * recipiente: a tela cheia (`PageScreen`) e a folha sobre o chat (`ViewerSheet`) usam o mesmo corpo.
 */
export function PageContent({ state, fallbackTitle, onBack, onRetry }: { state: PageState; fallbackTitle?: string; onBack: () => void; onRetry: () => void }) {
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
	return state.status === "ready" ? (
		body
	) : (
		<View className="gap-6">
			<Text accessibilityRole="header" className="text-2xl font-semibold tracking-tight" style={{ lineHeight: 32 }}>
				{title}
			</Text>
			{body}
		</View>
	);
}
