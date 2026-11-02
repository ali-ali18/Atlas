import * as React from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { ScreenHeader } from "@/components/ui/screen-header";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { routineSurface } from "@/lib/chat-surface";
import { groupLibraryItems } from "@/lib/library-groups";
import type { LibraryItem } from "@/lib/library-items";
import { useAppColorScheme } from "@/lib/use-theme";
import { LibraryGroup } from "./library-group";

export type LibraryViewProps = {
	/** Já misturados e ordenados do mais novo ao mais velho (`mergeLibraryItems`). */
	items: readonly LibraryItem[];
	/** Injetado (a tela passa o relógio; os testes e a prévia passam uma data fixa). */
	now: Date;
	loading?: boolean;
	loadingMore?: boolean;
	hasMore?: boolean;
	/** Frase de erro já amigável, ou null. */
	error?: string | null;
	onBack: () => void;
	onOpen: (item: LibraryItem) => void;
	onRetry?: () => void;
	onLoadMore?: () => void;
};

/**
 * Biblioteca do bot: documentos e painéis agrupados por período, um cartão por grupo. Só desenho e estados (carregando,
 * erro, vazio, "Ver mais"); os dados e as ações vêm de quem chama.
 */
export function LibraryView({ items, now, loading = false, loadingMore = false, hasMore = false, error = null, onBack, onOpen, onRetry, onLoadMore }: LibraryViewProps) {
	const surface = routineSurface(useAppColorScheme());
	const groups = React.useMemo(() => groupLibraryItems(items, now), [items, now]);
	let body: React.ReactNode;
	if (loading && items.length === 0) {
		body = (
			<View className="items-center pt-24">
				<Spinner label="Carregando a Biblioteca" />
			</View>
		);
	} else if (error && items.length === 0) {
		body = (
			<View className="items-center gap-4 px-8 pt-24">
				<Text variant="muted" className="text-center text-control">
					{error}
				</Text>
				{onRetry ? (
					<Button variant="secondary" onPress={onRetry}>
						<Text>Tentar de novo</Text>
					</Button>
				) : null}
			</View>
		);
	} else if (groups.length === 0) {
		body = (
			<View className="items-center px-8 pt-24">
				<Text variant="muted" className="text-center text-control">
					Nada na Biblioteca ainda. Peça ao bot para criar um documento ou um painel.
				</Text>
			</View>
		);
	} else {
		body = (
			<>
				{error ? (
					<Text className="px-1 text-caption text-muted-foreground" accessibilityLiveRegion="polite">
						{error}
					</Text>
				) : null}
				{groups.map((group) => (
					<LibraryGroup key={group.key} group={group} now={now} onOpen={onOpen} />
				))}
				{hasMore && onLoadMore ? (
					<Button variant="secondary" className="w-full" disabled={loadingMore} accessibilityLabel={loadingMore ? "Carregando mais" : "Ver mais"} onPress={onLoadMore}>
						{loadingMore ? <Spinner /> : <Text>Ver mais</Text>}
					</Button>
				) : null}
			</>
		);
	}
	return (
		<SafeAreaView className="flex-1" style={{ backgroundColor: surface.screen }}>
			<ScreenHeader title="Biblioteca" onBack={onBack} />
			<ScrollView contentContainerClassName="gap-5 px-4 pb-10 pt-6">{body}</ScrollView>
		</SafeAreaView>
	);
}
