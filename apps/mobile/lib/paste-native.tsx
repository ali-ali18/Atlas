// Adaptador do módulo nativo `expo-paste-input`, que faz o campo aceitar imagem colada (área de transferência, sugestão do
// teclado, GIF e figurinha). O `require` é protegido como em `speech-native.ts`: no Expo Go e na web o módulo não existe e
// `requireNativeView` lança; aí o campo segue só com texto, no mesmo layout.
import * as React from "react";
import { Platform, View, type StyleProp, type ViewStyle } from "react-native";
import type { PickedFile } from "./attachments";
import { pickedFromPaste, type PastePayload } from "./pasted-images";

type Wrapper = React.ComponentType<{ onPaste?: (payload: PastePayload) => void; style?: StyleProp<ViewStyle>; children: React.ReactElement }>;

let cached: Wrapper | null | undefined;

function loadWrapper(): Wrapper | null {
	if (cached !== undefined) return cached;
	cached = null;
	if (Platform.OS === "web") return cached;
	try {
		cached = (require("expo-paste-input") as { TextInputWrapper: Wrapper }).TextInputWrapper;
	} catch {
		cached = null;
	}
	return cached;
}

/**
 * Envolve o `TextInput` para receber imagens coladas. O envoltório é o item do layout (recebe `style`: flex, largura mínima);
 * o campo dentro só estica. Sem o módulo nativo vira uma `View` simples com o mesmo `style`, então o layout é igual.
 */
export function PasteImageInput({ onImages, style, children }: { onImages: (files: PickedFile[]) => void; style?: StyleProp<ViewStyle>; children: React.ReactElement }): React.ReactElement {
	const Native = loadWrapper();
	const onPaste = React.useCallback(
		(payload: PastePayload) => {
			const files = pickedFromPaste(payload);
			if (files.length > 0) onImages(files);
		},
		[onImages],
	);
	if (!Native) return <View style={style}>{children}</View>;
	return (
		<Native onPaste={onPaste} style={style}>
			{children}
		</Native>
	);
}
