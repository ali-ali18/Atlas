import * as React from "react";
import { Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CheckCircleIcon, ChevronRightIcon, CirclePauseIcon, CircleStopIcon, CircleXIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ScreenHeader } from "@/components/ui/screen-header";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { routineSurface } from "@/lib/chat-surface";
import { type ExecutionEntry, type ExecutionState, executionStateLabel } from "@/lib/executions";
import { useAppColorScheme } from "@/lib/use-theme";

function StateIcon({ state }: { state: ExecutionState | null }) {
	switch (state) {
		case "done":
			return <CheckCircleIcon size={26} tone="muted-foreground" />;
		case "error":
			return <CircleXIcon size={26} tone="destructive" />;
		case "stopped":
			return <CircleStopIcon size={26} />;
		case "waiting":
			return <CirclePauseIcon size={26} />;
		case "running":
			return <Spinner label="Em andamento" />;
		default:
			return <CheckCircleIcon size={26} />;
	}
}

export type ExecutionsListViewProps = {
	entries: readonly ExecutionEntry[];
	loading?: boolean;
	error?: string | null;
	hasMore?: boolean;
	loadingMore?: boolean;
	onBack: () => void;
	onOpen: (entry: ExecutionEntry) => void;
	onMore?: () => void;
	onRetry?: () => void;
};

/**
 * Execuções do bot, no padrão do Grok: título centralizado e um cartão único com uma linha por execução (ícone de estado,
 * título, estado embaixo em cinza e a seta que abre o Registro), da mais nova para a mais antiga, divisor de ponta a ponta.
 * "Ver mais" busca as antigas.
 */
export function ExecutionsListView({ entries, loading = false, error = null, hasMore = false, loadingMore = false, onBack, onOpen, onMore, onRetry }: ExecutionsListViewProps) {
	const surface = routineSurface(useAppColorScheme());
	let body: React.ReactNode;
	if (loading && entries.length === 0) {
		body = (
			<View className="items-center pt-24">
				<Spinner label="Carregando as execuções" />
			</View>
		);
	} else if (error && entries.length === 0) {
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
	} else if (entries.length === 0) {
		body = (
			<Text variant="muted" className="px-2 pt-8 text-center text-control">
				Quando o bot trabalhar em algo de vários passos, você acompanha por aqui.
			</Text>
		);
	} else {
		body = (
			<>
				{error ? <Text className="px-2 text-body text-destructive">{error}</Text> : null}
				<View style={{ borderWidth: 1, borderColor: surface.edge, backgroundColor: surface.card, borderRadius: 21, overflow: "hidden" }}>
					{entries.map((entry, index) => (
						<Pressable key={entry.runId} role="button" accessibilityLabel={`${entry.title}${entry.state ? `. ${executionStateLabel(entry.state)}` : ""}`} onPress={() => onOpen(entry)} className="flex-row items-center gap-4 px-5 py-4 active:opacity-80" style={index > 0 ? { borderTopWidth: 1, borderTopColor: surface.edge } : undefined}>
							<View className="size-8 items-center justify-center">
								<StateIcon state={entry.state} />
							</View>
							<View className="min-w-0 flex-1">
								<Text numberOfLines={2} className="text-lg">
									{entry.title}
								</Text>
								{entry.state ? (
									<Text variant="muted" className="text-base">
										{executionStateLabel(entry.state)}
									</Text>
								) : null}
							</View>
							<ChevronRightIcon size={22} />
						</Pressable>
					))}
				</View>
				{hasMore && onMore ? (
					<Button variant="secondary" className="w-full" disabled={loadingMore} onPress={onMore}>
						{loadingMore ? <Spinner label="Carregando" /> : <Text>Ver mais</Text>}
					</Button>
				) : null}
			</>
		);
	}
	return (
		<SafeAreaView className="flex-1" style={{ backgroundColor: surface.screen }}>
			<ScreenHeader title="Execuções" onBack={onBack} />
			<ScrollView contentContainerClassName="gap-3 px-4 pb-10 pt-6">{body}</ScrollView>
		</SafeAreaView>
	);
}
