import * as React from "react";
import { TextInput, View } from "react-native";
import { cn } from "@/lib/cn";
import { colorTokens } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

// Mesmos nomes do input-group do web (InputGroup, InputGroupAddon, InputGroupInput) e a mesma pele:
// `h-9 rounded-4xl bg-input/50`. Sem foco/aria-invalid por CSS: `invalid` pinta a borda.
export function InputGroup({ className, invalid, ...props }: React.ComponentProps<typeof View> & { invalid?: boolean }) {
	return (
		<View
			role="group"
			className={cn("h-9 w-full min-w-0 flex-row items-center rounded-4xl border border-transparent bg-input/50", invalid && "border-destructive", className)}
			{...props}
		/>
	);
}

export function InputGroupAddon({ className, ...props }: React.ComponentProps<typeof View>) {
	return <View className={cn("items-center justify-center pl-3", className)} {...props} />;
}

export function InputGroupInput({ className, editable = true, ...props }: React.ComponentProps<typeof TextInput>) {
	const scheme = useAppColorScheme();
	return (
		<TextInput
			editable={editable}
			placeholderTextColor={colorTokens[scheme]["muted-foreground"]}
			className={cn("h-9 min-w-0 flex-1 bg-transparent px-3 py-1 text-base text-foreground", !editable && "opacity-50", className)}
			{...props}
		/>
	);
}
