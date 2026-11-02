import { useLocalSearchParams, useRouter } from "expo-router";
import * as React from "react";
import { RoutinesView } from "@/components/routines/routines-view";
import { useAtlasSession } from "@/lib/atlas-session";
import { useRoutines } from "@/lib/routines-store";
import { CREATE_ROUTINE_DRAFT, useBotAccent } from "@/lib/use-bot-accent";

/** Rotinas do bot (`id` = id do bot): lista com pausar/retomar; tocar numa rotina abre os detalhes. */
export default function RoutinesScreen() {
	const router = useRouter();
	const { id } = useLocalSearchParams<{ id: string }>();
	const { apiFetch } = useAtlasSession();
	const state = useRoutines(apiFetch, id);
	const { accent } = useBotAccent(id);
	const goBack = () => (router.canGoBack() ? router.back() : router.replace(`/profile/${encodeURIComponent(id)}` as never));
	return (
		<RoutinesView
			routines={state.routines}
			groups={state.groups}
			accent={accent}
			loading={state.loading || (!state.loaded && !state.error)}
			error={state.error}
			busyIds={state.busy}
			onBack={goBack}
			onOpen={(routine) => router.push(`/routines/${encodeURIComponent(id)}/${encodeURIComponent(routine.id)}` as never)}
			onToggle={(routine, enabled) => state.toggle(routine.id, enabled)}
			onRetry={state.reload}
			onAskBot={() => router.push(`/chat/${encodeURIComponent(id)}?draft=${encodeURIComponent(CREATE_ROUTINE_DRAFT)}` as never)}
		/>
	);
}
