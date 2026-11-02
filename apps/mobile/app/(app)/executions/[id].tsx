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
			<ScrollView contentContainerClassName="gap-4 px-4 pb-10 pt-6">
				{active ? (
					<ChatCard className="gap-3 self-stretch">
						<Text className="text-control font-semibold">Em andamento</Text>
						<Text variant="muted" className="text-control">
							{runStatusLine(run)}
						</Text>
						{steps && steps.length > 0 ? <TaskListItems items={steps} /> : null}
						{run.stop ? (
							<View className="flex-row">
								<Button size="sm" variant="secondary" accessibilityLabel="Parar" onPress={run.stop}>
									<Text>Parar</Text>
								</Button>
							</View>
						) : null}
					</ChatCard>
				) : steps && steps.length > 0 ? (
					<ChatCard className="gap-3 self-stretch">
						<Text className="text-control font-semibold">Última execução</Text>
						<Text variant="muted" className="text-control">
							{lastRunLabel(steps)}
						</Text>
						<TaskListItems items={steps} />
					</ChatCard>
				) : (
					<View className="items-center gap-2 px-6 py-16">
						<Text className="text-center text-control font-medium">Nenhuma em andamento</Text>
						<Text variant="muted" className="text-center text-control">
							Quando o bot trabalhar em algo de vários passos, você acompanha por aqui.
						</Text>
					</View>
				)}
			</ScrollView>
		</SafeAreaView>
	);
}
