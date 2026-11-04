import * as React from "react";
import { Pressable, View } from "react-native";

import { ArrowUpIcon, CloseIcon, StopIcon } from "@/components/icons";
import { ChromeButton } from "@/components/ui/chrome-button";
import { Text } from "@/components/ui/text";
import { barLine, levelFraction } from "@/lib/dictation";
import { themeColor } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

/** Mesmas alturas das ondas do indicador de "ouvindo": o meio é o mais alto. */
const WAVE_SHAPE = [0.45, 0.8, 1, 0.8, 0.45] as const;
const WAVE_MIN = 4;
const WAVE_MAX = 18;
const SIDE = 36;

type DictationBarProps = {
	/** O que já foi falado (parcial + confirmado); vazio mostra "Ouvindo…". */
	spoken: string;
	/** Volume do microfone (0..1), se o módulo informar. */
	level: number;
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
 * ao vivo (sempre o fim da frase), o quadrado para e leva o texto ao campo para revisar e a seta para e envia direto.
 */
export function DictationBar({ spoken, level, color, foreground, busy, onCancel, onStop, onSend }: DictationBarProps) {
	const scheme = useAppColorScheme();
	const line = barLine(spoken);
	const fraction = levelFraction(level);
	return (
		<View className="flex-row items-center gap-2" style={{ minHeight: 45, paddingHorizontal: 4.5 }}>
			<ChromeButton label="Cancelar ditado" size="sm" onPress={onCancel}>
				<CloseIcon size={18} tone="foreground" />
			</ChromeButton>
			<View className="min-w-0 flex-1 flex-row items-center gap-2 px-1" accessibilityLiveRegion="polite">
				{line.empty ? (
					<View className="flex-row items-center gap-0.5" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
						{WAVE_SHAPE.map((shape, index) => (
							<View key={index} className="rounded-full bg-muted-foreground" style={{ width: 3, height: WAVE_MIN + (WAVE_MAX - WAVE_MIN) * shape * Math.max(0.25, fraction) }} />
						))}
					</View>
				) : null}
				{/* Cabeça cortada: a frase longa mostra o fim, que é o que a pessoa acabou de falar. */}
				<Text numberOfLines={1} ellipsizeMode="head" variant={line.empty ? "muted" : "default"} className="min-w-0 flex-1 text-control">
					{line.text}
				</Text>
			</View>
			<ChromeButton label="Parar e revisar" size="sm" onPress={onStop} disabled={busy}>
				<StopIcon size={14} color={themeColor(scheme, "foreground")} />
			</ChromeButton>
			<Pressable
				role="button"
				accessibilityLabel="Parar e enviar"
				accessibilityState={{ disabled: busy }}
				disabled={busy}
				onPress={onSend}
				style={{ backgroundColor: color, width: SIDE, height: SIDE, opacity: busy ? 0.5 : 1 }}
				className="items-center justify-center rounded-full active:opacity-80"
			>
				<ArrowUpIcon size={18} color={foreground} />
			</Pressable>
		</View>
	);
}
