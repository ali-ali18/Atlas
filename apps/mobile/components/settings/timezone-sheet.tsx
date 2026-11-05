import * as React from "react";
import { View } from "react-native";
import { CheckIcon, SearchIcon } from "@/components/icons";
import { ChromeInput } from "@/components/ui/chrome-input";
import { DraggableSheet } from "@/components/ui/draggable-sheet";
import { SurfaceGroup, SurfaceRow } from "@/components/ui/surface-card";
import { Text } from "@/components/ui/text";
import { filterTimeZones, timeZoneLabel } from "@/lib/timezone";

/** Lista de fusos com busca (cidade, região ou id, sem acento) na gaveta de altura cheia. `now` fixa o "GMT-3" mostrado. */
export function TimezoneSheet({ open, zones, value, now, onPick, onClose }: { open: boolean; zones: readonly string[]; value: string | null; now: Date; onPick: (zone: string) => void; onClose: () => void }) {
	const [query, setQuery] = React.useState("");
	React.useEffect(() => {
		if (!open) setQuery("");
	}, [open]);
	const shown = React.useMemo(() => filterTimeZones(zones, query), [zones, query]);
	return (
		<DraggableSheet
			visible={open}
			onClose={onClose}
			fullHeight
			header={<Text variant="heading">Fuso horário</Text>}
			fixed={<ChromeInput accessibilityLabel="Buscar fuso horário" placeholder="Buscar cidade ou região" value={query} onChangeText={setQuery} left={<SearchIcon />} autoCapitalize="none" autoCorrect={false} />}
		>
			{shown.length === 0 ? (
				<Text variant="muted" className="px-1 text-control">
					Nenhum fuso encontrado.
				</Text>
			) : (
				<SurfaceGroup>
					{shown.map((zone) => (
						<SurfaceRow key={zone} label={timeZoneLabel(zone, now)} radio={{ checked: zone === value }} onPress={() => onPick(zone)} className="justify-between py-2">
							<View className="min-w-0 flex-1">
								<Text className="text-control">{timeZoneLabel(zone, now)}</Text>
								<Text variant="muted" className="text-caption">
									{zone}
								</Text>
							</View>
							{zone === value ? <CheckIcon /> : null}
						</SurfaceRow>
					))}
				</SurfaceGroup>
			)}
		</DraggableSheet>
	);
}
