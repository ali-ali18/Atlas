import * as React from "react";
import { Pressable, TextInput, View } from "react-native";
import { Text } from "@/components/ui/text";
import { VM_TEXT_MAX } from "@/lib/computer-text";
import type { ComputerKey } from "@/lib/computer-api";

const FILL = "#2c2c2e";
const EDGE = "#4b4b4d";

function BarButton({ label, text, onPress, disabled }: { label: string; text: string; onPress: () => void; disabled?: boolean }) {
	return (
		<Pressable role="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={{ height: 40, backgroundColor: FILL, borderColor: EDGE, opacity: disabled ? 0.5 : 1 }} className="items-center justify-center rounded-full border px-4 active:opacity-70">
			<Text className="text-control font-medium" style={{ color: "#ffffff" }}>
				{text}
			</Text>
		</Pressable>
	);
}

/**
 * Barra do teclado do Computador (como o web): um campo para digitar ou colar e "Enviar" (digita o texto na VM),
 * mais "Enter" e "Backspace" (teclas). O teclado do aparelho só digita aqui; o app manda o texto de uma vez.
 */
export function KeyboardBar({ busy, error, onSend, onKey }: { busy: boolean; error: string | null; onSend: (text: string) => Promise<boolean>; onKey: (key: ComputerKey) => void }) {
	const [text, setText] = React.useState("");
	const send = async () => {
		if (busy || text.trim().length === 0) return;
		// Só limpa o campo se o envio deu certo: o texto digitado não se perde numa falha.
		if (await onSend(text)) setText("");
	};
	return (
		<View className="gap-2">
			<TextInput
				value={text}
				onChangeText={setText}
				accessibilityLabel="Texto para digitar na VM"
				placeholder="Digite ou cole aqui para enviar à VM"
				placeholderTextColor="#8e8e93"
				multiline
				maxLength={VM_TEXT_MAX}
				autoCorrect={false}
				autoCapitalize="none"
				style={{ minHeight: 44, maxHeight: 120, backgroundColor: FILL, borderColor: EDGE, color: "#ffffff", fontSize: 15, borderWidth: 1, borderRadius: 22, paddingHorizontal: 18, paddingTop: 11, paddingBottom: 11 }}
			/>
			{error ? (
				<Text className="px-2 text-caption" style={{ color: "#fca5a5" }} accessibilityLiveRegion="polite">
					{error}
				</Text>
			) : null}
			<View className="flex-row items-center gap-2">
				<BarButton label="Enviar" text="Enviar" onPress={() => void send()} disabled={busy || text.trim().length === 0} />
				<BarButton label="Enter na VM" text="Enter" onPress={() => onKey("Return")} disabled={busy} />
				<BarButton label="Backspace na VM" text="Backspace" onPress={() => onKey("BackSpace")} disabled={busy} />
			</View>
		</View>
	);
}
