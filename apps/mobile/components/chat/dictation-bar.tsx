import * as React from "react";
import { type LayoutChangeEvent, Pressable, ScrollView, useWindowDimensions, View } from "react-native";

import { ArrowUpIcon, CloseIcon, StopIcon } from "@/components/icons";
import { ChromeButton } from "@/components/ui/chrome-button";
import { Text } from "@/components/ui/text";
import {
	COMPOSER_BUTTON,
	COMPOSER_FONT_SIZE,
	COMPOSER_INSET,
	COMPOSER_LINE_HEIGHT,
	COMPOSER_MIN_HEIGHT,
	fieldMaxHeight,
	COMPOSER_STACKED_INSET,
	COMPOSER_STACKED_STRIP,
	COMPOSER_STACKED_TEXT_PADDING,
} from "@/lib/composer-metrics";
import { barLine } from "@/lib/dictation";
import { themeColor } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";
import { useStackedLayout } from "@/lib/use-stacked-layout";

/** Largura dos dois botões da direita (quadrado + enviar, com 8 entre eles), como o `rightWidth` do composer. */
const RIGHT_WIDTH = COMPOSER_BUTTON * 2 + 8;

type DictationBarProps = {
	/** O que já foi falado (parcial + confirmado); vazio mostra "Ouvindo…". */
	spoken: string;
	/** Cor do bot (o botão de enviar é o mesmo do composer). */
	color: string;
	foreground: string;
	/** Esperando o resultado final depois de parar: os botões ficam desligados. */
	busy: boolean;
	/** O texto quebrou e a barra virou retângulo: o composer troca o raio da caixa. */
	onStackedChange?: (stacked: boolean) => void;
	onCancel: () => void;
	onStop: () => void;
	onSend: () => void;
};

/**
 * Barra de voz: ocupa o lugar do composer enquanto o ditado ouve. X cancela (descarta o falado), o meio mostra o texto
 * ao vivo, o quadrado para e leva o texto ao campo para revisar e a seta para e envia direto.
 *
 * Mesmo mecanismo e mesmas medidas do campo do composer (`useStackedLayout`, `lib/composer-metrics.ts`): com o texto
 * em uma linha é a pílula (X | texto | quadrado | enviar); quando quebra vira retângulo (texto na largura toda, linha de
 * botões na base) e fica assim até a barra fechar. Os botões ficam sempre em posição absoluta; o texto reserva as
 * laterais (pílula) ou a faixa de baixo (retângulo). Acima de 20% da tela rola, sempre no fim.
 */
export function DictationBar({ spoken, color, foreground, busy, onStackedChange, onCancel, onStop, onSend }: DictationBarProps) {
	const scheme = useAppColorScheme();
	const line = barLine(spoken);
	const scroller = React.useRef<React.ComponentRef<typeof ScrollView>>(null);
	const maxHeight = fieldMaxHeight(useWindowDimensions().height);
	const { stacked, measure } = useStackedLayout();
	const onTextLayout = (event: LayoutChangeEvent) => {
		if (measure(event.nativeEvent.layout.height, true)) onStackedChange?.(true);
	};
	const buttonRow = stacked
		? { left: COMPOSER_STACKED_INSET, right: COMPOSER_STACKED_INSET, bottom: COMPOSER_STACKED_INSET, height: COMPOSER_BUTTON }
		: { left: COMPOSER_INSET, right: COMPOSER_INSET, top: 0, bottom: 0 };
	// Mesmo respiro do TextInput do composer: pílula centrada entre os botões; retângulo com 16 de lado, topo e 4 embaixo.
	const verticalPad = (COMPOSER_MIN_HEIGHT - COMPOSER_LINE_HEIGHT) / 2;
	const textBox = stacked
		? { paddingTop: verticalPad, paddingBottom: 4, paddingLeft: COMPOSER_STACKED_TEXT_PADDING, paddingRight: COMPOSER_STACKED_TEXT_PADDING }
		: { paddingTop: verticalPad, paddingBottom: verticalPad, paddingLeft: COMPOSER_INSET + COMPOSER_BUTTON + 8, paddingRight: COMPOSER_INSET + RIGHT_WIDTH + 8 };
	return (
		<View style={{ minHeight: COMPOSER_MIN_HEIGHT, paddingBottom: stacked ? COMPOSER_STACKED_STRIP : 0 }}>
			<ScrollView
				ref={scroller}
				style={{ maxHeight }}
				showsVerticalScrollIndicator={false}
				accessibilityLiveRegion="polite"
				// Passou do máximo: a rolagem acompanha o fim, que é o que a pessoa acabou de falar.
				onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: false })}
			>
				<View style={{ minHeight: COMPOSER_MIN_HEIGHT, ...textBox }}>
					<Text onLayout={onTextLayout} variant={line.empty ? "muted" : "default"} style={{ fontSize: COMPOSER_FONT_SIZE, lineHeight: COMPOSER_LINE_HEIGHT }}>
						{line.text}
					</Text>
				</View>
			</ScrollView>
			<View className="absolute flex-row items-center justify-between" style={buttonRow} pointerEvents="box-none">
				<ChromeButton label="Cancelar ditado" size="xs" onPress={onCancel}>
					<CloseIcon size={16} tone="foreground" />
				</ChromeButton>
				<View className="flex-row items-center gap-2">
					<ChromeButton label="Parar e revisar" size="xs" onPress={onStop} disabled={busy}>
						<StopIcon size={12} color={themeColor(scheme, "foreground")} />
					</ChromeButton>
					<Pressable
						role="button"
						accessibilityLabel="Parar e enviar"
						accessibilityState={{ disabled: busy }}
						disabled={busy}
						onPress={onSend}
						style={{ backgroundColor: color, width: COMPOSER_BUTTON, height: COMPOSER_BUTTON, opacity: busy ? 0.5 : 1 }}
						className="items-center justify-center rounded-full active:opacity-80"
					>
						<ArrowUpIcon size={18} color={foreground} />
					</Pressable>
				</View>
			</View>
		</View>
	);
}
