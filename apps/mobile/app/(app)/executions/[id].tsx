import { useLocalSearchParams, useRouter } from "expo-router";
import * as React from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { TaskListItems } from "@/components/chat/task-dock";
import { RoundButton } from "@/components/chat/chat-top-bar";
import { ChevronLeftIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ChatCard } from "@/components/ui/chat-card";
import { Text } from "@/components/ui/text";
import { lastRunLabel, runStatusLine, useBotRun } from "@/lib/run-store";

/**
 * Execuções do bot: os passos do run em andamento (✓ concluído, em andamento, pendente) e o botão "Parar". Sem run,
 * a última execução do fio (a última lista de tarefas) ou um estado vazio. O run vem do store alimentado pelo chat,
 * que segue montado por baixo (o stream continua vivo enquanto se navega). Não há endpoint de histórico de runs com
 * passos: `GET /v1/conversations/:id/runs` só traz id e estado.
 */
export default function ExecutionsScreen() {
	const router = useRouter();
	const { id } = useLocalSearchParams<{ id: string }>();
	const run = useBotRun(id);
	const goBack = () => (router.canGoBack() ? router.back() : router.replace("/"));
	const active = run.running;
	const steps = active ? run.tasks : run.last;
	return (
		<SafeAreaView className="flex-1 bg-background">
			<View className="flex-row items-center gap-3 px-4 pt-1.5">
				<RoundButton label="Voltar" onPress={goBack}>
					<ChevronLeftIcon />
				</RoundButton>
				<Text className="text-xl font-semibold">Execuções</Text>
			</View>
			<ScrollView contentContainerClassName="gap-3 px-4 pb-10 pt-6">
				{/* Cabeçalho da seção e a linha de estado ficam fora do cartão; o cartão leva só os passos; "Parar" fica embaixo. */}
				{steps && steps.length > 0 ? (
					<>
						<View className="gap-1 px-1">
							<Text variant="caption" className="text-body uppercase tracking-wide">
								{active ? "Em andamento" : "Última execução"}
							</Text>
							<Text className="text-control">{active ? runStatusLine(run) : lastRunLabel(steps)}</Text>
						</View>
						<ChatCard className="self-stretch">
							<TaskListItems items={steps} />
						</ChatCard>
						{active && run.stop ? (
							<Button variant="secondary" accessibilityLabel="Parar" className="w-full" onPress={run.stop}>
								<Text>Parar</Text>
							</Button>
						) : null}
					</>
				) : active ? (
					<>
						<View className="gap-1 px-1">
							<Text variant="caption" className="text-body uppercase tracking-wide">
								Em andamento
							</Text>
							<Text className="text-control">{runStatusLine(run)}</Text>
						</View>
						{run.stop ? (
							<Button variant="secondary" accessibilityLabel="Parar" className="w-full" onPress={run.stop}>
								<Text>Parar</Text>
							</Button>
						) : null}
					</>
				) : (
					<>
						<View className="gap-1 px-1">
							<Text variant="caption" className="text-body uppercase tracking-wide">
								Em andamento
							</Text>
							<Text className="text-control">Nenhuma em andamento</Text>
						</View>
						<Text variant="muted" className="px-1 text-control">
							Quando o bot trabalhar em algo de vários passos, você acompanha por aqui.
						</Text>
					</>
				)}
			</ScrollView>
		</SafeAreaView>
	);
}
