import * as React from "react";
import { TextInput } from "react-native";
import type { createTypingController } from "@/lib/computer-typing";

type Controller = ReturnType<typeof createTypingController>;

/**
 * Campo de captura do teclado: invisível (1x1, fora da vista) mas focável. Com `active` ganha foco e abre o teclado
 * do aparelho; o que a pessoa digita vai direto para a VM pelo `controller` (diferença, fila e colchão em
 * `lib/computer-typing.ts`). Enter do teclado manda Return e mantém o foco. Sem sugestões nem autocorreção. Se o
 * teclado for fechado pelo sistema (voltar), `onClose` avisa para o botão Teclado voltar ao estado fechado.
 */
export function TypingInput({ active, controller, onClose }: { active: boolean; controller: Controller; onClose: () => void }) {
	const ref = React.useRef<React.ComponentRef<typeof TextInput>>(null);
	const [value, setValue] = React.useState(controller.initial);
	React.useEffect(() => {
		if (active) ref.current?.focus();
		else ref.current?.blur();
	}, [active]);
	return (
		<TextInput
			ref={ref}
			value={value}
			onChangeText={(next) => {
				const refill = controller.change(next);
				setValue(refill ?? next);
			}}
			onSubmitEditing={() => controller.submit()}
			onBlur={onClose}
			submitBehavior="submit"
			returnKeyType="send"
			multiline={false}
			autoCapitalize="none"
			autoCorrect={false}
			autoComplete="off"
			spellCheck={false}
			importantForAutofill="no"
			keyboardType="default"
			caretHidden
			contextMenuHidden
			accessible={false}
			accessibilityElementsHidden
			importantForAccessibility="no-hide-descendants"
			style={{ position: "absolute", left: -100, top: 0, width: 1, height: 1, opacity: 0 }}
			testID="computer-typing-input"
		/>
	);
}
