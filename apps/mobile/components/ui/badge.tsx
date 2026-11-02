import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { Text, View } from "react-native";
import { cn } from "@/lib/cn";

// Mesmas variantes do Badge do web (sem as de hover/link). No RN o rótulo é um <Text> dentro de uma <View>,
// então a cor do texto sai de `badgeTextVariants`.
const badgeVariants = cva("h-5 w-fit shrink-0 flex-row items-center justify-center gap-1 overflow-hidden rounded-3xl border border-transparent px-2 py-0.5", {
	variants: {
		variant: {
			default: "bg-primary",
			secondary: "bg-secondary",
			success: "bg-success/10 dark:bg-success/15",
			warning: "bg-warning/10 dark:bg-warning/15",
			info: "bg-info/10 dark:bg-info/15",
			destructive: "bg-destructive/10 dark:bg-destructive/20",
			outline: "border-border",
			ghost: "",
		},
	},
	defaultVariants: { variant: "default" },
});

const badgeTextVariants = cva("text-xs font-medium", {
	variants: {
		variant: {
			default: "text-primary-foreground",
			secondary: "text-secondary-foreground",
			success: "text-success",
			warning: "text-warning",
			info: "text-info",
			destructive: "text-destructive",
			outline: "text-foreground",
			ghost: "text-foreground",
		},
	},
	defaultVariants: { variant: "default" },
});

export type BadgeProps = Omit<React.ComponentProps<typeof View>, "children"> &
	VariantProps<typeof badgeVariants> & { children: string; textClassName?: string };

export function Badge({ className, textClassName, variant = "default", children, ...props }: BadgeProps) {
	return (
		<View className={cn(badgeVariants({ variant }), className)} {...props}>
			<Text className={cn(badgeTextVariants({ variant }), textClassName)} numberOfLines={1}>
				{children}
			</Text>
		</View>
	);
}

export { badgeVariants };
