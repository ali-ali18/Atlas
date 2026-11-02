import * as React from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ThemedModalRoot } from "@/components/home/themed-modal";
import { Text } from "@/components/ui/text";

/**
 * "Selecionar texto": o texto inteiro da mensagem numa tela própria, onde dá para selecionar à vontade. O balão em si
 * não é selecionável (o toque longo abre o menu) e o Android não seleciona por código, então a seleção mora aqui.
 */
export function TextSelectModal({ text, onClose }: { text: string | null; onClose: () => void }) {
	const insets = useSafeAreaInsets();
	return (
		<Modal visible={text !== null} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
			<ThemedModalRoot>
				<View className="flex-1 bg-background" style={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom }}>
					<View className="flex-row items-center justify-between px-5 pb-3">
						<Text variant="heading">Selecionar texto</Text>
						<Pressable role="button" accessibilityLabel="Fechar" onPress={onClose} className="min-h-11 justify-center rounded-full bg-secondary px-5 active:opacity-80">
							<Text className="text-control font-semibold">Fechar</Text>
						</Pressable>
					</View>
					<ScrollView contentContainerClassName="px-5 pb-6">
						<Text selectable className="text-control leading-6">
							{text ?? ""}
						</Text>
					</ScrollView>
				</View>
			</ThemedModalRoot>
		</Modal>
	);
}
