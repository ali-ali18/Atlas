import * as React from "react";
import { Modal, Pressable, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { ThemedModalRoot } from "./themed-modal";

/** Gaveta de "em breve" para o que ainda não existe (novo chat, apps). */
export function SoonSheet({ open, title, onClose }: { open: boolean; title: string; onClose: () => void }) {
	return (
		<Modal visible={open} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
			<ThemedModalRoot>
			<Pressable accessibilityLabel="Fechar" onPress={onClose} className="flex-1 justify-end bg-black/50">
				<Pressable accessible={false} className="gap-4 rounded-t-panel bg-popover px-6 pb-10 pt-6">
					<View className="gap-1">
						<Text variant="heading">{title}</Text>
						<Text variant="muted">Em breve.</Text>
					</View>
					<Button size="lg" variant="secondary" className="w-full" onPress={onClose}>
						<Text>Entendi</Text>
					</Button>
				</Pressable>
			</Pressable>
			</ThemedModalRoot>
		</Modal>
	);
}
