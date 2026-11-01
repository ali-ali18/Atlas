import * as React from "react";
import { TextInput } from "react-native";
import { cn } from "@/lib/cn";
import { colorTokens } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

// Mesma pele do Input do web: `h-9 rounded-3xl bg-input/50 px-3`. `invalid` faz o papel de `aria-invalid`.
export type InputProps = React.ComponentProps<typeof TextInput> & { invalid?: boolean };

export function Input({ className, invalid, editable = true, ...props }: InputProps) {
	const scheme = useAppColorScheme();
	return (
		<TextInput
			editable={editable}
			aria-invalid={invalid}
			placeholderTextColor={colorTokens[scheme]["muted-foreground"]}
			className={cn(
				"h-9 w-full min-w-0 rounded-3xl border border-transparent bg-input/50 px-3 py-1 text-base text-foreground",
				invalid && "border-destructive",
				!editable && "opacity-50",
				className,
			)}
			{...props}
		/>
	);
}
