import type { RoutineGroupRecord, RoutineRecord } from "@workspace/shared";
import * as React from "react";
import { Pressable, View } from "react-native";
import { ChevronDownIcon } from "@/components/icons";
import { Text } from "@/components/ui/text";
import { groupSummary } from "@/lib/routine-summary";
import { RoutineCard } from "./routine-card";

/** Grupo recolhível (aberto por padrão): nome, "N de M ativas" e as rotinas dentro, como no web. */
export function RoutineGroup({ group, routines, accent, busyIds, onToggle }: { group: RoutineGroupRecord; routines: RoutineRecord[]; accent: string; busyIds: ReadonlySet<string>; onToggle: (routine: RoutineRecord, enabled: boolean) => void }) {
	const [open, setOpen] = React.useState(true);
	const active = routines.filter((routine) => routine.enabled).length;
	return (
		<View className="gap-2">
			<Pressable role="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${group.name}, ${groupSummary(active, routines.length)}`} onPress={() => setOpen((value) => !value)} className="min-h-11 flex-row items-center gap-2 self-start px-1 active:opacity-70">
				<Text numberOfLines={1} className="shrink text-control text-muted-foreground">
					{group.name}
				</Text>
				<Text variant="caption" className="text-body text-muted-foreground">
					· {groupSummary(active, routines.length)}
				</Text>
				<View style={{ transform: [{ rotate: open ? "0deg" : "-90deg" }] }}>
					<ChevronDownIcon size={20} />
				</View>
			</Pressable>
			{open
				? routines.length > 0
					? routines.map((routine) => <RoutineCard key={routine.id} routine={routine} accent={accent} busy={busyIds.has(routine.id)} onToggle={onToggle} />)
					: <Text variant="muted" className="px-1 text-body">Nenhuma rotina neste grupo.</Text>
				: null}
		</View>
	);
}
