import { useLocalSearchParams, useRouter } from "expo-router";
import * as React from "react";
import { ExecutionsView } from "@/components/executions/executions-view";
import { useBotRun } from "@/lib/run-store";

/**
 * Execuções do bot: os passos do run em andamento (ou o último do fio) no padrão do Grok. O run
 * vem do store alimentado pelo chat, que segue montado por baixo (o stream continua vivo enquanto se navega). Não há
 * endpoint de histórico de runs com passos: `GET /v1/conversations/:id/runs` só traz id e estado.
 */
export default function ExecutionsScreen() {
	const router = useRouter();
	const { id } = useLocalSearchParams<{ id: string }>();
	const run = useBotRun(id);
	const goBack = () => (router.canGoBack() ? router.back() : router.replace("/"));
	const steps = run.running ? run.tasks : run.last;
	return <ExecutionsView steps={steps ?? []} active={run.running} onBack={goBack} />;
}
