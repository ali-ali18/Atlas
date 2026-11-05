import * as React from "react";
import { View } from "react-native";
import { ChevronLeftIcon } from "@/components/icons";
import { CHROME_BUTTON_SIZE, ChromeButton } from "@/components/ui/chrome-button";
import { Text } from "@/components/ui/text";

/** Espaço de cada lado do título: o botão de voltar mais o respiro, para o título centralizado nunca ficar sob ele. */
const TOP_BAR_CONTROL = CHROME_BUTTON_SIZE.lg;
const SIDE = TOP_BAR_CONTROL + 16 + 12;

/**
 * Topo de TODAS as telas internas (perfil, editar, avatar, rotinas, execuções), como no Grok: botão redondo de voltar à esquerda e o título CENTRALIZADO (não colado ao lado da
 * seta). `right` é opcional (ex.: "Concluir") e fica na ponta direita. `align="left"` (tela Conta) põe o título ao lado do botão, alinhado à esquerda.
 */
export function ScreenHeader({ title, onBack, right, align = "center" }: { title?: string; onBack: () => void; right?: React.ReactNode; align?: "center" | "left" }) {
	if (align === "left") {
		return (
			<View className="flex-row items-center gap-3 px-4 pt-1.5" style={{ minHeight: TOP_BAR_CONTROL + 6 }}>
				<ChromeButton label="Voltar" onPress={onBack}>
					<ChevronLeftIcon />
				</ChromeButton>
				{title ? (
					<Text accessibilityRole="header" numberOfLines={1} className="min-w-0 flex-1 text-xl font-semibold">
						{title}
					</Text>
				) : (
					<View className="flex-1" />
				)}
				{right ?? null}
			</View>
		);
	}
	return (
		<View className="justify-center px-4 pt-1.5" style={{ minHeight: TOP_BAR_CONTROL + 6 }}>
			<View className="flex-row items-center justify-between">
				<ChromeButton label="Voltar" onPress={onBack}>
					<ChevronLeftIcon />
				</ChromeButton>
				{right ?? null}
			</View>
			{title ? (
				<View pointerEvents="none" className="absolute inset-x-0 top-1.5 items-center justify-center" style={{ height: TOP_BAR_CONTROL, paddingHorizontal: SIDE }}>
					<Text numberOfLines={1} className="text-lg">
						{title}
					</Text>
				</View>
			) : null}
		</View>
	);
}
