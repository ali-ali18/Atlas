import * as React from "react";
import { FlatList, Modal, Pressable, View } from "react-native";
import { ThemedModalRoot } from "@/components/home/themed-modal";
import { CheckIcon, CloseIcon, SearchIcon } from "@/components/icons";
import { ChromeButton } from "@/components/ui/chrome-button";
import { ChromeInput } from "@/components/ui/chrome-input";
import { ScreenFrame } from "@/components/ui/screen-frame";
import { Text } from "@/components/ui/text";
import { filterTimeZones, timeZoneLabel } from "@/lib/timezone";

/** Lista de fusos com busca (cidade, região ou id, sem acento): tela cheia por cima das Configurações. `now` fixa o "GMT-3" mostrado. */
export function TimezoneSheet({ open, zones, value, now, onPick, onClose }: { open: boolean; zones: readonly string[]; value: string | null; now: Date; onPick: (zone: string) => void; onClose: () => void }) {
	const [query, setQuery] = React.useState("");
	React.useEffect(() => {
		if (!open) setQuery("");
	}, [open]);
	const shown = React.useMemo(() => filterTimeZones(zones, query), [zones, query]);
	return (
		<Modal visible={open} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
			<ThemedModalRoot>
				<ScreenFrame>
					<View className="flex-row items-center gap-3 px-4 pb-3 pt-1.5">
						<ChromeButton label="Fechar" onPress={onClose}>
							<CloseIcon size={20} tone="foreground" />
						</ChromeButton>
						<Text className="text-lg">Fuso horário</Text>
					</View>
					<View className="px-4 pb-2">
						<ChromeInput accessibilityLabel="Buscar fuso horário" placeholder="Buscar cidade ou região" value={query} onChangeText={setQuery} left={<SearchIcon />} autoCapitalize="none" autoCorrect={false} />
					</View>
					<FlatList
						data={shown}
						keyExtractor={(zone) => zone}
						keyboardShouldPersistTaps="handled"
						initialNumToRender={24}
						ListEmptyComponent={
							<Text variant="muted" className="px-5 pt-6 text-control">
								Nenhum fuso encontrado.
							</Text>
						}
						renderItem={({ item }) => (
							<Pressable role="radio" accessibilityState={{ checked: item === value }} onPress={() => onPick(item)} className="min-h-12 flex-row items-center justify-between gap-3 px-5 active:bg-foreground/10">
								<View className="min-w-0 flex-1">
									<Text className="text-control">{timeZoneLabel(item, now)}</Text>
									<Text variant="muted" className="text-caption">
										{item}
									</Text>
								</View>
								{item === value ? <CheckIcon size={18} /> : null}
							</Pressable>
						)}
					/>
				</ScreenFrame>
			</ThemedModalRoot>
		</Modal>
	);
}
