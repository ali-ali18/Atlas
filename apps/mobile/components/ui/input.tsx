import * as React from "react";
import { TextInput } from "react-native";
import { cn } from "@/lib/cn";
import { colorTokens } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

// Mesma pele do Input do web (`rounded-3xl bg-input/50`), mas com `h-11`, pílula, `px-5` e texto 15 (decisão do dono; também evita o zoom do teclado). `invalid` faz o papel de `aria-invalid`.
export type InputProps = React.ComponentProps<typeof TextInput> & { invalid?: boolean };

export function Input({ className, invalid, editable = true, ...props }: InputProps) {
	const scheme = useAppColorScheme();
	return (
		<TextInput
			editable={editable}
			aria-invalid={invalid}
			placeholderTextColor={colorTokens[scheme]["muted-foreground"]}
			className={cn(
				"h-11 w-full min-w-0 rounded-full border border-transparent bg-input/50 px-5 py-1 text-control text-foreground",
				invalid && "border-destructive",
				!editable && "opacity-50",
				className,
			)}
			{...props}
		/>
	);
}
