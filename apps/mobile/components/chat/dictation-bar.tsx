import * as React from "react";
import { Pressable, ScrollView, useWindowDimensions, View } from "react-native";

import { ArrowUpIcon, CloseIcon, StopIcon } from "@/components/icons";
import { ChromeButton } from "@/components/ui/chrome-button";
import { Text } from "@/components/ui/text";
import { barLine } from "@/lib/dictation";
import { themeColor } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

const SIDE = 36;
/** Mesma métrica do campo de escrita do composer (fonte 16, linha 21, altura mínima 45): o texto falado quebra igual. */
const FONT_SIZE = 16;
const LINE_HEIGHT = 21;
const MIN_HEIGHT = 45;
/** Botões de 36 centrados na altura mínima; quando o texto quebra, ficam na base. */
const BUTTON_INSET = (MIN_HEIGHT - SIDE) / 2;

type DictationBarProps = {
	/** O que já foi falado (parcial + confirmado); vazio mostra "Ouvindo…". */
	spoken: string;
	/** Cor do bot (o botão de enviar é o mesmo do composer). */
	color: string;
	foreground: string;
	/** Esperando o resultado final depois de parar: os botões ficam desligados. */
	busy: boolean;
	onCancel: () => void;
	onStop: () => void;
	onSend: () => void;
};

/**
 * Barra de voz: ocupa o lugar do composer enquanto o ditado ouve. X cancela (descarta o falado), o meio mostra o texto
 * ao vivo (quebra de linha e a barra cresce como o campo de escrita; acima do máximo rola, sempre no fim), o quadrado para e leva o texto ao campo para revisar e a seta para e envia direto.
 */
export function DictationBar({ spoken, color, foreground, busy, onCancel, onStop, onSend }: DictationBarProps) {
	const scheme = useAppColorScheme();
	const line = barLine(spoken);
	const scroller = React.useRef<React.ComponentRef<typeof ScrollView>>(null);
	// Mesmo teto do campo do composer (40% da tela).
	const maxHeight = Math.round(useWindowDimensions().height * 0.4);
	return (
		<View className="flex-row items-end gap-2" style={{ minHeight: MIN_HEIGHT, paddingHorizontal: 4.5 }}>
			<View style={{ marginBottom: BUTTON_INSET }}>
				<ChromeButton label="Cancelar ditado" size="sm" onPress={onCancel}>
					<CloseIcon size={18} tone="foreground" />
				</ChromeButton>
			</View>
			<ScrollView
				ref={scroller}
				className="min-w-0 flex-1"
				style={{ maxHeight }}
				contentContainerStyle={{ justifyContent: "center", minHeight: MIN_HEIGHT, paddingHorizontal: 4 }}
				showsVerticalScrollIndicator={false}
				accessibilityLiveRegion="polite"
				// Passou do máximo: a rolagem acompanha o fim, que é o que a pessoa acabou de falar.
				onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: false })}
			>
				<Text variant={line.empty ? "muted" : "default"} style={{ fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT, paddingVertical: (MIN_HEIGHT - LINE_HEIGHT) / 2 }}>
					{line.text}
				</Text>
			</ScrollView>
			<View style={{ marginBottom: BUTTON_INSET }}>
				<ChromeButton label="Parar e revisar" size="sm" onPress={onStop} disabled={busy}>
					<StopIcon size={14} color={themeColor(scheme, "foreground")} />
				</ChromeButton>
			</View>
			<Pressable
				role="button"
				accessibilityLabel="Parar e enviar"
				accessibilityState={{ disabled: busy }}
				disabled={busy}
				onPress={onSend}
				style={{ backgroundColor: color, width: SIDE, height: SIDE, marginBottom: BUTTON_INSET, opacity: busy ? 0.5 : 1 }}
				className="items-center justify-center rounded-full active:opacity-80"
			>
				<ArrowUpIcon size={18} color={foreground} />
			</Pressable>
		</View>
	);
}
