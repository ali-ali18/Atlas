import { parseCompactCommand } from "@workspace/shared";
import * as React from "react";
import { Linking, Platform, Pressable, TextInput, useWindowDimensions, View } from "react-native";

import type { ReplyQuote } from "@/lib/chat-types";
import { AttachmentSheet, type AttachmentAction } from "./attachment-sheet";
import { ComposerAttachments } from "./composer-attachments";
import { pickDocuments, pickFromCamera, pickPhotos, type PickOutcome } from "@/lib/attachment-pickers";
import type { OutgoingAttachment } from "@/lib/attachments";
import type { ApiFetch } from "@/lib/home-sync";
import { PasteImageInput } from "@/lib/paste-native";
import { useAttachments } from "@/lib/use-attachments";
import { COMPOSER_BUTTON, COMPOSER_INSET, COMPOSER_LINE_HEIGHT, COMPOSER_MIN_HEIGHT, COMPOSER_PILL_RADIUS, COMPOSER_STACKED_INSET, COMPOSER_STACKED_RADIUS } from "@/lib/composer-metrics";
import { useStackedLayout } from "@/lib/use-stacked-layout";
import { DictationBar } from "./dictation-bar";
import { MARKER_HEIGHT, MarkerChip } from "./marker-chip";
import { MentionPopup } from "./mention-popup";
import { ReplyChip } from "./reply-chip";
import { ArrowUpIcon, MicIcon, PlusIcon, StopIcon, WaveformIcon } from "@/components/icons";
import { Text } from "@/components/ui/text";
import { addMarker, adoptLeadingMarkers, composeMessage, fieldMaxLength, fieldOffset, fieldValue, hasContent, readFieldChange, removeMarker, skillsFull, splitLeadingMarkers, type Marker } from "@/lib/composer-markers";
import { problemNotice, resolveDictation, type DictationOutcome, type DictationProblem } from "@/lib/dictation";
import { useDictation } from "@/lib/use-dictation";
import { applyPick, composerCommands, removeTrigger, triggerState, type BotCandidate, type SkillCandidate, type TriggerState } from "@/lib/mention-input";
import { pillAccessibilityLabel, type ModelPill } from "@/lib/model-pill";
import { themeColor } from "@/lib/theme";
import { useSurfaces } from "@/lib/use-surfaces";
import { useAppColorScheme } from "@/lib/use-theme";

const LINE_HEIGHT = COMPOSER_LINE_HEIGHT;
const MIN_HEIGHT = COMPOSER_MIN_HEIGHT;
const BUTTON = COMPOSER_BUTTON;
const INSET = COMPOSER_INSET;
const STACKED_INSET = COMPOSER_STACKED_INSET;
const PILL_RADIUS = COMPOSER_PILL_RADIUS;
const STACKED_RADIUS = COMPOSER_STACKED_RADIUS;
const NO_BOTS: readonly BotCandidate[] = [];

/** Aviso do ditado (sem módulo, sem serviço de voz, permissão negada), acima do composer; permissão negada leva às configurações. */
function DictationNotice({ problem }: { problem: DictationProblem }) {
	const notice = problemNotice(problem);
	return (
		<View className="flex-row flex-wrap items-center gap-x-2 px-3" accessibilityLiveRegion="polite">
			<Text variant="muted" className="text-body">
				{notice.message}
			</Text>
			{notice.settings ? (
				<Pressable role="link" accessibilityLabel="Abrir as configurações" onPress={() => void Linking.openSettings()} className="active:opacity-70">
					<Text className="text-body text-info underline">Abrir configurações</Text>
				</Pressable>
			) : null}
		</View>
	);
}

