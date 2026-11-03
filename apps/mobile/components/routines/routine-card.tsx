import type { RoutineRecord } from "@workspace/shared";
import * as React from "react";
import { Pressable } from "react-native";
import { SurfaceCard } from "@/components/ui/surface-card";
import { Text } from "@/components/ui/text";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { routineSummary } from "@/lib/routine-summary";

/**
 * Cartão de uma rotina, como no Grok: nome, a frase de quando roda ("Uma vez · 03/10 às 10:00"), o selo "Criada pelo
 * bot" e o interruptor de pausar/retomar. Tocar no cartão abre os detalhes; o interruptor só pausa/retoma.
 */
export function RoutineCard({ routine, accent, busy = false, onOpen, onToggle }: { routine: RoutineRecord; accent: string; busy?: boolean; onOpen: (routine: RoutineRecord) => void; onToggle: (routine: RoutineRecord, enabled: boolean) => void }) {
	const summary = routineSummary(routine);
	// O interruptor fica FORA do botão do cartão: dentro dele o VoiceOver do iOS esconde os filhos e o interruptor some.
	return (
		<SurfaceCard className="flex-row items-center gap-3 px-5 py-4">
			<Pressable role="button" accessibilityLabel={`${routine.name}. ${summary}`} onPress={() => onOpen(routine)} className="min-w-0 flex-1 gap-0.5 active:opacity-80">
				<Text numberOfLines={2} className={`text-base ${routine.enabled ? "" : "text-muted-foreground"}`}>
					{routine.name}
				</Text>
				<Text numberOfLines={2} variant="muted" className="text-base">
					{routine.enabled ? summary : `${summary} · Pausada`}
				</Text>
				{routine.createdBy === "bot" ? (
					<Text variant="caption" className="mt-1 text-caption text-muted-foreground">
						Criada pelo bot
					</Text>
				) : null}
			</Pressable>
			<ToggleSwitch accessibilityLabel={`Ativa: ${routine.name}`} value={routine.enabled} disabled={busy} onValueChange={(value) => onToggle(routine, value)} color={accent} />
		</SurfaceCard>
	);
}
