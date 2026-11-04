import type { RoutineRecord, RoutineRunRecord } from "@workspace/shared";
import * as React from "react";
import { ScrollView, View } from "react-native";
import { ScreenFrame } from "@/components/ui/screen-frame";
import { ScreenHeader } from "@/components/ui/screen-header";
import { Spinner } from "@/components/ui/spinner";
import { SurfaceGroup } from "@/components/ui/surface-card";
import { Text } from "@/components/ui/text";
import { formatRunTime, routineRunLabel } from "@/lib/routine-run";

/** Histórico de execuções de uma rotina: "cron · concluída" (ou o motivo da falha) e a hora de cada uma. */
export function RoutineHistoryView({ routine, runs, loading = false, error = null, onBack }: { routine: Pick<RoutineRecord, "name">; runs: readonly RoutineRunRecord[]; loading?: boolean; error?: string | null; onBack: () => void }) {
	return (
		<ScreenFrame>
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
					<SurfaceGroup>
						{runs.map((run) => (
							<View key={run.id} className="flex-row items-start justify-between gap-4 px-5 py-4">
								<Text className="min-w-0 flex-1 text-base">{routineRunLabel(run)}</Text>
								<Text variant="muted" className="text-base">
									{formatRunTime(run.startedAt ?? run.createdAt)}
								</Text>
							</View>
						))}
					</SurfaceGroup>
				)}
			</ScrollView>
		</ScreenFrame>
	);
}
