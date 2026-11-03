import type { RoutineRecord } from "@workspace/shared";
import * as React from "react";
import { Pressable, ScrollView } from "react-native";
import { ChevronRightIcon } from "@/components/icons";
import { ScreenFrame } from "@/components/ui/screen-frame";
import { ScreenHeader } from "@/components/ui/screen-header";
import { SurfaceCard } from "@/components/ui/surface-card";
import { Text } from "@/components/ui/text";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { routineSummary } from "@/lib/routine-summary";
import { useSurfaces } from "@/lib/use-surfaces";

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
	const surfaces = useSurfaces();
	return (
		<ScreenFrame>
			<ScreenHeader title={routine.name} onBack={onBack} />
			<ScrollView contentContainerClassName="gap-3 px-4 pb-10 pt-4">
				{error ? (
					<Text role="alert" className="px-2 text-body text-destructive">
						{error}
					</Text>
				) : null}
				<SurfaceCard className="flex-row items-center justify-between px-5 py-4">
					<Text className="text-lg">Ativa</Text>
					<ToggleSwitch accessibilityLabel="Ativa" value={routine.enabled} disabled={busy} onValueChange={onToggle} color={accent} />
				</SurfaceCard>
				<Text variant="muted" className="mt-2 px-2 text-base">
					Instrução
				</Text>
				<SurfaceCard className="px-5 py-4">
					<Text selectable className="text-base leading-snug">
						{routine.prompt}
					</Text>
				</SurfaceCard>
				<Text variant="muted" className="mt-2 px-2 text-base">
					Agendamento
				</Text>
				<SurfaceCard className="px-5 py-4">
					<Text className="text-base">{routineSummary(routine)}</Text>
				</SurfaceCard>
				<Pressable role="button" accessibilityLabel="Histórico de execuções" onPress={onOpenHistory} className="mt-2 active:opacity-80">
					<SurfaceCard className="flex-row items-center justify-between px-5 py-4">
						<Text className="text-lg">Histórico de execuções</Text>
						<ChevronRightIcon size={22} />
					</SurfaceCard>
				</Pressable>
				<Pressable role="button" accessibilityLabel="Editar rotina" onPress={onEdit} className="active:opacity-80">
					<SurfaceCard className="px-5 py-4">
						<Text className="text-lg" style={{ color: surfaces.link }}>
							Editar rotina
						</Text>
					</SurfaceCard>
				</Pressable>
			</ScrollView>
		</ScreenFrame>
	);
}
