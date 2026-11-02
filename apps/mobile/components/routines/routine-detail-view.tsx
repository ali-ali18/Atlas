import type { RoutineRecord } from "@workspace/shared";
import * as React from "react";
import { Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { RoundButton } from "@/components/chat/chat-top-bar";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/icons";
import { Text } from "@/components/ui/text";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { routineSurface } from "@/lib/chat-surface";
import { routineSummary } from "@/lib/routine-summary";
import { useAppColorScheme } from "@/lib/use-theme";

export type RoutineDetailViewProps = {
	routine: RoutineRecord;
	/** Cor do bot (interruptor ligado). */
	accent: string;
	busy?: boolean;
	/** Frase de erro já amigável (ex.: "Não foi possível pausar esta rotina."), ou null. */
	error?: string | null;
	onBack: () => void;
	onToggle: (enabled: boolean) => void;
	onOpenHistory: () => void;
	/** Editar é conversando: leva ao chat com o pedido pronto ("Quero mudar a rotina …"). */
	onEdit: () => void;
};

/**
 * Detalhes de uma rotina, como no Grok: Ativa (interruptor), Instrução, Agendamento (a frase do gatilho), Histórico de
 * execuções e Editar rotina. "Próxima execução" não aparece: o servidor ainda não calcula esse dado.
 */
export function RoutineDetailView({ routine, accent, busy = false, error = null, onBack, onToggle, onOpenHistory, onEdit }: RoutineDetailViewProps) {
	const surface = routineSurface(useAppColorScheme());
	const card = { borderWidth: 1, borderColor: surface.edge, backgroundColor: surface.card, borderRadius: 21 } as const;
	return (
		<SafeAreaView className="flex-1" style={{ backgroundColor: surface.screen }}>
			<View className="flex-row items-center gap-3 px-4 pt-1.5" style={{ minHeight: 47 + 6 }}>
				<RoundButton label="Voltar" onPress={onBack}>
					<ChevronLeftIcon />
				</RoundButton>
				<Text numberOfLines={1} className="min-w-0 flex-1 text-lg">
					{routine.name}
				</Text>
			</View>
			<ScrollView contentContainerClassName="gap-3 px-4 pb-10 pt-4">
				{error ? (
					<Text role="alert" className="px-2 text-body text-destructive">
						{error}
					</Text>
				) : null}
				<View className="flex-row items-center justify-between px-5 py-4" style={card}>
					<Text className="text-lg">Ativa</Text>
					<ToggleSwitch accessibilityLabel="Ativa" value={routine.enabled} disabled={busy} onValueChange={onToggle} color={accent} offColor={surface.off} />
				</View>
				<Text variant="muted" className="mt-2 px-2 text-base">
					Instrução
				</Text>
				<View className="px-5 py-4" style={card}>
					<Text selectable className="text-base leading-snug">
						{routine.prompt}
					</Text>
				</View>
				<Text variant="muted" className="mt-2 px-2 text-base">
					Agendamento
				</Text>
				<View className="px-5 py-4" style={card}>
					<Text className="text-base">{routineSummary(routine)}</Text>
				</View>
				<Pressable role="button" accessibilityLabel="Histórico de execuções" onPress={onOpenHistory} className="mt-2 flex-row items-center justify-between px-5 py-4 active:opacity-80" style={card}>
					<Text className="text-lg">Histórico de execuções</Text>
					<ChevronRightIcon size={22} />
				</Pressable>
				<Pressable role="button" accessibilityLabel="Editar rotina" onPress={onEdit} className="px-5 py-4 active:opacity-80" style={card}>
					<Text className="text-lg" style={{ color: surface.link }}>
						Editar rotina
					</Text>
				</Pressable>
			</ScrollView>
		</SafeAreaView>
	);
}
