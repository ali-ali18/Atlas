import * as React from "react";
import { KeyboardAvoidingView, Platform, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { cn } from "@/lib/cn";

type ScreenProps = { children: React.ReactNode; className?: string; scroll?: boolean };

/** Casca de tela: área segura, teclado e gutter de 24px. */
export function Screen({ children, className, scroll = true }: ScreenProps) {
	const content = cn("flex-grow gap-6 px-6 py-8", className);
	return (
		<SafeAreaView className="flex-1 bg-background">
			<KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} className="flex-1">
				{scroll ? (
					<ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName={content}>
						{children}
					</ScrollView>
				) : (
					<React.Fragment>{children}</React.Fragment>
				)}
			</KeyboardAvoidingView>
		</SafeAreaView>
	);
}
