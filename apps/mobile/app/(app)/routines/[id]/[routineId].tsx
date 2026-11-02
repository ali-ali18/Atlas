import { useLocalSearchParams, useRouter } from "expo-router";
import * as React from "react";
import { RoutineDetailView } from "@/components/routines/routine-detail-view";
import { RoutinesView } from "@/components/routines/routines-view";
import { useAtlasSession } from "@/lib/atlas-session";
import { useRoutines } from "@/lib/routines-store";
import { editRoutineDraft, useBotAccent } from "@/lib/use-bot-accent";

/** Detalhes de uma rotina (`id` = bot, `routineId` = rotina), do mesmo estado da lista. */
export default function RoutineDetailScreen() {
	const router = useRouter();
	const { id, routineId } = useLocalSearchParams<{ id: string; routineId: string }>();
	const { apiFetch } = useAtlasSession();
	const state = useRoutines(apiFetch, id);
	const { accent } = useBotAccent(id);
	const routine = state.routines.find((item) => item.id === routineId);
	const goBack = () => (router.canGoBack() ? router.back() : router.replace(`/routines/${encodeURIComponent(id)}` as never));
	if (!routine) {
		// Carregando ou apagada: o mesmo esqueleto da lista cuida do estado.
		return <RoutinesView routines={[]} groups={[]} accent={accent} loading={state.loading || (!state.loaded && !state.error)} error={state.loaded ? "Não encontrei esta rotina. Ela pode ter sido apagada." : state.error} onBack={goBack} onOpen={() => {}} onToggle={() => {}} onRetry={state.reload} />;
	}
	return (
		<RoutineDetailView
			routine={routine}
			accent={accent}
			busy={state.busy.has(routine.id)}
			onBack={goBack}
			onToggle={(enabled) => state.toggle(routine.id, enabled)}
			onOpenHistory={() => router.push(`/routines/${encodeURIComponent(id)}/history/${encodeURIComponent(routine.id)}` as never)}
			onEdit={() => router.push(`/chat/${encodeURIComponent(id)}?draft=${encodeURIComponent(editRoutineDraft(routine.name))}` as never)}
		/>
	);
}