type ComposerProps = {
	/** Texto que o campo já abre preenchido (ex.: "Quero mudar a rotina …: " vindo da tela de Rotinas). */
	initialText?: string;
	botName: string;
	/** Destaque do bot (`botAccent`): o botão redondo. */
	color: string;
	/** Primeiro plano sobre o destaque (ícones do botão). */
	foreground: string;
	running: boolean;
	/** Sessão para subir os anexos ao escolher (imagem e arquivo). */
	apiFetch: ApiFetch;
	/** `attachments`: os já enviados ao servidor (nunca chega com upload pendente); pode vir sem texto. */
	onSend: (text: string, attachments?: OutgoingAttachment[]) => void;
	onStop: () => void;
	onSoon: (what: "voz") => void;
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
	/** Bots que o `@` oferece (os outros bots, ou os membros do grupo). Vazio: o `@` fica como texto. */
	mentionBots?: readonly BotCandidate[];
	/** Habilidades que o `/` oferece; `null` desliga o `/` (grupo). Carregam quando o `/` é digitado (`onSlash`). */
	skills?: readonly SkillCandidate[] | null;
	skillsLoading?: boolean;
	/** As duas leituras de habilidades falharam: a lista do `/` mostra o erro e "Tentar de novo" (que chama `onSlash`). */
	skillsFailed?: boolean;
	/** A primeira vez que o `/` abre: hora de ler as habilidades. */
	onSlash?: () => void;
	/** Marcadores que o campo já abre (ex.: a prévia). */
	initialMarkers?: readonly Marker[];
	/** `/compact [foco]`: o `/` oferece o comando (antes das habilidades) e escolher ou enviar `/compact` chama isto em vez de virar mensagem. Ausente (grupo) = sem comando. */
	onCompact?: (focus?: string) => void;
};

/**
 * Composer da referência: uma pílula só, numa linha ("+" num círculo, o campo "Perguntar a <bot>", o microfone num
 * círculo cinza e, colado nele, o círculo na cor do bot). O campo cresce quando o texto quebra e os botões ficam na
 * base. O botão da cor do bot é "enviar" com texto, "parar" durante o run (sem texto) e, parado e vazio, as ondas de
 * voz. O microfone dita por voz (barra de voz no lugar do composer, `dictation-bar.tsx`); o modo de voz (ondas) ainda é "em breve".
 *
 * Estrutura e borda como no `chat-composer` do web: uma View só, com `chromeEdge` e `chromeFill` (lib/surfaces.ts), colada na
 * pílula (sem respiro nem wrapper), com o raio total direto nela, nos dois formatos (pílula e retângulo).
 */
