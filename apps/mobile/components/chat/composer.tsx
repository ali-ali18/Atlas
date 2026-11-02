import * as React from "react";
import { Pressable, TextInput, View } from "react-native";
import { ArrowUpIcon, MicIcon, PlusIcon, StopIcon, WaveformIcon } from "@/components/icons";
import { themeColor } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

type ComposerProps = {
	botName: string;
	/** Cor do bot: o botão redondo. */
	color: string;
	running: boolean;
	onSend: (text: string) => void;
	onStop: () => void;
	onSoon: (what: "anexos" | "voz") => void;
};

/**
 * Composer em pílula: "+" à esquerda, o campo "Perguntar a <bot>", microfone e o botão redondo na cor do bot.
 * O botão é "enviar" com texto, "parar" durante o run (sem texto) e, vazio e parado, o ícone de voz.
 * Microfone e voz ainda são "em breve".
 */
export function Composer({ botName, color, running, onSend, onStop, onSoon }: ComposerProps) {
	const scheme = useAppColorScheme();
	const [text, setText] = React.useState("");
	const hasText = text.trim().length > 0;
	const mode = hasText ? "send" : running ? "stop" : "voice";
	const press = () => {
		if (mode === "send") {
			onSend(text);
			setText("");
		} else if (mode === "stop") onStop();
		else onSoon("voz");
	};
	return (
		<View className="mx-4 mb-2 min-h-14 flex-row items-end gap-2 rounded-[28px] border border-border bg-card p-1.5">
			<Pressable role="button" accessibilityLabel="Adicionar" onPress={() => onSoon("anexos")} className="size-11 items-center justify-center rounded-full bg-secondary active:opacity-70">
				<PlusIcon size={20} />
			</Pressable>
			<TextInput
				accessibilityLabel={`Perguntar a ${botName}`}
				placeholder={`Perguntar a ${botName}`}
				placeholderTextColor={themeColor(scheme, "muted-foreground")}
				value={text}
				onChangeText={setText}
				multiline
				maxLength={20_000}
				textAlignVertical="center"
				className="max-h-32 min-h-11 min-w-0 flex-1 px-1 py-3 text-control text-foreground"
			/>
			{hasText ? null : (
				<Pressable role="button" accessibilityLabel="Microfone (em breve)" onPress={() => onSoon("voz")} className="size-11 items-center justify-center rounded-full bg-secondary active:opacity-70">
					<MicIcon size={20} />
				</Pressable>
			)}
			<Pressable
				role="button"
				accessibilityLabel={mode === "send" ? "Enviar" : mode === "stop" ? "Parar" : "Voz (em breve)"}
				onPress={press}
				style={{ backgroundColor: color }}
				className="size-11 items-center justify-center rounded-full active:opacity-80"
			>
				{mode === "send" ? <ArrowUpIcon size={20} tone="primary-foreground" /> : mode === "stop" ? <StopIcon size={16} /> : <WaveformIcon size={20} />}
			</Pressable>
		</View>
	);
}
