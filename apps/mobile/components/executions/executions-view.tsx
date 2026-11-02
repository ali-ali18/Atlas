import * as React from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CheckCircleIcon, CircleIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ScreenHeader } from "@/components/ui/screen-header";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { routineSurface } from "@/lib/chat-surface";
import type { TaskItem } from "@/lib/chat-types";
import { useAppColorScheme } from "@/lib/use-theme";

/** Rótulo do estado de um passo, embaixo do título (como o "Concluído" do Grok). */
export function stepStatusLabel(status: TaskItem["status"]): string {
	return status === "completed" ? "Concluído" : status === "in_progress" ? "Em andamento" : "Pendente";
}

function StepIcon({ status }: { status: TaskItem["status"] }) {
	if (status === "completed") return <CheckCircleIcon size={26} tone="muted-foreground" />;
	if (status === "in_progress") return <Spinner label="Em andamento" />;
	return <CircleIcon size={26} />;
}

/**
 * Execução do bot, no padrão do Grok: título centralizado no topo e um cartão único com uma linha por passo (ícone de
 * estado, título e o estado embaixo, em cinza), divisor que começa depois do ícone. "Parar" fica abaixo enquanto roda.
 * Os passos vêm do run vivo (ou o último do fio); o servidor não guarda um histórico de passos para listar mais.
 */
export function ExecutionsView({ steps, active, onBack, onStop }: { steps: readonly TaskItem[]; active: boolean; onBack: () => void; onStop?: (() => void) | null }) {
	const surface = routineSurface(useAppColorScheme());
	return (
		<SafeAreaView className="flex-1" style={{ backgroundColor: surface.screen }}>
			<ScreenHeader title="Execuções" onBack={onBack} />
			<ScrollView contentContainerClassName="gap-3 px-4 pb-10 pt-6">
				{steps.length > 0 ? (
					<View style={{ borderWidth: 1, borderColor: surface.edge, backgroundColor: surface.card, borderRadius: 21, overflow: "hidden" }}>
						{steps.map((step, index) => (
							<View key={`${index}-${step.content}`} className="flex-row items-center gap-4 pl-5">
								<View className="size-8 items-center justify-center">
									<StepIcon status={step.status} />
								</View>
								<View className="min-w-0 flex-1 py-4 pr-5" style={index > 0 ? { borderTopWidth: 1, borderTopColor: surface.edge } : undefined}>
									<Text numberOfLines={2} className={`text-lg ${step.status === "pending" ? "text-muted-foreground" : ""}`}>
										{step.content}
									</Text>
									<Text variant="muted" className="text-base">
										{stepStatusLabel(step.status)}
									</Text>
								</View>
							</View>
						))}
					</View>
				) : (
					<Text variant="muted" className="px-2 pt-8 text-center text-control">
						{active ? "O bot está começando…" : "Quando o bot trabalhar em algo de vários passos, você acompanha por aqui."}
					</Text>
				)}
				{active && onStop ? (
					<Button variant="secondary" accessibilityLabel="Parar" className="w-full" onPress={onStop}>
						<Text>Parar</Text>
					</Button>
				) : null}
			</ScrollView>
		</SafeAreaView>
	);
}
