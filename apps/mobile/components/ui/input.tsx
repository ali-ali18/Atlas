import * as React from "react";
import { TextInput } from "react-native";
import { cn } from "@/lib/cn";
import { colorTokens } from "@/lib/color-tokens";
import { useSurfaces } from "@/lib/use-surfaces";
import { useAppColorScheme } from "@/lib/use-theme";

// Campo com a pele de chrome do app (`chromeFill`/`chromeEdge`), `h-11`, pílula, `px-5` e texto 15 (decisão do dono; também evita o zoom do teclado). `invalid` faz o papel de `aria-invalid`.
export type InputProps = React.ComponentProps<typeof TextInput> & { invalid?: boolean };

export function Input({ className, invalid, editable = true, style, ...props }: InputProps) {
	const scheme = useAppColorScheme();
	const surfaces = useSurfaces();
	return (
		<TextInput
			editable={editable}
			aria-invalid={invalid}
			placeholderTextColor={colorTokens[scheme]["muted-foreground"]}
			style={[{ backgroundColor: surfaces.chromeFill, borderColor: invalid ? colorTokens[scheme].destructive : surfaces.chromeEdge }, style]}
			className={cn("h-11 w-full min-w-0 rounded-full border px-5 py-1 text-control text-foreground", !editable && "opacity-50", className)}
			{...props}
		/>
	);
}
