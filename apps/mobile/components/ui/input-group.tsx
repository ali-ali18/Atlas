import * as React from "react";
import { TextInput, View } from "react-native";
import { cn } from "@/lib/cn";
import { colorTokens } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

// Mesmos nomes do input-group do web (InputGroup, InputGroupAddon, InputGroupInput) e a mesma pele:
// `rounded-4xl bg-input/50`, com `h-14`, `pl-5` no ícone e texto 17. Sem foco/aria-invalid por CSS: `invalid` pinta a borda.
export function InputGroup({ className, invalid, ...props }: React.ComponentProps<typeof View> & { invalid?: boolean }) {
	return (
		<View
			role="group"
			className={cn("h-14 w-full min-w-0 flex-row items-center rounded-full border border-transparent bg-input/50", invalid && "border-destructive", className)}
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
			className={cn("h-14 min-w-0 flex-1 bg-transparent px-3 py-1 text-control text-foreground", !editable && "opacity-50", className)}
			{...props}
		/>
	);
}
