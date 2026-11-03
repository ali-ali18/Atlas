import * as React from "react";
import { Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SearchIcon, ShareIcon, UserCircleIcon } from "@/components/icons";
import { ThemedModalRoot } from "@/components/home/themed-modal";
import { Text } from "@/components/ui/text";
import { useSurfaces } from "@/lib/use-surfaces";
import { TOP_BAR_CONTROL, TOP_BAR_SIDE } from "./chat-top-bar";

export type ChatMenuAction = "profile" | "search" | "share";

/**
 * Menu do "…": Ver perfil, Buscar no chat e Compartilhar como modelo. Abre embaixo do botão, à direita, como na
 * referência. Buscar e Compartilhar ainda são "em breve" (o menu só avisa).
 */
export function ChatMenu({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (action: ChatMenuAction) => void }) {
	const insets = useSafeAreaInsets();
	const surfaces = useSurfaces();
	const entries: Array<{ action: ChatMenuAction; label: string; soon: boolean; icon: React.ReactNode }> = [
		{ action: "profile", label: "Ver perfil", soon: false, icon: <UserCircleIcon /> },
		{ action: "search", label: "Buscar no chat", soon: true, icon: <SearchIcon size={22} /> },
		{ action: "share", label: "Compartilhar como modelo", soon: true, icon: <ShareIcon /> },
	];
	return (
		<Modal visible={open} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
			<ThemedModalRoot>
				<Pressable accessibilityLabel="Fechar menu" onPress={onClose} className="flex-1">
					<View role="menu" className="absolute overflow-hidden rounded-panel border py-2" style={{ top: insets.top + 6 + TOP_BAR_CONTROL + 8, right: TOP_BAR_SIDE, width: 332, maxWidth: "92%", borderColor: surfaces.chromeEdge, backgroundColor: surfaces.chromeFill }}>
						{entries.map((entry) => (
							<Pressable key={entry.action} role="menuitem" accessibilityLabel={entry.soon ? `${entry.label} (em breve)` : entry.label} onPress={() => onPick(entry.action)} className="min-h-16 flex-row items-center gap-4 px-5 active:bg-foreground/10">
								{entry.icon}
								<View className="min-w-0 flex-1">
									<Text numberOfLines={1} className="text-control">
										{entry.label}
									</Text>
									{entry.soon ? (
										<Text variant="caption" className="text-body">
											Em breve
										</Text>
									) : null}
								</View>
							</Pressable>
						))}
					</View>
				</Pressable>
			</ThemedModalRoot>
		</Modal>
	);
}
