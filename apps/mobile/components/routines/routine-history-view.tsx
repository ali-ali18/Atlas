import type { RoutineRecord, RoutineRunRecord } from "@workspace/shared";
import * as React from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ScreenHeader } from "@/components/ui/screen-header";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { routineSurface } from "@/lib/chat-surface";
import { formatRunTime, routineRunLabel } from "@/lib/routine-run";
import { useAppColorScheme } from "@/lib/use-theme";

/** Histórico de execuções de uma rotina: "cron · concluída" (ou o motivo da falha) e a hora de cada uma. */
export function RoutineHistoryView({ routine, runs, loading = false, error = null, onBack }: { routine: Pick<RoutineRecord, "name">; runs: readonly RoutineRunRecord[]; loading?: boolean; error?: string | null; onBack: () => void }) {
	const surface = routineSurface(useAppColorScheme());
	return (
		<SafeAreaView className="flex-1" style={{ backgroundColor: surface.screen }}>
			<ScreenHeader title="Histórico" onBack={onBack} />
			<ScrollView contentContainerClassName="gap-3 px-4 pb-10 pt-4">
				<Text variant="muted" className="px-2 text-base">
					{routine.name}. Execuções recentes, com estado e motivo.
				</Text>
				{loading && runs.length === 0 ? (
					<View className="items-center pt-16">
						<Spinner label="Carregando o histórico" />
					</View>
				) : error && runs.length === 0 ? (
					<Text variant="muted" className="px-2 pt-8 text-center text-control">
						{error}
					</Text>
				) : runs.length === 0 ? (
					<Text variant="muted" className="px-2 pt-8 text-center text-control">
						Nenhuma execução ainda.
					</Text>
				) : (
					<View style={{ borderWidth: 1, borderColor: surface.edge, backgroundColor: surface.card, borderRadius: 21, overflow: "hidden" }}>
						{runs.map((run, index) => (
							<View key={run.id} className="flex-row items-start justify-between gap-4 px-5 py-4" style={index > 0 ? { borderTopWidth: 1, borderTopColor: surface.edge } : undefined}>
								<Text className="min-w-0 flex-1 text-base">{routineRunLabel(run)}</Text>
								<Text variant="muted" className="text-base">
									{formatRunTime(run.startedAt ?? run.createdAt)}
								</Text>
							</View>
						))}
					</View>
				)}
			</ScrollView>
		</SafeAreaView>
	);
}
