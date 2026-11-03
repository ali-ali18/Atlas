import * as React from "react";
import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { routineSurface } from "@/lib/chat-surface";
import type { LibraryGroup as Group } from "@/lib/library-groups";
import { libraryRowSubtitle } from "@/lib/library-groups";
import type { LibraryItem } from "@/lib/library-items";
import { useAppColorScheme } from "@/lib/use-theme";
import { LibraryRow } from "./library-row";

/** Um período: o rótulo cinza FORA do cartão ("Hoje", "Outubro") e um cartão único (raio 21) com as linhas dentro. */
export function LibraryGroup({ group, now, onOpen }: { group: Group; now: Date; onOpen: (item: LibraryItem) => void }) {
	const surface = routineSurface(useAppColorScheme());
	return (
		<View className="gap-2">
			<Text variant="muted" accessibilityRole="header" className="px-2 text-control">
				{group.label}
			</Text>
			<View style={{ borderWidth: 1, borderColor: surface.edge, backgroundColor: surface.card, borderRadius: 21, overflow: "hidden" }}>
				{group.items.map((item, index) => (
					<LibraryRow key={item.key} item={item} subtitle={libraryRowSubtitle(item, now)} first={index === 0} onOpen={onOpen} />
				))}
			</View>
		</View>
	);
}
