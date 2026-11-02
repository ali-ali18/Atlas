import * as React from "react";
import { View } from "react-native";
import { Avatar } from "@/components/ui/avatar";

/** Mesmo fundo do splash nativo (app.json): a troca do nativo para esta tela não pisca. */
export const SPLASH_BACKGROUND = "#09090b";
/** Mesmo tamanho da imagem do splash nativo (`imageWidth` em app.json). */
const MASCOT_SIZE = 92;

/**
 * Carregamento inicial: fundo escuro e o mascote branco no centro, sem texto (a tela que o dono pediu).
 * Fica escura nos dois temas, como o splash nativo; o mascote respira parado e só pisca e olha.
 */
export function SplashView() {
	return (
		<View accessibilityLabel="Carregando" accessibilityRole="progressbar" style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: SPLASH_BACKGROUND }}>
			<Avatar color="#ffffff" size={MASCOT_SIZE} />
		</View>
	);
}
