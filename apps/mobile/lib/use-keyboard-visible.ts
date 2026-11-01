import * as React from "react";
import { Keyboard, Platform } from "react-native";

/**
 * `true` enquanto o teclado está aberto. No iOS usa os eventos "will" (acompanham a animação); no Android
 * só existem "did". Só JS do React Native: funciona no Expo Go, sem lib nativa.
 */
export function useKeyboardVisible(): boolean {
	const [visible, setVisible] = React.useState(false);
	React.useEffect(() => {
		const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", () => setVisible(true));
		const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setVisible(false));
		return () => {
			show.remove();
			hide.remove();
		};
	}, []);
	return visible;
}
