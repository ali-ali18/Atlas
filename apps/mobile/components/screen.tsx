import * as React from "react";
import { Keyboard, KeyboardAvoidingView, Pressable, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { cn } from "@/lib/cn";

type ScreenProps = { children: React.ReactNode; className?: string; scroll?: boolean };

/**
 * Casca de tela: área segura, teclado e gutter de 24px.
 *
 * Teclado (Android e iOS, só JS, roda no Expo Go): o `KeyboardAvoidingView` em `padding` mede quanto do
 * seu retângulo o teclado cobre (evento de teclado + `onLayout`) e sobe esse valor como `paddingBottom`.
 * Se o sistema já redimensionou a janela, o retângulo já encolheu e a sobreposição medida é 0, então não
 * soma duas vezes; se não redimensionou (edge-to-edge, SDK 58 / Android 15+), o padding faz o trabalho.
 * Dentro, o `ScrollView` (`flexGrow` + `justify-center`) centraliza quando sobra espaço e rola quando falta;
 * `keyboardShouldPersistTaps="handled"` deixa o botão receber o toque com o teclado aberto, tocar no vazio
 * ou arrastar fecha o teclado.
 */
export function Screen({ children, className, scroll = true }: ScreenProps) {
	const content = cn("flex-grow gap-6 px-6 py-8", className);
	return (
		<SafeAreaView className="flex-1 bg-background">
			<KeyboardAvoidingView behavior="padding" className="flex-1">
				{scroll ? (
					<ScrollView
						keyboardShouldPersistTaps="handled"
						keyboardDismissMode="on-drag"
						contentContainerClassName={content}
						automaticallyAdjustKeyboardInsets={false}
					>
						<Pressable accessible={false} onPress={Keyboard.dismiss} className="flex-grow justify-center gap-6">
							{children}
						</Pressable>
					</ScrollView>
				) : (
					<React.Fragment>{children}</React.Fragment>
				)}
			</KeyboardAvoidingView>
		</SafeAreaView>
	);
}
