import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { Text as RNText } from "react-native";
import { cn } from "@/lib/cn";

/** Classe de texto herdada (ex.: o Button define a cor do rótulo para os filhos `Text`). */
export const TextClassContext = React.createContext<string | undefined>(undefined);

// Não existe `Text` no packages/ui (no DOM o texto é <p>/<span>); no RN todo texto precisa de <Text>.
// Base = o corpo do web (`text-body`, 13px). As variantes usam os mesmos tokens.
const textVariants = cva("text-body text-foreground", {
	variants: {
		variant: {
			default: "",
			title: "text-2xl font-semibold tracking-tight",
			heading: "text-base font-semibold",
			muted: "text-muted-foreground",
			caption: "text-caption text-muted-foreground",
			error: "text-destructive",
		},
	},
	defaultVariants: { variant: "default" },
});

export type TextProps = React.ComponentProps<typeof RNText> & VariantProps<typeof textVariants>;

export function Text({ className, variant, ...props }: TextProps) {
	const inherited = React.useContext(TextClassContext);
	return <RNText className={cn(textVariants({ variant }), inherited, className)} {...props} />;
}
