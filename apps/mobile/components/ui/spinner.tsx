import * as React from "react";
import { ActivityIndicator } from "react-native";
import { themeColor } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

export type SpinnerProps = Omit<React.ComponentProps<typeof ActivityIndicator>, "color" | "accessibilityLabel"> & {
	/** Rótulo para leitor de tela. Sem rótulo o indicador é decorativo. */
	label?: string;
	/** Cor de um token do tema (padrão `muted-foreground`, como o ícone do web dentro de texto). */
	tone?: "muted-foreground" | "foreground" | "primary-foreground";
};

/**
 * Mesmo papel do Spinner do web. Diferença inevitável: o tamanho é `size` do ActivityIndicator
 * ("small" | "large"), não `className="size-4"`; a animação respeita "reduzir movimento" no sistema.
 */
export function Spinner({ label, tone = "muted-foreground", size = "small", ...props }: SpinnerProps) {
	const scheme = useAppColorScheme();
	return (
		<ActivityIndicator
			size={size}
			color={themeColor(scheme, tone)}
			{...(label ? { accessibilityLabel: label, accessibilityRole: "progressbar" as const } : { accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" as const })}
			{...props}
		/>
	);
}