export function Composer({ initialText, botName, color, foreground, running, apiFetch, onSend, onStop, onSoon, onModel, modelPill, holdWriting, onWriting, replyTo, onCancelReply, mentionBots = NO_BOTS, skills = null, skillsLoading, skillsFailed, onSlash, initialMarkers, onCompact }: ComposerProps) {
	// `color` é o destaque do bot (`botAccent`): o primeiro plano é o que vem dele, sempre branco.
	const onColor = foreground;
	const scheme = useAppColorScheme();
	const surfaces = useSurfaces();
	// Marcadores (`@bot`, `/habilidade`) vivem fora do TextInput (ele não aceita componente no texto): chips antes do campo,
	// dentro da caixa. Um rascunho que já chega com `@Nome` ou `/slug` no começo vira chip.
	const start = React.useMemo(() => {
		const split = splitLeadingMarkers(initialText ?? "", mentionBots, skills ?? []);
		return { markers: [...(initialMarkers ?? []), ...split.markers], text: split.rest };
		// biome-ignore lint/correctness/useExhaustiveDependencies: só o estado inicial
	}, []);
	const [markers, setMarkers] = React.useState<Marker[]>(start.markers);
	const [text, setText] = React.useState(start.text);
	// A seleção é a do campo, que tem o sentinela na frente quando há marcadores (`fieldValue`); `caret` é a do texto.
	const offset = fieldOffset(markers.length);
	const [selection, setSelection] = React.useState({ start: start.text.length + fieldOffset(start.markers.length), end: start.text.length + fieldOffset(start.markers.length) });
	// Depois de escolher na lista (ou apagar um marcador), o cursor volta para o lugar certo (a prop `selection` só vale nesse instante).
	const [forcedSelection, setForcedSelection] = React.useState<{ start: number; end: number } | undefined>(undefined);
	const forceCaret = (caretInText: number, markerCount: number) => {
		const at = caretInText + fieldOffset(markerCount);
		setForcedSelection({ start: at, end: at });
		setSelection({ start: at, end: at });
	};
	// Lista fechada ao perder o foco (e reaberta ao voltar ou digitar). `pressing`: dedo na lista, ainda não fecha.
	const [closed, setClosed] = React.useState(false);
	const pressing = React.useRef(false);
	// Só abre com o cursor parado (sem trecho selecionado), calculado pelo cursor real e não pelo fim do texto.
	const caret = selection.start === selection.end ? Math.min(text.length, Math.max(0, selection.start - offset)) : null;
	const commands = React.useMemo(() => composerCommands({ compactAvailable: Boolean(onCompact) }), [onCompact]);
	const trigger = React.useMemo(
		() => (caret === null || closed ? null : triggerState(text, caret, { bots: mentionBots, skills, commands })),
		[text, caret, closed, mentionBots, skills, commands],
	);
	const slashOpen = trigger?.trigger === "/";
	React.useEffect(() => {
		if (slashOpen) onSlash?.();
		// biome-ignore lint/correctness/useExhaustiveDependencies: só quando o `/` abre
	}, [slashOpen]);
	// Rascunho que começa com `/slug`: lê as habilidades já na abertura e, quando chegam, o `/slug` vira chip (o que
	// foi digitado depois fica).
	const pendingDraftSkill = React.useRef(skills !== null && start.text.trimStart().startsWith("/"));
	React.useEffect(() => {
		if (pendingDraftSkill.current) onSlash?.();
		// biome-ignore lint/correctness/useExhaustiveDependencies: só na abertura
	}, []);
	React.useEffect(() => {
		if (!pendingDraftSkill.current || !skills || skills.length === 0) return;
		pendingDraftSkill.current = false;
		const adopted = adoptLeadingMarkers(markers, text, mentionBots, skills);
		if (adopted.consumed === 0) return;
		setMarkers(adopted.markers);
		setText(adopted.text);
		forceCaret(Math.max(0, (caret ?? text.length) - adopted.consumed), adopted.markers.length);
		// biome-ignore lint/correctness/useExhaustiveDependencies: só quando as habilidades chegam
	}, [skills]);
	const hasMarkers = markers.length > 0;
	// Entrar ou sair o primeiro chip muda o respiro do campo: a altura base de uma linha é medida de novo.
	const baselineMarkers = React.useRef(hasMarkers);
	// biome-ignore lint/correctness/useExhaustiveDependencies: só quando a presença de chips muda
	React.useEffect(() => {
		if (baselineMarkers.current !== hasMarkers) {
			baselineMarkers.current = hasMarkers;
			resetBaseline();
		}
	}, [hasMarkers]);
	const filled = hasContent(markers, text);
	const hasText = filled;
	// Anexos: sobem ao escolher; o envio só libera com tudo pronto. `attachmentsRef` é para o callback do ditado, que vive além de um render.
	const attachments = useAttachments(apiFetch);
	const attachmentsRef = React.useRef(attachments);
	attachmentsRef.current = attachments;
	const hasAttachments = attachments.drafts.length > 0;
	const [sheetOpen, setSheetOpen] = React.useState(false);
	const runPick = (outcome: PickOutcome) => {
		if (outcome.kind === "picked") attachments.add(outcome.files);
		else if (outcome.kind === "denied") setPickNotice(outcome.what === "camera" ? "Sem permissão para a câmera. Libere o acesso nas configurações." : "Sem permissão para as fotos. Libere o acesso nas configurações.");
		else if (outcome.kind === "failed") setPickNotice("Não consegui abrir agora. Tente de novo.");
	};
	const [pickNotice, setPickNotice] = React.useState<string | null>(null);
	const pickAttachment = (action: AttachmentAction) => {
		setSheetOpen(false);
		setPickNotice(null);
		attachments.dismissNotice();
		// O seletor nativo só abre depois que a folha terminou de fechar (no iOS, apresentar por cima de um Modal em saída falha).
		setTimeout(() => {
			if (action === "camera") void pickFromCamera().then(runPick);
			else if (action === "photos") void pickPhotos(attachments.imageSlots).then(runPick);
			else void pickDocuments().then(runPick);
		}, 350);
	};
	const inputRef = React.useRef<React.ComponentRef<typeof TextInput>>(null);
	const replyId = replyTo?.id;
	// Tocou em "Responder": o teclado abre no campo, pronto para digitar.
	React.useEffect(() => {
		if (replyId) inputRef.current?.focus();
	}, [replyId]);
	const { stacked, animate, measure, reset: resetStacked, resetBaseline } = useStackedLayout();
	const [focused, setFocused] = React.useState(false);
	// Modo de escrita: campo com foco ou com texto (ou a folha de modelo aberta). Só nele aparece a pílula e o composer
	// vira duas linhas (campo em cima, "+" e pílula à esquerda, microfone/enviar à direita). Fora dele, a pílula de uma linha.
	const writing = focused || hasText || hasAttachments || holdWriting === true;
	const open = stacked || writing;
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
	const [webHeight, setWebHeight] = React.useState(0);
	// O campo cresce com o texto até 40% da tela e rola por dentro depois disso.
	const maxFieldHeight = Math.round(useWindowDimensions().height * 0.4);
	// Largura do grupo da direita: microfone + botão da cor do bot.
	const rightWidth = BUTTON * 2 + 8;
	const mode = hasText || hasAttachments ? "send" : running ? "stop" : "voice";
	const sendBlocked = mode === "send" && !attachments.ready;
	const clearField = () => {
		setText("");
		setMarkers([]);
		resetStacked();
	};
	// Ditado: o falado entra no campo (somado ao que havia) para revisar, ou segue direto para o envio; cancelar não mexe no campo.
	// `latest` guarda o estado de agora para o callback do controlador, que vive além de um render.
	const latest = React.useRef({ text, markers });
	latest.current = { text, markers };
	const [dictationNotice, setDictationNotice] = React.useState<DictationProblem | null>(null);
	const onDictationFinish = ({ outcome, spoken }: { outcome: DictationOutcome; spoken: string }) => {
		const now = latest.current;
		const result = resolveDictation(outcome, now.text, spoken, fieldMaxLength(now.markers));
		if (outcome === "cancel") return;
		// Anexo ainda subindo: o falado fica no campo para revisar, em vez de enviar sem eles.
		if (result.send && attachmentsRef.current.ready) {
			onSend(composeMessage(now.markers, result.text), attachmentsRef.current.outgoing());
			attachmentsRef.current.clear();
			clearField();
			return;
		}
		if (result.text === now.text) return;
		animate();
		setText(result.text);
		forceCaret(result.text.length, now.markers.length);
		inputRef.current?.focus();
	};
	const dictation = useDictation({ onFinish: onDictationFinish, onProblem: setDictationNotice });
	const dictating = dictation.phase !== "idle";
	// A barra de voz empilhou (texto falado quebrou): a caixa troca para o raio do retângulo, como o campo.
	const [dictationStacked, setDictationStacked] = React.useState(false);
	React.useEffect(() => {
		if (!dictating) setDictationStacked(false);
	}, [dictating]);
	React.useEffect(() => {
		if (!dictationNotice) return;
		const timer = setTimeout(() => setDictationNotice(null), 8000);
		return () => clearTimeout(timer);
	}, [dictationNotice]);
	const startDictation = () => {
		setDictationNotice(null);
		inputRef.current?.blur();
		dictation.start();
	};
	const press = () => {
		if (mode === "send") {
			// `/compact [foco]` escrito à mão também é o comando (como no web); com o bot respondendo segue como texto.
			if (!attachments.ready) return;
			const command = onCompact && !running && markers.length === 0 && !hasAttachments ? parseCompactCommand(text) : null;
			if (command) {
				onCompact?.(command.focus);
				clearField();
				return;
			}
			onSend(composeMessage(markers, text), attachments.outgoing());
			attachments.clear();
			clearField();
		} else if (mode === "stop") onStop();
		else onSoon("voz");
	};
	// Escolheu na lista. No começo do texto livre vira chip; no meio da frase entra como texto no cursor (`applyPick`).
	const textWithoutTrigger = trigger && caret !== null ? removeTrigger(text, caret, trigger.start).text : text;
	const skillLimit = skillsFull(markers, textWithoutTrigger);
	const pick = (state: TriggerState, index: number) => {
		pressing.current = false;
		const next = applyPick(text, caret ?? text.length, state, index, { skillsFull: skillLimit });
		if (!next) return;
		animate();
		// Comando: entra no campo como `/compact ` (sem marcador, como no web). Enviar roda a compactação, com o foco que a
		// pessoa escrever depois (`parseCompactCommand` no envio).
		if (next.command) {
			setText(next.text);
			forceCaret(next.caret, markers.length);
			inputRef.current?.focus();
			return;
		}
		const nextMarkers = next.marker ? addMarker(markers, next.marker) : markers;
		setMarkers(nextMarkers);
		setText(next.text);
		forceCaret(next.caret, nextMarkers.length);
		inputRef.current?.focus();
	};
	const removeChip = (marker: Marker) => {
		animate();
		const nextMarkers = removeMarker(markers, marker);
		setMarkers(nextMarkers);
		forceCaret(caret ?? text.length, nextMarkers.length);
		inputRef.current?.focus();
	};
	return (
		<View className="mb-2 gap-2" style={{ marginHorizontal: 19.5 }}>
			{trigger ? <MentionPopup state={trigger} loading={skillsLoading} failed={skillsFailed} limitReached={skillLimit} onRetry={onSlash} onPick={pick} onPressChange={(down) => { pressing.current = down; }} commandBusy={running} /> : null}
			{dictationNotice ? <DictationNotice problem={dictationNotice} /> : null}
			<View className="overflow-hidden border" style={{ borderRadius: (dictating ? dictationStacked : open || replyTo || hasAttachments) ? STACKED_RADIUS : PILL_RADIUS, borderColor: surfaces.chromeEdge, backgroundColor: surfaces.chromeFill }}>
				{replyTo && onCancelReply ? <ReplyChip quote={replyTo} onCancel={onCancelReply} /> : null}
				{!dictating ? <ComposerAttachments drafts={attachments.drafts} notice={pickNotice ?? attachments.notice} onRemove={attachments.remove} /> : null}
				{dictating ? (
					<DictationBar spoken={dictation.spoken} color={color} foreground={onColor} busy={dictation.phase === "stopping"} onStackedChange={setDictationStacked} onCancel={dictation.cancel} onStop={() => dictation.stop("review")} onSend={() => dictation.stop("send")} />
				) : null}
				{/*
				  Um só TextInput nos dois formatos (assim o foco e o teclado não se perdem na troca). Os botões ficam sempre
				  em posição absoluta na base: com uma linha o campo fica entre eles (pílula); quando o texto quebra, o campo
				  ocupa a largura toda e reserva uma faixa embaixo para a linha de botões ("+" à esquerda, microfone e botão
				  da cor do bot à direita), como nas referências do dono.
				*/}
				{/* Escondido (não desmontado) durante o ditado: o campo e os marcadores ficam intactos até o desfecho. */}
				<View style={{ paddingBottom: open ? BUTTON + STACKED_INSET * 2 : 0, ...(dictating ? { display: "none" } : null) }}>
					{/*
					  Os chips e o campo fluem na mesma linha, que quebra: o TextInput vem logo depois do último chip (`flex: 1` com largura
					  mínima) e desce para a linha de baixo só quando não cabe. Sem chip é só o campo, como antes. A árvore é a mesma nos dois
					  casos (o campo não remonta ao entrar o primeiro chip, então o foco e o teclado ficam).
					*/}
					<View className="flex-row flex-wrap items-start" style={hasMarkers ? { paddingHorizontal: 16, paddingTop: 10, columnGap: 6, rowGap: 4 } : undefined}>
						{markers.map((marker) => (
							<MarkerChip key={`${marker.kind}:${marker.id}`} marker={marker} onRemove={removeChip} />
						))}
					<PasteImageInput onImages={attachments.add} style={hasMarkers ? { flexGrow: 1, flexShrink: 1, flexBasis: 120, minWidth: 120 } : { flex: 1 }}>
					<TextInput
						ref={inputRef}
						accessibilityLabel={`Perguntar a ${botName}`}
						placeholder={`Perguntar a ${botName}`}
						placeholderTextColor={themeColor(scheme, "muted-foreground")}
						value={fieldValue(markers.length, text)}
						onFocus={() => {
							animate();
							setFocused(true);
							setClosed(false);
						}}
						onBlur={() => {
							animate();
							setFocused(false);
							// Perdeu o foco (teclado fechado, toque fora): a lista fecha, menos com o dedo nela.
							setTimeout(() => {
								if (!pressing.current) setClosed(true);
							}, 100);
						}}
						onChangeText={(value) => {
							const read = readFieldChange(value, markers.length);
							setClosed(false);
							if (read.removeLast) {
								// O sentinela sumiu: backspace no começo do campo. Apaga o último marcador inteiro (sem depender do `onKeyPress`).
								animate();
								const nextMarkers = markers.slice(0, -1);
								setMarkers(nextMarkers);
								setText(read.text);
								forceCaret(0, nextMarkers.length);
								return;
							}
							if (hasContent(markers, read.text) !== hasText) animate();
							setText(read.text);
							if (read.text.length === 0) {
								resetStacked();
							}
						}}
						onContentSizeChange={(event) => {
							const height = event.nativeEvent.contentSize.height;
							// Na prévia web o campo não cresce sozinho (no celular, sim): a altura vem da medida.
							if (Platform.OS === "web") setWebHeight(height);
							// Com chips o composer já é o retângulo e a altura base é outra (sem o respiro): não entra na conta de quebra de linha.
							if (hasMarkers) return;
							// Quebrou em mais de uma linha: vira retângulo. Fica assim até esvaziar (sem vai e volta).
							measure(height);
						}}
						selection={forcedSelection}
						onSelectionChange={(event) => {
							setSelection(event.nativeEvent.selection);
							setForcedSelection(undefined);
						}}
						multiline
						maxLength={fieldMaxLength(markers) + offset}
						textAlignVertical={open ? "top" : "center"}
						style={{
							fontSize: 16,
							lineHeight: LINE_HEIGHT,
							...(hasMarkers
								? { paddingTop: 1.5, paddingBottom: 1.5, paddingLeft: 2, paddingRight: 0, minHeight: MARKER_HEIGHT }
								: {
										paddingTop: (MIN_HEIGHT - LINE_HEIGHT) / 2,
										paddingBottom: open ? 4 : (MIN_HEIGHT - LINE_HEIGHT) / 2,
										paddingLeft: open ? 16 : INSET + BUTTON + 8,
										paddingRight: open ? 16 : INSET + rightWidth + 8,
										flex: 1,
										minHeight: MIN_HEIGHT,
									}),
							maxHeight: maxFieldHeight,
							...(Platform.OS === "web" ? { height: Math.min(maxFieldHeight, Math.max(hasMarkers ? MARKER_HEIGHT : MIN_HEIGHT, webHeight)) } : {}),
						}}
						className="text-foreground outline-none"
					/>
					</PasteImageInput>
					</View>
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
							<Pressable role="button" accessibilityLabel="Adicionar" onPress={() => setSheetOpen(true)} style={{ width: BUTTON, height: BUTTON, backgroundColor: surfaces.chromeControl }} className="items-center justify-center rounded-full active:opacity-70">
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
							
							<Pressable role="button" accessibilityLabel="Ditado por voz" onPress={startDictation} style={{ width: BUTTON, height: BUTTON, backgroundColor: surfaces.chromeControl }} className="items-center justify-center rounded-full active:opacity-70">
								<MicIcon size={18} />
							</Pressable>
							<Pressable
								role="button"
								accessibilityLabel={sendBlocked ? "Enviar (aguardando os anexos)" : mode === "send" ? "Enviar" : mode === "stop" ? "Parar" : "Voz (em breve)"}
								onPress={press}
								disabled={sendBlocked}
								accessibilityState={{ disabled: sendBlocked }}
								style={{ backgroundColor: color, width: BUTTON, height: BUTTON, opacity: sendBlocked ? 0.5 : 1 }}
								className="items-center justify-center rounded-full active:opacity-80"
							>
								{mode === "send" ? <ArrowUpIcon size={18} color={onColor} /> : mode === "stop" ? <StopIcon size={16} color={onColor} /> : <WaveformIcon size={18} color={onColor} />}
							</Pressable>
						</View>
					</View>
				</View>
			</View>
			<AttachmentSheet open={sheetOpen} onPick={pickAttachment} onClose={() => setSheetOpen(false)} />
		</View>
	);
}
