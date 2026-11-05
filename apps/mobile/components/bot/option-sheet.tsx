import * as React from "react";
import { Modal, Pressable, View } from "react-native";
import { ThemedModalRoot } from "@/components/home/themed-modal";
import { Text } from "@/components/ui/text";
import { useSurfaces } from "@/lib/use-surfaces";

/** Uma opção da gaveta; `description` é o apoio de uma linha embaixo do rótulo (ex.: o que cada nível de permissão faz). */
export type Option = { value: string; label: string; description?: string };

/** Gaveta com uma lista de opções (uma escolhida): o seletor das linhas "Idioma", "Permissões", "Aparência". */
export function OptionSheet({ open, title, options, value, onPick, onClose }: { open: boolean; title: string; options: readonly Option[]; value: string; onPick: (value: string) => void; onClose: () => void }) {
	const surfaces = useSurfaces();
	return (
		<Modal visible={open} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
			<ThemedModalRoot>
				<Pressable accessibilityLabel="Fechar" onPress={onClose} className="flex-1 justify-end bg-black/50">
					<Pressable accessible={false} style={{ backgroundColor: surfaces.sheet }} className="rounded-t-panel px-2 pb-8 pt-4">
						<Text variant="heading" className="px-4 pb-2">
							{title}
						</Text>
						{options.map((option) => (
							<Pressable key={option.value} role="radio" accessibilityState={{ checked: option.value === value }} onPress={() => onPick(option.value)} className="min-h-12 flex-row items-center justify-between gap-3 rounded-xl px-4 py-2 active:bg-muted/60">
								<View className="min-w-0 flex-1">
									<Text className="text-control">{option.label}</Text>
									{option.description ? (
										<Text variant="muted" className="pt-0.5 text-body">
											{option.description}
										</Text>
									) : null}
								</View>
								{option.value === value ? <Text className="text-control font-semibold">✓</Text> : <View />}
							</Pressable>
						))}
					</Pressable>
				</Pressable>
			</ThemedModalRoot>
		</Modal>
	);
}
