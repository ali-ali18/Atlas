import * as React from "react";
import { TextInput, View } from "react-native";
import { cn } from "@/lib/cn";
import { colorTokens } from "@/lib/color-tokens";
import { useSurfaces } from "@/lib/use-surfaces";
import { useAppColorScheme } from "@/lib/use-theme";

// Mesmos nomes do input-group do web (InputGroup, InputGroupAddon, InputGroupInput), com a pele de chrome do app
// (`chromeFill`/`chromeEdge`, a mesma do topo do chat), `h-11`, pílula, `pl-5` no ícone e texto 15. Sem foco/aria-invalid
// por CSS: `invalid` pinta a borda de vermelho.
export function InputGroup({ className, invalid, style, ...props }: React.ComponentProps<typeof View> & { invalid?: boolean }) {
	const surfaces = useSurfaces();
	const scheme = useAppColorScheme();
	return (
		<View
			role="group"
			style={[{ backgroundColor: surfaces.chromeFill, borderColor: invalid ? colorTokens[scheme].destructive : surfaces.chromeEdge }, style]}
			className={cn("h-11 w-full min-w-0 flex-row items-center rounded-full border", className)}
			{...props}
		/>
	);
}

export function InputGroupAddon({ className, ...props }: React.ComponentProps<typeof View>) {
	return <View className={cn("items-center justify-center pl-5", className)} {...props} />;
}

export function InputGroupInput({ className, editable = true, ...props }: React.ComponentProps<typeof TextInput>) {
	const scheme = useAppColorScheme();
	return (
		<TextInput
			editable={editable}
			placeholderTextColor={colorTokens[scheme]["muted-foreground"]}
			className={cn("h-11 min-w-0 flex-1 bg-transparent px-3 py-1 text-control text-foreground", !editable && "opacity-50", className)}
			{...props}
		/>
	);
}
