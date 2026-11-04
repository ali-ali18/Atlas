import * as React from "react";
import { Modal, Pressable, useWindowDimensions, View } from "react-native";
import { ThemedModalRoot } from "@/components/home/themed-modal";
import { Text } from "@/components/ui/text";
import { useSurfaces } from "@/lib/use-surfaces";

export type DropdownAction = { key: string; label: string; icon?: React.ReactNode; onPress: () => void; tone?: "default" | "destructive" };

type Rect = { x: number; y: number; width: number; height: number };

/** Largura do menu, vão entre o botão e o menu e margem mínima da borda da tela, em dp. */
const MENU_WIDTH = 232;
const GAP = 8;
const EDGE = 12;

/**
 * Menu flutuante ancorado num botão (o "…" do visualizador): abre logo abaixo do gatilho, alinhado à direita dele, medido
 * com `measureInWindow`. Fecha ao tocar fora, no Voltar do Android e ao escolher um item. Pele do padrão visual
 * (`chromeFill` + `chromeEdge`, raio de cartão). O gatilho é uma função que recebe o `open`.
 */
export function DropdownMenu({ trigger, actions, label = "Menu" }: { trigger: (open: () => void) => React.ReactNode; actions: DropdownAction[]; label?: string }) {
	const surfaces = useSurfaces();
	const { width: windowWidth } = useWindowDimensions();
	const anchor = React.useRef<React.ComponentRef<typeof View>>(null);
	const [rect, setRect] = React.useState<Rect | null>(null);
	const open = React.useCallback(() => {
		anchor.current?.measureInWindow((x, y, width, height) => setRect({ x, y, width, height }));
	}, []);
	const close = React.useCallback(() => setRect(null), []);
	const right = rect ? Math.max(windowWidth - (rect.x + rect.width), EDGE) : EDGE;
	return (
		<>
			<View ref={anchor} collapsable={false}>
				{trigger(open)}
			</View>
			<Modal visible={rect !== null} transparent animationType="fade" onRequestClose={close} statusBarTranslucent>
				<ThemedModalRoot>
					<Pressable accessibilityLabel="Fechar menu" onPress={close} className="absolute inset-0" />
					{rect ? (
						<View
							accessibilityLabel={label}
							style={{ position: "absolute", top: rect.y + rect.height + GAP, right, width: MENU_WIDTH, backgroundColor: surfaces.chromeFill, borderColor: surfaces.chromeEdge }}
							className="overflow-hidden rounded-card border py-1"
						>
							{actions.map((action) => (
								<Pressable
									key={action.key}
									role="menuitem"
									accessibilityLabel={action.label}
									onPress={() => {
										close();
										action.onPress();
									}}
									className="min-h-12 flex-row items-center gap-3 px-4 active:opacity-70"
								>
									{action.icon}
									<Text numberOfLines={1} className={`flex-1 text-control ${action.tone === "destructive" ? "text-destructive" : ""}`}>
										{action.label}
									</Text>
								</Pressable>
							))}
						</View>
					) : null}
				</ThemedModalRoot>
			</Modal>
		</>
	);
}
