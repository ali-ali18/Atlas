import * as React from "react";
import { FlatList, KeyboardAvoidingView, View } from "react-native";
import { Button } from "@/components/ui/button";
import { ScreenFrame } from "@/components/ui/screen-frame";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { buildCatalogRows, type CatalogBot, type CatalogRow, categoriesOf } from "@/lib/catalog";
import { CatalogRowView, CatalogSearchBar, CategoryFilters, CloseButton, SectionHeader } from "./catalog-parts";

export type CatalogLoad = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; bots: CatalogBot[] };

/** "1 instalado" / "3 instalados". */
export const installedCountText = (count: number): string => `${count} ${count === 1 ? "instalado" : "instalados"}`;

/**
 * Catálogo de bots prontos, como a tela "Conectar aplicativos": X e título no topo (e a contagem do que já tem à
 * direita), filtros em pílulas, seções por categoria com linhas "Instalar" e a busca fixa embaixo.
 */
export function CatalogListView({ load, installed, query, onQuery, category, onCategory, onOpen, onRetry, onClose }: { load: CatalogLoad; installed: ReadonlySet<string>; query: string; onQuery: (value: string) => void; category: string; onCategory: (id: string) => void; onOpen: (slug: string) => void; onRetry: () => void; onClose: () => void }) {
	const bots = load.status === "ready" ? load.bots : null;
	const rows = React.useMemo(() => (bots ? buildCatalogRows(bots, query, category) : []), [bots, query, category]);
	const categories = React.useMemo(() => (bots ? categoriesOf(bots) : []), [bots]);
	const count = bots ? bots.filter((bot) => installed.has(bot.slug)).length : 0;
	const renderItem = React.useCallback(
		({ item }: { item: CatalogRow }) => (item.kind === "header" ? <SectionHeader label={item.label} onPress={() => onCategory(item.category)} /> : <CatalogRowView bot={item.bot} installed={installed.has(item.bot.slug)} onOpen={() => onOpen(item.bot.slug)} />),
		[installed, onCategory, onOpen],
	);
	let empty: React.ReactElement | null = null;
	if (load.status === "loading") {
		empty = (
			<View className="items-center pt-24">
				<Spinner size="large" label="Carregando o catálogo" />
			</View>
		);
	} else if (load.status === "error") {
		empty = (
			<View className="items-center gap-4 px-8 pt-24">
				<Text variant="muted" className="text-center text-control">
					{load.message}
				</Text>
				<Button variant="secondary" onPress={onRetry}>
					<Text>Tentar de novo</Text>
				</Button>
			</View>
		);
	} else if (rows.length === 0) {
		empty = (
			<Text variant="muted" className="px-8 pt-24 text-center text-control">
				{query.trim() ? `Nada encontrado para “${query.trim()}”.` : "Nenhum bot no catálogo ainda."}
			</Text>
		);
	}
	return (
		<ScreenFrame>
			<KeyboardAvoidingView behavior="padding" className="flex-1">
				<View className="flex-row items-center gap-3 px-4 pt-1.5">
					<CloseButton onPress={onClose} />
					<Text accessibilityRole="header" className="flex-1 text-lg font-semibold">
						Bots prontos
					</Text>
					{count > 0 ? (
						<View className="h-9 items-center justify-center rounded-full bg-secondary px-3.5">
							<Text className="text-control font-medium">{installedCountText(count)}</Text>
						</View>
					) : null}
				</View>
				{bots && categories.length > 0 ? <CategoryFilters categories={categories} value={category} onChange={onCategory} /> : null}
				<FlatList data={rows} keyExtractor={(row) => row.key} renderItem={renderItem} ListEmptyComponent={empty ?? undefined} style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 16 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" />
				<CatalogSearchBar query={query} onChange={onQuery} />
			</KeyboardAvoidingView>
		</ScreenFrame>
	);
}
