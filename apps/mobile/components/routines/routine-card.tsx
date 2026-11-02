import type { RoutineRecord } from "@workspace/shared";
import * as React from "react";
import { Pressable, View } from "react-native";
import { Text } from "@/components/ui/text";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { routineSurface } from "@/lib/chat-surface";
import { routineSummary } from "@/lib/routine-summary";
import { useAppColorScheme } from "@/lib/use-theme";

/**
 * Cartão de uma rotina, como no Grok: nome, a frase de quando roda ("Uma vez · 03/10 às 10:00"), o selo "Criada pelo
 * bot" e o interruptor de pausar/retomar. Tocar no cartão abre os detalhes; o interruptor só pausa/retoma.
 */
export function RoutineCard({ routine, accent, busy = false, onOpen, onToggle }: { routine: RoutineRecord; accent: string; busy?: boolean; onOpen: (routine: RoutineRecord) => void; onToggle: (routine: RoutineRecord, enabled: boolean) => void }) {
	const surface = routineSurface(useAppColorScheme());
	const summary = routineSummary(routine);
	return (
		<Pressable role="button" accessibilityLabel={`${routine.name}. ${summary}`} onPress={() => onOpen(routine)} className="flex-row items-center gap-3 px-5 py-4 active:opacity-80" style={{ borderWidth: 1, borderColor: surface.edge, backgroundColor: surface.card, borderRadius: 21 }}>
			<View className="min-w-0 flex-1 gap-0.5">
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
			</View>
			<ToggleSwitch accessibilityLabel={`${routine.enabled ? "Pausar" : "Retomar"} ${routine.name}, ${summary}`} value={routine.enabled} disabled={busy} onValueChange={(value) => onToggle(routine, value)} color={accent} offColor={surface.off} />
		</Pressable>
	);
}
