import * as React from "react";
import { Modal, Pressable, View } from "react-native";
import { ThemedModalRoot } from "@/components/home/themed-modal";
import { Text } from "@/components/ui/text";

/** Gaveta com uma lista de opções (uma escolhida): o seletor das linhas "Idioma" etc. */
export function OptionSheet({ open, title, options, value, onPick, onClose }: { open: boolean; title: string; options: readonly { value: string; label: string }[]; value: string; onPick: (value: string) => void; onClose: () => void }) {
	return (
		<Modal visible={open} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
			<ThemedModalRoot>
				<Pressable accessibilityLabel="Fechar" onPress={onClose} className="flex-1 justify-end bg-black/50">
					<Pressable accessible={false} className="rounded-t-panel bg-popover px-2 pb-8 pt-4">
						<Text variant="heading" className="px-4 pb-2">
							{title}
						</Text>
						{options.map((option) => (
							<Pressable key={option.value} role="radio" accessibilityState={{ checked: option.value === value }} onPress={() => onPick(option.value)} className="min-h-12 flex-row items-center justify-between rounded-xl px-4 active:bg-muted/60">
								<Text className="text-control">{option.label}</Text>
								{option.value === value ? <Text className="text-control font-semibold">✓</Text> : <View />}
							</Pressable>
						))}
					</Pressable>
				</Pressable>
			</ThemedModalRoot>
		</Modal>
	);
}
