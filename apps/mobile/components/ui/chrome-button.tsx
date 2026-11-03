import * as React from "react";
import { Pressable } from "react-native";
import { useSurfaces } from "@/lib/use-surfaces";

/** Tamanhos do botão redondo: `lg` é o do topo do chat (47 dp, medido no Grok), `md` o de linha de cabeçalho, `sm` o compacto. */
export const CHROME_BUTTON_SIZE = { lg: 47, md: 44, sm: 36 } as const;
export type ChromeButtonSize = keyof typeof CHROME_BUTTON_SIZE;

export type ChromeButtonProps = { label: string; onPress: () => void; children: React.ReactNode; size?: ChromeButtonSize; disabled?: boolean };

/**
 * Botão redondo com borda (voltar, fechar, "…", compartilhar, ajuda, novo chat). É o ÚNICO desenho de botão de chrome do
 * app: preenchimento `chromeFill` e contorno `chromeEdge`. Variante nova é prop aqui, não cópia na tela.
 */
export function ChromeButton({ label, onPress, children, size = "lg", disabled = false }: ChromeButtonProps) {
	const surfaces = useSurfaces();
	const side = CHROME_BUTTON_SIZE[size];
	return (
		<Pressable
			role="button"
			accessibilityLabel={label}
			accessibilityState={{ disabled }}
			disabled={disabled}
			onPress={onPress}
			style={{ width: side, height: side, borderColor: surfaces.chromeEdge, backgroundColor: surfaces.chromeFill }}
			className={disabled ? "items-center justify-center rounded-full border opacity-50" : "items-center justify-center rounded-full border active:opacity-70"}
		>
			{children}
		</Pressable>
	);
}
