import * as React from "react";
import { Modal, Pressable, View } from "react-native";
import { TOP_BAR_CONTROL, TOP_BAR_SIDE } from "@/components/chat/chat-top-bar";
import { ThemedModalRoot } from "@/components/home/themed-modal";
import { CheckOnDarkIcon, CursorIcon } from "@/components/icons";
import { Text } from "@/components/ui/text";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/** Mesmas cores do menu do chat, fixas: a tela do Computador é sempre escura. */
const FILL = "#2c2c2e";
const EDGE = "#4b4b4d";

/** Menu do "…" no controle: abre embaixo do botão, à direita (como o `ChatMenu`). Hoje só tem "Modo trackpad". */
export function ComputerMenu({ open, trackpad, onClose, onToggleTrackpad }: { open: boolean; trackpad: boolean; onClose: () => void; onToggleTrackpad: () => void }) {
	const insets = useSafeAreaInsets();
	return (
		<Modal visible={open} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
			<ThemedModalRoot>
				<Pressable accessibilityLabel="Fechar menu" onPress={onClose} className="flex-1">
					<View role="menu" className="absolute overflow-hidden rounded-panel border py-2" style={{ top: insets.top + 6 + TOP_BAR_CONTROL + 8, right: TOP_BAR_SIDE, width: 300, maxWidth: "92%", borderColor: EDGE, backgroundColor: FILL }}>
						<Pressable role="menuitem" accessibilityLabel="Modo trackpad" accessibilityState={{ checked: trackpad }} onPress={() => { onToggleTrackpad(); onClose(); }} className="min-h-16 flex-row items-center gap-4 px-5 active:opacity-70">
							<CursorIcon />
							<Text numberOfLines={1} className="min-w-0 flex-1 text-control" style={{ color: "#ffffff" }}>
								Modo trackpad
							</Text>
							{trackpad ? <CheckOnDarkIcon /> : null}
						</Pressable>
					</View>
				</Pressable>
			</ThemedModalRoot>
		</Modal>
	);
}
