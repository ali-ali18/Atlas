import type { RoutineRunRecord } from "@workspace/shared";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as React from "react";
import { RoutineHistoryView } from "@/components/routines/routine-history-view";
import { useAtlasSession } from "@/lib/atlas-session";
import { listRoutineRuns, routinesErrorText } from "@/lib/routines-api";
import { useRoutines } from "@/lib/routines-store";

/** Histórico de execuções de uma rotina (até 20, as mais novas primeiro, como o servidor devolve). */
export default function RoutineHistoryScreen() {
	const router = useRouter();
	const { id, routineId } = useLocalSearchParams<{ id: string; routineId: string }>();
	const { apiFetch } = useAtlasSession();
	const { routines } = useRoutines(apiFetch, id);
	const routine = routines.find((item) => item.id === routineId);
	const [runs, setRuns] = React.useState<RoutineRunRecord[]>([]);
	const [loading, setLoading] = React.useState(true);
	const [error, setError] = React.useState<string | null>(null);
	React.useEffect(() => {
		let cancelled = false;
		setRuns([]);
		setLoading(true);
		setError(null);
		listRoutineRuns(apiFetch, id, routineId)
			.then((list) => !cancelled && setRuns(list))
			.catch((cause) => !cancelled && setError(routinesErrorText(cause, "history")))
			.finally(() => !cancelled && setLoading(false));
		return () => {
			cancelled = true;
		};
	}, [apiFetch, id, routineId]);
	const goBack = () => (router.canGoBack() ? router.back() : router.replace(`/routines/${encodeURIComponent(id)}/${encodeURIComponent(routineId)}` as never));
	return <RoutineHistoryView routine={{ name: routine?.name ?? "Rotina" }} runs={runs} loading={loading} error={error} onBack={goBack} />;
}
