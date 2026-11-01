import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { Pressable } from "react-native";
import { cn } from "@/lib/cn";
import { TextClassContext } from "./text";

// Mesmas variantes e tamanhos do Button de packages/ui. Sai o que é DOM (hover, focus-visible,
// aria-invalid, svg); o texto é um <Text> filho que herda a cor por TextClassContext.
const buttonVariants = cva("shrink-0 flex-row items-center justify-center rounded-4xl border border-transparent active:opacity-80", {
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
			default: "h-9 gap-1.5 px-3",
			xs: "h-6 gap-1 px-2.5",
			sm: "h-8 gap-1 px-3",
			lg: "h-10 gap-1.5 px-4",
			icon: "size-9",
			"icon-xs": "size-6",
			"icon-sm": "size-8",
			"icon-lg": "size-10",
		},
	},
	defaultVariants: { variant: "default", size: "default" },
});

const buttonTextVariants = cva("font-medium", {
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
			default: "text-sm",
			xs: "text-xs",
			sm: "text-sm",
			lg: "text-sm",
			icon: "text-sm",
			"icon-xs": "text-xs",
			"icon-sm": "text-sm",
			"icon-lg": "text-sm",
		},
	},
	defaultVariants: { variant: "default", size: "default" },
});

export type ButtonProps = React.ComponentProps<typeof Pressable> & VariantProps<typeof buttonVariants>;

// Diferença inevitável: o web usa `touch-hit` (área de 44px por pseudo-elemento); no RN é `hitSlop`.
const TOUCH_SLOP = { top: 6, bottom: 6, left: 6, right: 6 } as const;

export function Button({ className, variant = "default", size = "default", disabled, ...props }: ButtonProps) {
	return (
		<TextClassContext.Provider value={buttonTextVariants({ variant, size })}>
			<Pressable
				role="button"
				accessibilityState={{ disabled: Boolean(disabled) }}
				disabled={disabled}
				hitSlop={TOUCH_SLOP}
				className={cn(buttonVariants({ variant, size }), disabled && "opacity-50", className)}
				{...props}
			/>
		</TextClassContext.Provider>
	);
}

export { buttonTextVariants, buttonVariants };
