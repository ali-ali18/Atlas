import * as React from "react";
import { Pressable } from "react-native";
import { Text } from "@/components/ui/text";

/** "Concluído" do topo: pílula branca quando há o que aplicar, cinza e desabilitada quando não há. */
export function DoneButton({ enabled, busy, onPress }: { enabled: boolean; busy?: boolean; onPress: () => void }) {
	return (
		<Pressable role="button" accessibilityLabel="Concluído" accessibilityState={{ disabled: !enabled || busy }} disabled={!enabled || busy} onPress={onPress} className={enabled ? "h-11 justify-center rounded-full bg-foreground px-5 active:opacity-80" : "h-11 justify-center rounded-full bg-foreground/35 px-5"}>
			<Text className={enabled ? "text-control font-semibold text-background" : "text-control font-semibold text-background/70"}>{busy ? "Salvando…" : "Concluído"}</Text>
		</Pressable>
	);
}
