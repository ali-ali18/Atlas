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
			default: "h-13 gap-2 px-6",
			xs: "h-9 gap-1 px-3",
			sm: "h-10 gap-1.5 px-4",
			lg: "h-13 gap-2 px-6",
			icon: "size-13",
			"icon-xs": "size-9",
			"icon-sm": "size-10",
			"icon-lg": "size-13",
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
			default: "text-base",
			xs: "text-sm",
			sm: "text-base",
			lg: "text-base",
			icon: "text-base",
			"icon-xs": "text-sm",
			"icon-sm": "text-base",
			"icon-lg": "text-base",
		},
	},
	defaultVariants: { variant: "default", size: "default" },
});

export type ButtonProps = React.ComponentProps<typeof Pressable> & VariantProps<typeof buttonVariants>;

// Diferença do web (decisão do dono, no estilo do app do Grok): botões grandes e bem visíveis. `default`/`lg`
// têm 52 de altura, pílula e texto 16 semibold; `sm` 40 e `xs` 36, ambos com `hitSlop` até 44 (o web usa `touch-hit`).
const SMALL_SIZES = new Set(["xs", "sm", "icon-xs", "icon-sm"]);
const SMALL_SLOP = { top: 4, bottom: 4, left: 4, right: 4 } as const;

export function Button({ className, variant = "default", size = "default", disabled, ...props }: ButtonProps) {
	return (
		<TextClassContext.Provider value={buttonTextVariants({ variant, size })}>
			<Pressable
				role="button"
				accessibilityState={{ disabled: Boolean(disabled) }}
				disabled={disabled}
				hitSlop={size && SMALL_SIZES.has(size) ? SMALL_SLOP : undefined}
				className={cn(buttonVariants({ variant, size }), disabled && "opacity-50", className)}
				{...props}
			/>
		</TextClassContext.Provider>
	);
}

export { buttonTextVariants, buttonVariants };
