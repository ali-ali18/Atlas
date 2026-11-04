import * as React from "react";
import { FlatList, KeyboardAvoidingView, Pressable, View } from "react-native";
import { CatalogRowView, CatalogSearchBar, CategoryFilters, CloseButton, ListRow, SectionHeader } from "@/components/catalog/catalog-parts";
import { Button } from "@/components/ui/button";
import { ChromePill } from "@/components/ui/chrome-pill";
import { ScreenFrame } from "@/components/ui/screen-frame";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { type AppItem, type AppsRow, type Chip, connectedCountText } from "@/lib/apps";
import { AppActionButton } from "./app-action-button";
import { AppIcon } from "./app-icon";

/** Uma linha de aplicativo: logo, nome, descrição e o botão. Linha e botão levam ao detalhe, onde a conexão de fato começa. */
export function AppRowView({ item, onOpen }: { item: AppItem; onOpen: () => void }) {
	return <ListRow icon={<AppIcon src={item.icon} name={item.name} />} name={item.name} description={item.description} onOpen={onOpen} action={<AppActionButton action={item.action} name={item.name} onPress={onOpen} />} />;
}

export type AppsLoad = { status: "loading" } | { status: "error"; message: string } | { status: "ready" };

export type AppsViewProps = {
	load: AppsLoad;
	rows: AppsRow[];
	chips: readonly Chip[];
	chip: string;
	onChip: (id: string) => void;
	query: string;
	onQuery: (value: string) => void;
	connectedCount: number;
	installed: ReadonlySet<string>;
	/** O Composio ainda está carregando (nada na lista, mas não é "vazio"). */
	composioLoading: boolean;
	onOpenConnected: () => void;
	onClose: () => void;
	onOpenApp: (item: AppItem) => void;
	onOpenBot: (slug: string) => void;
	onMore: (target: "composio" | "bots") => void;
	/** Rolou até o fim: puxa a próxima página do Composio (quem chama decide se há). */
	onEndReached: () => void;
	/** O dedo arrastou/rolou a lista: libera a próxima página automática. */
	onUserScroll: () => void;
	onRetry: () => void;
	/** DIAGNÓSTICO TEMPORÁRIO: segurar o título abre o registro da última vez. */
	onTitleLongPress?: () => void;
};

/**
 * "Aplicativos", como a tela "Conectar aplicativos" do Grok/ChatGPT: X, título e a pílula "N conectados" no topo; chips
 * de categoria rolando de lado; as seções (Conectados, Em destaque, categorias, Apps, Bots) e a busca fixa embaixo.
 */
export function AppsView(props: AppsViewProps) {
	const { load, rows, chips, chip, onChip, query, onQuery, connectedCount, installed, composioLoading, onOpenConnected, onClose, onOpenApp, onOpenBot, onMore, onEndReached, onUserScroll, onRetry, onTitleLongPress } = props;
	const renderItem = React.useCallback(
		({ item: row }: { item: AppsRow }) => {
			switch (row.kind) {
				case "header":
					return <SectionHeader label={row.label} />;
				case "app":
					return <AppRowView item={row.item} onOpen={() => onOpenApp(row.item)} />;
				case "bot":
					return <CatalogRowView bot={row.bot} installed={installed.has(row.bot.slug)} onOpen={() => onOpenBot(row.bot.slug)} />;
				case "note":
					return (
						<View className="items-start gap-3 px-5 py-2">
							<Text variant="muted" className="text-control">
								{row.text}
							</Text>
							{row.retry ? (
								<Button size="sm" variant="secondary" onPress={onRetry}>
									<Text>Tentar de novo</Text>
								</Button>
							) : null}
						</View>
					);
				case "more":
					return (
						<View className="items-start px-5 py-2">
							<Button size="sm" variant="secondary" disabled={row.loading} accessibilityLabel={row.label} onPress={() => onMore(row.target)}>
								{row.loading ? <Spinner /> : null}
								<Text>{row.label}</Text>
							</Button>
						</View>
					);
				case "autoload":
					return <View className="h-14 items-center justify-center">{row.loading ? <Spinner label="Carregando mais apps" /> : null}</View>;
				case "empty":
					return (
						<Text variant="muted" className="text-control px-8 pt-24 text-center">
							{row.text}
						</Text>
					);
			}
		},
		[installed, onOpenApp, onOpenBot, onMore, onRetry],
	);

	let footer: React.ReactElement | undefined;
	let empty: React.ReactElement | undefined;
	if (load.status === "loading") {
		empty = (
			<View className="items-center pt-24">
				<Spinner size="large" label="Carregando os aplicativos" />
			</View>
		);
	} else if (load.status === "error") {
		empty = (
			<View className="items-center gap-4 px-8 pt-24">
				<Text variant="muted" className="text-control text-center">
					{load.message}
				</Text>
				<Button variant="secondary" onPress={onRetry}>
					<Text>Tentar de novo</Text>
				</Button>
			</View>
		);
	} else if (composioLoading) {
		footer = (
			<View className="items-center py-6">
				<Spinner label="Carregando apps" />
			</View>
		);
	}
	const ready = load.status === "ready";
	return (
		<ScreenFrame>
			<KeyboardAvoidingView behavior="padding" className="flex-1">
				<View className="flex-row items-center gap-3 px-4 pt-1.5">
					<CloseButton onPress={onClose} />
					<Pressable className="flex-1" onLongPress={onTitleLongPress} delayLongPress={600} accessible={false}>
						<Text accessibilityRole="header" className="text-lg font-semibold">
							Aplicativos
						</Text>
					</Pressable>
					{ready && connectedCount > 0 ? (
						<ChromePill height={36} className="px-3.5" onPress={onOpenConnected} label={`${connectedCountText(connectedCount)}. Ver seus aplicativos`}>
							<Text className="text-control font-medium">{connectedCountText(connectedCount)}</Text>
						</ChromePill>
					) : null}
				</View>
				{ready ? <CategoryFilters categories={chips} value={chip} onChange={onChip} /> : null}
				<FlatList
					data={ready ? rows : []}
					keyExtractor={(row) => row.key}
					renderItem={renderItem}
					ListEmptyComponent={empty}
					ListFooterComponent={footer}
					style={{ flex: 1 }}
					contentContainerStyle={{ paddingBottom: 16 }}
					keyboardShouldPersistTaps="handled"
					keyboardDismissMode="on-drag"
					onEndReached={onEndReached}
					onEndReachedThreshold={0.6}
					onScrollBeginDrag={onUserScroll}
					onMomentumScrollBegin={onUserScroll}
					initialNumToRender={14}
					maxToRenderPerBatch={10}
					windowSize={7}
					removeClippedSubviews
				/>
				<CatalogSearchBar query={query} onChange={onQuery} placeholder="Buscar aplicativos e bots" />
			</KeyboardAvoidingView>
		</ScreenFrame>
	);
}
