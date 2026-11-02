import * as React from "react";
import { Platform, Pressable, TextInput, useWindowDimensions, View } from "react-native";

import type { ReplyQuote } from "@/lib/chat-types";
import { ReplyChip } from "./reply-chip";
import { ArrowUpIcon, MicIcon, PlusIcon, StopIcon, WaveformIcon } from "@/components/icons";
import { chatChrome } from "@/lib/chat-surface";
import { themeColor } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

/** Composer magro como o do Grok (medido no print): 47 de altura externa (45 + borda), botões de 30, margem de 19,5. */
const LINE_HEIGHT = 21;
const MIN_HEIGHT = 45;
const BUTTON = 30;
/** Respiro dos botões na pílula (7,5 = a pílula de 45 fica com os botões de 30 centrados). */
const INSET = 7.5;
/** No retângulo (texto em várias linhas) os botões descolam da borda e do canto arredondado. */
const STACKED_INSET = 10;
const PILL_RADIUS = 28;
const STACKED_RADIUS = 24;

type ComposerProps = {
	botName: string;
	/** Destaque do bot (`botAccent`): o botão redondo. */
	color: string;
	/** Primeiro plano sobre o destaque (ícones do botão). */
	foreground: string;
	running: boolean;
	onSend: (text: string) => void;
	onStop: () => void;
	onSoon: (what: "anexos" | "voz") => void;
	/** Mensagem que a próxima fala responde: vira o chip dentro do campo, com X para cancelar. */
	replyTo?: ReplyQuote | null;
	onCancelReply?: () => void;
};

/**
 * Composer da referência: uma pílula só, numa linha ("+" num círculo, o campo "Perguntar a <bot>", o microfone num
 * círculo cinza e, colado nele, o círculo na cor do bot). O campo cresce quando o texto quebra e os botões ficam na
 * base. O botão da cor do bot é "enviar" com texto, "parar" durante o run (sem texto) e, parado e vazio, as ondas de
 * voz. Microfone e voz ainda são "em breve".
 *
 * Estrutura e borda como no `chat-composer` do web: uma View só, com `border border-border` e `bg-input`, colada na
 * pílula (sem respiro nem wrapper), com o raio total direto nela, nos dois formatos (pílula e retângulo).
 */
