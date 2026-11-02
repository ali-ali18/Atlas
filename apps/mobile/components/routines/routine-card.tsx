import type { RoutineRecord } from "@workspace/shared";
import * as React from "react";
import { Switch, View } from "react-native";
import { Text } from "@/components/ui/text";
import { chatSurface } from "@/lib/chat-surface";
import { routineSummary } from "@/lib/routine-summary";
import { themeColor } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

/**
 * Cartão de uma rotina: nome, a frase de quando roda ("Uma vez · 03/10 às 10:00"), o selo "Criada pelo bot" e o
 * interruptor de pausar/retomar. Só desenho: quem chama decide o que o interruptor faz.
 */
export function RoutineCard({ routine, accent, busy = false, onToggle }: { routine: RoutineRecord; accent: string; busy?: boolean; onToggle: (routine: RoutineRecord, enabled: boolean) => void }) {
	const scheme = useAppColorScheme();
	const summary = routineSummary(routine);
	const edge = scheme === "dark" ? "#313131" : themeColor(scheme, "border");
	return (
		<View className="flex-row items-center gap-3 px-5 py-4" style={{ borderWidth: 1, borderColor: edge, backgroundColor: chatSurface(scheme, "card"), borderRadius: 21 }}>
			<View className="min-w-0 flex-1 gap-0.5">
				<Text numberOfLines={1} className={`text-base font-semibold ${routine.enabled ? "" : "text-muted-foreground"}`}>
					{routine.name}
				</Text>
				<Text numberOfLines={2} variant="muted" className="text-body">
					{routine.enabled ? summary : `${summary} · Pausada`}
				</Text>
				{routine.createdBy === "bot" ? (
					<Text variant="caption" className="mt-1 text-caption text-muted-foreground">
						Criada pelo bot
					</Text>
				) : null}
			</View>
			<Switch
				accessibilityLabel={`${routine.enabled ? "Pausar" : "Retomar"} ${routine.name}, ${summary}`}
				value={routine.enabled}
				disabled={busy}
				onValueChange={(value) => onToggle(routine, value)}
				trackColor={{ false: themeColor(scheme, "input"), true: accent }}
				thumbColor="#ffffff"
			/>
		</View>
	);
}
