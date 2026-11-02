import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { Pressable } from "react-native";
import { cn } from "@/lib/cn";
import { TextClassContext } from "./text";

// Mesmas variantes e tamanhos do Button de packages/ui. Sai o que é DOM (hover, focus-visible,
// aria-invalid, svg); o texto é um <Text> filho que herda a cor por TextClassContext.
const buttonVariants = cva("shrink-0 flex-row items-center justify-center rounded-full border border-transparent active:opacity-80", {
	variants: {
		variant: {
			default: "bg-primary",
			outline: "border-border bg-background",
			secondary: "bg-secondary",
			ghost: "",
			destructive: "bg-destructive/10 dark:bg-destructive/20",
			link: "",
		},
		size: {
			default: "h-11 gap-2 px-5",
			xs: "h-8 gap-1 px-3",
			sm: "h-9 gap-1.5 px-4",
			lg: "h-11 gap-2 px-5",
			icon: "size-11",
			"icon-xs": "size-8",
			"icon-sm": "size-9",
			"icon-lg": "size-11",
		},
	},
	defaultVariants: { variant: "default", size: "default" },
});

const buttonTextVariants = cva("font-semibold", {
	variants: {
		variant: {
			default: "text-primary-foreground",
			outline: "text-foreground",
			secondary: "text-secondary-foreground",
			ghost: "text-foreground",
			destructive: "text-destructive",
			link: "text-primary underline",
		},
		size: {
			default: "text-control",
			xs: "text-sm",
			sm: "text-control",
			lg: "text-control",
			icon: "text-control",
			"icon-xs": "text-sm",
			"icon-sm": "text-control",
			"icon-lg": "text-control",
		},
	},
	defaultVariants: { variant: "default", size: "default" },
});

export type ButtonProps = React.ComponentProps<typeof Pressable> & VariantProps<typeof buttonVariants>;

// Diferença do web (decisão do dono, no estilo do app do Grok): um pouco maior que o web. `default`/`lg`
// têm 44 de altura, pílula e texto 15 semibold (o web: 36/40 e 14); `sm` 36 e `xs` 32, ambos com `hitSlop` até 44.
const SLOP_4 = { top: 4, bottom: 4, left: 4, right: 4 } as const; // 36 -> 44
const SLOP_6 = { top: 6, bottom: 6, left: 6, right: 6 } as const; // 32 -> 44
function hitSlopFor(size: ButtonProps["size"]) {
	if (size === "xs" || size === "icon-xs") return SLOP_6;
	if (size === "sm" || size === "icon-sm") return SLOP_4;
	return undefined;
}

export function Button({ className, variant = "default", size = "default", disabled, ...props }: ButtonProps) {
	return (
		<TextClassContext.Provider value={buttonTextVariants({ variant, size })}>
			<Pressable
				role="button"
				accessibilityState={{ disabled: Boolean(disabled) }}
				disabled={disabled}
				hitSlop={hitSlopFor(size)}
				className={cn(buttonVariants({ variant, size }), disabled && "opacity-50", className)}
				{...props}
			/>
		</TextClassContext.Provider>
	);
}

export { buttonTextVariants, buttonVariants };