export function Composer({ botName, color, foreground, running, onSend, onStop, onSoon, replyTo, onCancelReply }: ComposerProps) {
	// `color` é o destaque do bot (`botAccent`): o primeiro plano é o que vem dele, sempre branco.
	const onColor = foreground;
	const scheme = useAppColorScheme();
	const chrome = chatChrome(scheme);
	const [text, setText] = React.useState("");
	const hasText = text.trim().length > 0;
	const inputRef = React.useRef<React.ComponentRef<typeof TextInput>>(null);
	const replyId = replyTo?.id;
	// Tocou em "Responder": o teclado abre no campo, pronto para digitar.
	React.useEffect(() => {
		if (replyId) inputRef.current?.focus();
	}, [replyId]);
	const [stacked, setStacked] = React.useState(false);
	const baseline = React.useRef<number | null>(null);
	const [webHeight, setWebHeight] = React.useState(0);
	// O campo cresce com o texto até 40% da tela e rola por dentro depois disso.
	const maxFieldHeight = Math.round(useWindowDimensions().height * 0.4);
	// Largura do grupo da direita: microfone + botão da cor do bot (o microfone fica também com texto).
	const rightWidth = BUTTON * 2 + 8;
	const mode = hasText ? "send" : running ? "stop" : "voice";
	const press = () => {
		if (mode === "send") {
			onSend(text);
			setText("");
			setStacked(false);
			baseline.current = null;
		} else if (mode === "stop") onStop();
		else onSoon("voz");
	};
	return (
		<View className="mb-2 gap-2" style={{ marginHorizontal: 19.5 }}>
			<View className="overflow-hidden border" style={{ borderRadius: stacked || replyTo ? STACKED_RADIUS : PILL_RADIUS, borderColor: chrome.edge, backgroundColor: chrome.fill }}>
				{replyTo && onCancelReply ? <ReplyChip quote={replyTo} onCancel={onCancelReply} /> : null}
				{/*
				  Um só TextInput nos dois formatos (assim o foco e o teclado não se perdem na troca). Os botões ficam sempre
				  em posição absoluta na base: com uma linha o campo fica entre eles (pílula); quando o texto quebra, o campo
				  ocupa a largura toda e reserva uma faixa embaixo para a linha de botões ("+" à esquerda, microfone e botão
				  da cor do bot à direita), como nas referências do dono.
				*/}
				<View style={{ paddingBottom: stacked ? BUTTON + STACKED_INSET * 2 : 0 }}>
					<TextInput
						ref={inputRef}
						accessibilityLabel={`Perguntar a ${botName}`}
						placeholder={`Perguntar a ${botName}`}
						placeholderTextColor={themeColor(scheme, "muted-foreground")}
						value={text}
						onChangeText={(value) => {
							setText(value);
							if (value.length === 0) {
								setStacked(false);
								baseline.current = null;
							}
						}}
						onContentSizeChange={(event) => {
							const height = event.nativeEvent.contentSize.height;
							// A altura de uma linha varia por plataforma (com ou sem o padding): a menor medida é a base.
							if (baseline.current === null || height < baseline.current) baseline.current = height;
							// Quebrou em mais de uma linha: vira retângulo. Fica assim até esvaziar (sem vai e volta).
							else if (height - baseline.current >= LINE_HEIGHT * 0.8) setStacked(true);
							// Na prévia web o campo não cresce sozinho (no celular, sim): a altura vem da medida.
							if (Platform.OS === "web") setWebHeight(height);
						}}
						multiline
						maxLength={20_000}
						textAlignVertical={stacked ? "top" : "center"}
						style={{
							fontSize: 16,
							lineHeight: LINE_HEIGHT,
							paddingTop: (MIN_HEIGHT - LINE_HEIGHT) / 2,
							paddingBottom: stacked ? 4 : (MIN_HEIGHT - LINE_HEIGHT) / 2,
							paddingLeft: stacked ? 16 : INSET + BUTTON + 8,
							paddingRight: stacked ? 16 : INSET + rightWidth + 8,
							minHeight: MIN_HEIGHT,
							maxHeight: maxFieldHeight,
							...(Platform.OS === "web" ? { height: Math.min(maxFieldHeight, Math.max(MIN_HEIGHT, webHeight)) } : {}),
						}}
						className="text-foreground outline-none"
					/>
					{/*
					  Pílula: a linha de botões ocupa a altura toda e centra na vertical (no Android o campo pode medir mais que
					  44 e, presa só pela base, ela descia). Retângulo: fica na faixa de baixo, com respiro maior da borda.
					*/}
					<View
						className="absolute flex-row items-center justify-between"
						style={
							stacked
								? { left: STACKED_INSET, right: STACKED_INSET, bottom: STACKED_INSET, height: BUTTON }
								: { left: INSET, right: INSET, top: 0, bottom: 0 }
						}
						pointerEvents="box-none"
					>
						<Pressable role="button" accessibilityLabel="Adicionar" onPress={() => onSoon("anexos")} style={{ width: BUTTON, height: BUTTON, backgroundColor: chrome.control }} className="items-center justify-center rounded-full active:opacity-70">
							<PlusIcon size={18} />
						</Pressable>
						<View className="flex-row items-center gap-2">
							<Pressable role="button" accessibilityLabel="Microfone (em breve)" onPress={() => onSoon("voz")} style={{ width: BUTTON, height: BUTTON, backgroundColor: chrome.control }} className="items-center justify-center rounded-full active:opacity-70">
								<MicIcon size={18} />
							</Pressable>
							<Pressable
								role="button"
								accessibilityLabel={mode === "send" ? "Enviar" : mode === "stop" ? "Parar" : "Voz (em breve)"}
								onPress={press}
								style={{ backgroundColor: color, width: BUTTON, height: BUTTON }}
								className="items-center justify-center rounded-full active:opacity-80"
							>
								{mode === "send" ? <ArrowUpIcon size={18} color={onColor} /> : mode === "stop" ? <StopIcon size={16} color={onColor} /> : <WaveformIcon size={18} color={onColor} />}
							</Pressable>
						</View>
					</View>
				</View>
			</View>
		</View>
	);
}
