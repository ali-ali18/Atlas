import * as React from "react";
import { LayoutAnimation, Platform, Pressable, TextInput, useWindowDimensions, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";

import type { ReplyQuote } from "@/lib/chat-types";
import { ReplyChip } from "./reply-chip";
import { ArrowUpIcon, MicIcon, PlusIcon, StopIcon, WaveformIcon } from "@/components/icons";
import { Text } from "@/components/ui/text";
import { pillAccessibilityLabel, type ModelPill } from "@/lib/model-pill";
import { themeColor } from "@/lib/theme";
import { useSurfaces } from "@/lib/use-surfaces";
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
	/** Texto que o campo já abre preenchido (ex.: "Quero mudar a rotina …: " vindo da tela de Rotinas). */
	initialText?: string;
	botName: string;
	/** Destaque do bot (`botAccent`): o botão redondo. */
	color: string;
	/** Primeiro plano sobre o destaque (ícones do botão). */
	foreground: string;
	running: boolean;
	onSend: (text: string) => void;
	onStop: () => void;
	onSoon: (what: "anexos" | "voz") => void;
	/** Abre a folha "Selecionar modelo" (a pílula ao lado do "+"). */
	onModel: () => void;
	/** O modelo atual (nome curto + esforço) que a pílula mostra. */
	modelPill: ModelPill;
	/** Mantém o modo de escrita (a folha de modelo aberta tira o foco do campo, mas o composer não deve fechar atrás dela). */
	holdWriting?: boolean;
	/** O composer entrou no modo de escrita (foco ou texto): hora de ler o catálogo da pílula. */
	onWriting?: () => void;
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
 * Estrutura e borda como no `chat-composer` do web: uma View só, com `chromeEdge` e `chromeFill` (lib/surfaces.ts), colada na
 * pílula (sem respiro nem wrapper), com o raio total direto nela, nos dois formatos (pílula e retângulo).
 */
export function Composer({ initialText, botName, color, foreground, running, onSend, onStop, onSoon, onModel, modelPill, holdWriting, onWriting, replyTo, onCancelReply }: ComposerProps) {
	// `color` é o destaque do bot (`botAccent`): o primeiro plano é o que vem dele, sempre branco.
	const onColor = foreground;
	const scheme = useAppColorScheme();
	const surfaces = useSurfaces();
	const [text, setText] = React.useState(initialText ?? "");
	const hasText = text.trim().length > 0;
	const inputRef = React.useRef<React.ComponentRef<typeof TextInput>>(null);
	const replyId = replyTo?.id;
	// Tocou em "Responder": o teclado abre no campo, pronto para digitar.
	React.useEffect(() => {
		if (replyId) inputRef.current?.focus();
	}, [replyId]);
	const [stacked, setStacked] = React.useState(false);
	const [focused, setFocused] = React.useState(false);
	const reducedMotion = useReducedMotion();
	// Modo de escrita: campo com foco ou com texto (ou a folha de modelo aberta). Só nele aparece a pílula e o composer
	// vira duas linhas (campo em cima, "+" e pílula à esquerda, microfone/enviar à direita). Fora dele, a pílula de uma linha.
	const writing = focused || hasText || holdWriting === true;
	const open = stacked || writing;
	const animate = () => {
		if (!reducedMotion && Platform.OS !== "web") LayoutAnimation.configureNext(LayoutAnimation.create(180, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity));
	};
	React.useEffect(() => {
		if (writing) onWriting?.();
		// biome-ignore lint/correctness/useExhaustiveDependencies: só quando entra no modo de escrita
	}, [writing]);
	// A folha de modelo fechou: o foco volta para o campo, como estava.
	const held = React.useRef(false);
	React.useEffect(() => {
		if (held.current && !holdWriting) inputRef.current?.focus();
		held.current = holdWriting === true;
	}, [holdWriting]);
	const baseline = React.useRef<number | null>(null);
	const [webHeight, setWebHeight] = React.useState(0);
	// O campo cresce com o texto até 40% da tela e rola por dentro depois disso.
	const maxFieldHeight = Math.round(useWindowDimensions().height * 0.4);
	// Largura do grupo da direita: microfone + botão da cor do bot.
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
			<View className="overflow-hidden border" style={{ borderRadius: open || replyTo ? STACKED_RADIUS : PILL_RADIUS, borderColor: surfaces.chromeEdge, backgroundColor: surfaces.chromeFill }}>
				{replyTo && onCancelReply ? <ReplyChip quote={replyTo} onCancel={onCancelReply} /> : null}
				{/*
				  Um só TextInput nos dois formatos (assim o foco e o teclado não se perdem na troca). Os botões ficam sempre
				  em posição absoluta na base: com uma linha o campo fica entre eles (pílula); quando o texto quebra, o campo
				  ocupa a largura toda e reserva uma faixa embaixo para a linha de botões ("+" à esquerda, microfone e botão
				  da cor do bot à direita), como nas referências do dono.
				*/}
				<View style={{ paddingBottom: open ? BUTTON + STACKED_INSET * 2 : 0 }}>
					<TextInput
						ref={inputRef}
						accessibilityLabel={`Perguntar a ${botName}`}
						placeholder={`Perguntar a ${botName}`}
						placeholderTextColor={themeColor(scheme, "muted-foreground")}
						value={text}
						onFocus={() => {
							animate();
							setFocused(true);
						}}
						onBlur={() => {
							animate();
							setFocused(false);
						}}
						onChangeText={(value) => {
							if ((value.length > 0) !== hasText) animate();
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
						textAlignVertical={open ? "top" : "center"}
						style={{
							fontSize: 16,
							lineHeight: LINE_HEIGHT,
							paddingTop: (MIN_HEIGHT - LINE_HEIGHT) / 2,
							paddingBottom: open ? 4 : (MIN_HEIGHT - LINE_HEIGHT) / 2,
							paddingLeft: open ? 16 : INSET + BUTTON + 8,
							paddingRight: open ? 16 : INSET + rightWidth + 8,
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
							open
								? { left: STACKED_INSET, right: STACKED_INSET, bottom: STACKED_INSET, height: BUTTON }
								: { left: INSET, right: INSET, top: 0, bottom: 0 }
						}
						pointerEvents="box-none"
					>
						<View className="min-w-0 shrink flex-row items-center gap-2">
							<Pressable role="button" accessibilityLabel="Adicionar" onPress={() => onSoon("anexos")} style={{ width: BUTTON, height: BUTTON, backgroundColor: surfaces.chromeControl }} className="items-center justify-center rounded-full active:opacity-70">
								<PlusIcon size={18} />
							</Pressable>
							{writing ? (
								<Pressable role="button" accessibilityLabel={pillAccessibilityLabel(modelPill)} onPress={onModel} style={{ height: BUTTON, backgroundColor: surfaces.chromeControl }} className="min-w-0 shrink flex-row items-center gap-1.5 rounded-full px-3 active:opacity-70">
									<Text numberOfLines={1} className="shrink text-body">
										{modelPill.name}
									</Text>
									{modelPill.effort ? (
										<Text numberOfLines={1} variant="muted" className="shrink-0 text-body">
											{modelPill.effort}
										</Text>
									) : null}
								</Pressable>
							) : null}
						</View>
						<View className="flex-row items-center gap-2">
							<Pressable role="button" accessibilityLabel="Microfone (em breve)" onPress={() => onSoon("voz")} style={{ width: BUTTON, height: BUTTON, backgroundColor: surfaces.chromeControl }} className="items-center justify-center rounded-full active:opacity-70">
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
