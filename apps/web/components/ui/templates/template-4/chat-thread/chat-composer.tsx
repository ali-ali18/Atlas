"use client";

import {
	ArrowUpIcon,
	AudioLinesIcon,
	SquareIcon,
} from "lucide-react";
import {
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type MutableRefObject,
	type Ref,
} from "react";

import { activeTriggerQuery, modelDisplayName, servedModelNote, type ComposerTrigger } from "@workspace/shared";
import { composerCommandCandidates, resolveComposerCommand } from "@/lib/composer-commands";
import { useDictation, type DictationState } from "@/hooks/use-dictation";
import { mergeDictation, previewLabel } from "@/lib/dictation";
import { cn } from "@workspace/ui/lib/utils";
import { AnimatedAudioLines } from "./animated-audio-lines";
import { ModelPicker } from "@/components/model-picker";
import { ComposerImageAttachments } from "./composer-image-attachments";
import { ComposerFileAttachments } from "./composer-file-attachments";
import { MentionPopup, type MentionCandidate } from "./mention-popup";
import { composerEnterAction, isTouchKeyboardDevice } from "@/lib/composer-keys";
import { applyMention, mentionState, mentionedCandidates, stepMentionIndex, triggerState } from "@/lib/mention-input";
import { MentionChip } from "./mention-text";
import { ChatAddMenu, useAddMenuSkills } from "./chat-add-menu";
import { useMentionApps } from "@/hooks/use-mention-apps";
import { useDevPermission } from "@/hooks/use-dev-permission";
import { TestPrDialog } from "@/components/ai-elements/dev-session/test-pr-dialog";
import { useDevSessionsEnabled } from "@/hooks/use-dev-sessions-enabled";
import { useImageAttachments } from "@/hooks/use-image-attachments";
import { isImageFile, useFileAttachments, type OutgoingAttachment } from "@/hooks/use-file-attachments";
import { useAccountModelTiers } from "@/hooks/use-account-model-tiers";
import { useOpenRouterModels } from "@/hooks/use-openrouter-models";
import { getStoredDraft, setStoredDraft } from "@/lib/active-run";
import { DEFAULT_OPENROUTER_MODEL } from "@/lib/openrouter-models";
import { composerPrimaryAction, showSeparateMic } from "./composer-primary-action";
import { COMPOSER_FIELD_CLASS, shouldStickToEnd } from "./composer-scroll";
import { useSecretPasteGuard } from "./use-secret-paste-guard";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@workspace/ui/components/tooltip";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupTextarea,
} from "@workspace/ui/components/input-group";

function mergeRefs<T>(
	...refs: Array<Ref<T> | undefined>
): (node: T | null) => void {
	return (node) => {
		for (const ref of refs) {
			if (!ref) continue;
			if (typeof ref === "function") ref(node);
			else (ref as MutableRefObject<T | null>).current = node;
		}
	};
}

export function ChatComposer({
	agentName,
	conversationKey,
	dictation: dictationOverride,
	disabled = false,
	initialText = "",
	language,
	model = DEFAULT_OPENROUTER_MODEL,
	onModelChange,
	onSend,
	onStop,
	prefill,
	runActive = false,
	servedModel,
	textareaRef,
	mentionMembers,
	mentionBots,
	onCompact,
	dock,
}: {
	/** Chat 1:1: `/compact [foco]` resume a conversa em vez de virar mensagem; ausente = o comando não é oferecido. */
	onCompact?: (focus?: string) => void;
	/** Chat 1:1: os outros bots do usuário que o `@` oferece (as skills do `/` vêm da conta). */
	mentionBots?: readonly MentionCandidate[];
	/** Aprovação pendente fixada logo acima do campo (ver ApprovalDock). */
	dock?: import("react").ReactNode;
	/** Grupo: membros que o `@` oferece. Presente = modo grupo (sem modelo nem anexos; as falas são do grupo). */
	mentionMembers?: readonly MentionCandidate[];
	agentName: string;
	conversationKey?: string;
	/** Injeção para testes; padrão = ditado real do navegador. */
	dictation?: DictationState;
	disabled?: boolean;
	/** Texto inicial do campo (rascunho; também serve de seam nos testes de SSR). */
	initialText?: string;
	/** Idioma do bot: define o idioma do reconhecimento de fala. */
	language?: string | null;
	model?: string;
	onModelChange?: (model: string) => void;
	onSend: (text: string, attachments: OutgoingAttachment[]) => void;
	/** Para o run agora (mesmo caminho do cancelar). */
	onStop?: () => void;
	/** Prefill vindo de fora (ex.: "Editar com o agente") — {text, nonce} refoca a cada nonce novo. */
	prefill?: { text: string; nonce: number };
	runActive?: boolean;
	/** Modelo que respondeu no último run; só aparece se difere do escolhido. */
	servedModel?: string | null;
	textareaRef?: Ref<HTMLTextAreaElement>;
}) {
	const [value, setValue] = useState(initialText);
	const groupMode = Boolean(mentionMembers);
	const [caret, setCaret] = useState(0);
	const [mentionIndex, setMentionIndex] = useState(0);
	const [touch, setTouch] = useState(false);
	useEffect(() => setTouch(isTouchKeyboardDevice()), []);
	const [mentionClosedAt, setMentionClosedAt] = useState<number | null>(null);
	// `/` carrega as skills só na primeira vez que a pessoa a digita.
	const slashTyped = !groupMode && activeTriggerQuery(value, caret, "/") !== null;
	const { skills: menuSkills, loading: skillsLoading } = useAddMenuSkills(slashTyped);
	const skillCandidates = useMemo<MentionCandidate[]>(() => {
		const seen = new Set<string>();
		// `/` também oferece os comandos do composer (hoje só /compact), antes das skills.
		const out: MentionCandidate[] = composerCommandCandidates({ compactAvailable: Boolean(onCompact), groupMode });
		for (const skill of menuSkills) {
			if (seen.has(skill.slug)) continue;
			seen.add(skill.slug);
			out.push({ id: skill.slug, name: skill.slug, description: skill.description });
		}
		return out;
	}, [menuSkills, onCompact, groupMode]);
	// `@` também oferece os apps (conectores) do usuário; carregam uma vez, na 1ª vez que `@` é digitado.
	const atTyped = !groupMode && activeTriggerQuery(value, caret, "@") !== null;
	const mentionApps = useMentionApps(atTyped);
	const botCandidates = useMemo<MentionCandidate[]>(() => (mentionBots ?? []).map((bot) => ({ ...bot, kind: "bot" as const })), [mentionBots]);
	const appCandidates = useMemo<MentionCandidate[]>(
		() => (mentionApps ?? []).map((app) => ({ id: app.id, name: app.name, description: app.description, kind: "app" as const, logo: app.logo, connected: app.connected })),
		[mentionApps],
	);
	// Chips acima do campo: avatar do bot / logo do app de cada `@Nome` já escrito. O texto do campo não muda
	// (um overlay com imagem no lugar do "@" desalinharia o cursor), então a identidade visual fica numa linha própria.
	const mentioned = useMemo(
		() => (groupMode ? [] : mentionedCandidates(value, [...botCandidates, ...appCandidates])),
		[groupMode, value, botCandidates, appCandidates],
	);
	const groupState = groupMode && mentionMembers?.length ? mentionState(value, caret, mentionMembers) : null;
	const mention: { trigger: ComposerTrigger; start: number; query: string; candidates: MentionCandidate[] } | null = groupMode
		? groupState && { trigger: "@", ...groupState }
		: triggerState(value, caret, { skills: skillCandidates, bots: botCandidates, apps: appCandidates });
	const mentionOpen = mention !== null && mentionClosedAt !== mention.start;
	const mentionQuery = mention?.query;
	// biome-ignore lint/correctness/useExhaustiveDependencies: a consulta nova volta o destaque ao primeiro item.
	useEffect(() => setMentionIndex(0), [mentionQuery]);
	const { models, loading } = useOpenRouterModels();
	const tierModelIds = useAccountModelTiers();
	const localTextareaRef = useRef<HTMLTextAreaElement | null>(null);
	const imageInputRef = useRef<HTMLInputElement | null>(null);
	const cameraInputRef = useRef<HTMLInputElement | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const [dragging, setDragging] = useState(false);
	const images = useImageAttachments();
	const files = useFileAttachments();
	/** Imagens vão pelo anexo de imagem; o resto, qualquer tipo, pelo anexo de arquivo. */
	function addAny(list: FileList | File[]) {
		const all = Array.from(list);
		const pictures = all.filter(isImageFile);
		const others = all.filter((file) => !isImageFile(file));
		if (pictures.length) void images.addFiles(pictures);
		if (others.length) files.addFiles(others);
	}
	const devSessionsEnabled = useDevSessionsEnabled();
	const [testPrOpen, setTestPrOpen] = useState(false);
	const permission = useDevPermission(devSessionsEnabled);
	const hasMessage = value.trim().length > 0 || images.ready.length > 0 || files.ready.length > 0;
	const selectedModel = models.find((item) => item.id === model);
	// Automático (modelo vazio): mostra qual modelo respondeu, mesmo sem um modelo escolhido para comparar.
	const servedNote = model ? servedModelNote(model, servedModel) : servedModel?.trim() || null;
	const servedLabel = servedNote
		? modelDisplayName(models.find((item) => item.id === servedNote)?.name, servedNote)
		: null;
	const modalities = selectedModel && "inputModalities" in selectedModel && Array.isArray(selectedModel.inputModalities) ? selectedModel.inputModalities : null;
	const visionKnown = modalities !== null;
	const hasVision = modalities?.includes("image") ?? false;
	const valueRef = useRef(value);
	valueRef.current = value;
	const [dictationError, setDictationError] = useState<string | null>(null);
	const ownDictation = useDictation({
		language,
		onInsert: (text) => updateValue(mergeDictation(valueRef.current, text)),
		onError: (message) => setDictationError(message),
	});
	const dictation = dictationOverride ?? ownDictation;
	const dictating = dictation.phase !== "idle";
	const recording = dictation.phase === "recording";
	const primaryAction = composerPrimaryAction({
		runActive,
		hasContent: hasMessage,
		uploading: images.uploading || files.uploading,
		dictationSupported: dictation.supported,
		dictationState: dictation.phase,
	});
	const separateMic = showSeparateMic({ runActive, dictationSupported: dictation.supported });
	const transcribing = dictation.phase === "transcribing";
	const previewText = previewLabel(dictation.phase, dictation.preview) || (transcribing ? "Transcrevendo…" : "");
	const previewSeparator = value && !/\s$/.test(value) ? " " : "";

	useEffect(() => {
		if (!conversationKey) return;
		setValue(getStoredDraft(conversationKey));
	}, [conversationKey]);

	useEffect(() => {
		if (!prefill) return;
		setValue(prefill.text);
		if (conversationKey) setStoredDraft(conversationKey, prefill.text);
		const textarea = localTextareaRef.current;
		textarea?.focus();
		// Cursor no fim do texto pronto ("… — "), para a pessoa continuar a frase; só depois do React aplicar o valor.
		if (textarea) {
			const end = prefill.text.length;
			requestAnimationFrame(() => textarea.setSelectionRange(end, end));
		}
		// biome-ignore lint/correctness/useExhaustiveDependencies: só o nonce dispara o refill.
	}, [prefill?.nonce]);

	// Esc em qualquer lugar da página cancela o ditado e não insere nada.
	const cancelDictation = dictation.cancel;
	useEffect(() => {
		if (!dictating) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") cancelDictation();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [dictating, cancelDictation]);

	useEffect(() => {
		if (!dictationError) return;
		const timer = setTimeout(() => setDictationError(null), 5000);
		return () => clearTimeout(timer);
	}, [dictationError]);

	// Cursor no fim de um campo que passou do teto: mantém a última linha à vista ao digitar/colar.
	// biome-ignore lint/correctness/useExhaustiveDependencies: roda a cada mudança do texto.
	useLayoutEffect(() => {
		const textarea = localTextareaRef.current;
		const field = textarea?.parentElement;
		if (!textarea || !field) return;
		const focused = textarea.ownerDocument.activeElement === textarea;
		if (shouldStickToEnd({ focused, selectionStart: textarea.selectionStart, selectionEnd: textarea.selectionEnd, valueLength: textarea.value.length })) {
			field.scrollTop = field.scrollHeight;
		}
	}, [value]);

	function updateValue(next: string) {
		setValue(next);
		if (conversationKey) setStoredDraft(conversationKey, next);
	}

	function pickMention(candidate: MentionCandidate) {
		if (!mention) return;
		const next = applyMention(value, caret, mention.start, candidate.name, mention.trigger);
		updateValue(next.value);
		setCaret(next.caret);
		setMentionClosedAt(null);
		requestAnimationFrame(() => {
			const element = localTextareaRef.current;
			element?.focus();
			element?.setSelectionRange(next.caret, next.caret);
		});
	}

	const secretGuard = useSecretPasteGuard({ value, setValue: updateValue, send: () => submit() });

	function submit() {
		if (secretGuard.intercept()) return;
		const trimmed = value.trim();
		if ((!trimmed && images.ready.length === 0 && files.ready.length === 0) || disabled || images.uploading || files.uploading) return;
		// `/compact [foco]` é comando do composer: não vai como mensagem nem entra no histórico.
		const command = resolveComposerCommand(trimmed, { compactAvailable: Boolean(onCompact), groupMode, hasAttachments: images.ready.length > 0 || files.ready.length > 0 });
		if (command) {
			onCompact?.(command.focus);
			updateValue("");
			return;
		}
		onSend(trimmed, [...images.ready, ...files.ready]);
		updateValue("");
		images.clear();
		files.clear();
	}

	return (
		<div className="absolute inset-x-0 bottom-0">
			<div className="pointer-events-none h-10 bg-linear-to-t from-background to-transparent" />
			<div className="bg-background px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
				{dock}
				<form
					className={`relative z-10 mx-auto w-full max-w-3xl rounded-3xl bg-background ${dragging ? "rounded-3xl ring-2 ring-primary" : ""}`}
					onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
					onDragOver={(event) => event.preventDefault()}
					onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
					onDrop={(event) => { event.preventDefault(); setDragging(false); addAny(event.dataTransfer.files); }}
					onSubmit={(event) => {
						event.preventDefault();
						submit();
					}}
				>
					<input accept="image/png,image/jpeg,image/webp,image/gif" aria-label="Selecionar imagens" className="sr-only" multiple onChange={(event) => { if (event.target.files) void images.addFiles(event.target.files); event.target.value = ""; }} ref={imageInputRef} type="file" />
					<input aria-label="Selecionar arquivos" className="sr-only" multiple onChange={(event) => { if (event.target.files) addAny(event.target.files); event.target.value = ""; }} ref={fileInputRef} type="file" />
					<input accept="image/*" aria-label="Tirar foto" capture="environment" className="sr-only" onChange={(event) => { if (event.target.files) void images.addFiles(event.target.files, true); event.target.value = ""; }} ref={cameraInputRef} type="file" />
					{secretGuard.notice}
					{dictationError && <p aria-live="polite" className="mb-1 text-muted-foreground text-xs">{dictationError}</p>}
					{images.error && <p aria-live="polite" className="mb-1 text-destructive text-xs">{images.error}</p>}
					{files.error && <p aria-live="polite" className="mb-1 text-destructive text-xs">{files.error}</p>}
					{files.hasError && <p aria-live="polite" className="mb-1 text-destructive text-xs">Falha ao enviar um arquivo. Remova e tente novamente.</p>}
					{images.items.some((item) => item.status === "error") && <p aria-live="polite" className="mb-1 text-destructive text-xs">Falha ao enviar uma imagem. Remova e tente novamente.</p>}
					{images.items.length > 0 && !hasVision && <p className="mb-1 text-muted-foreground text-xs">{visionKnown ? "Este modelo não vê imagens; vou descrever com um modelo de apoio se disponível." : "A visão deste modelo é desconhecida; se ele não enxergar, troque para um modelo com visão."}</p>}
					<div aria-live="polite" className="sr-only">{dragging ? "Solte os arquivos para anexar" : ""}</div>
					<div className="relative">
					{mentionOpen && mention ? (
						<MentionPopup
							activeIndex={mentionIndex}
							ariaLabel={mention.trigger === "@" && !groupMode ? "Mencionar bot ou app" : undefined}
							candidates={mention.candidates}
							emptyLabel={mention.trigger === "/" ? (skillsLoading ? "Carregando skills…" : undefined) : groupMode ? undefined : "Nenhum bot ou app"}
							trigger={mention.trigger}
							onHover={setMentionIndex}
							onPick={(candidate) => pickMention(candidate)}
						/>
					) : null}
					<InputGroup className="h-auto rounded-3xl border-border bg-input p-1">
						<ComposerImageAttachments items={images.items} onRemove={images.remove} />
						<ComposerFileAttachments items={files.items} onRemove={files.remove} />
						{mentioned.length > 0 ? (
							<ul aria-label="Menções na mensagem" className="col-span-full flex w-full flex-wrap gap-1.5 px-3 pt-1.5 text-xs" data-slot="composer-mentions">
								{mentioned.map((item) => (
									<li key={item.id}>
										<MentionChip member={{ id: item.id, name: item.name, color: item.color, shape: item.shape, kind: item.kind === "app" ? "app" : "bot", logo: item.logo }} text={`@${item.name}`} />
									</li>
								))}
							</ul>
						) : null}
						{/* Textarea e overlay dividem a mesma célula do grid: o overlay repete as métricas do texto
						    (digitado transparente, prévia em itálico logo depois), então a prévia flui na linha do
						    cursor e a altura cresce junto. O wrapper é quem rola; o textarea real segue intacto. */}
						<div className={COMPOSER_FIELD_CLASS} data-slot="composer-field">
							<InputGroupTextarea
								ref={mergeRefs(textareaRef, localTextareaRef)}
								aria-label={`Mensagem para ${agentName}`}
								className="field-sizing-content col-start-1 row-start-1 max-h-none min-h-7 self-stretch overflow-hidden py-1.5 text-sm"
								disabled={disabled}
								onPaste={(event) => { const pasted = Array.from(event.clipboardData.files); if (pasted.length) { event.preventDefault(); addAny(pasted); } }}
								onChange={(event) => {
									updateValue(event.target.value);
									setCaret(event.target.selectionStart ?? event.target.value.length);
									setMentionClosedAt(null);
								}}
								onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
								onKeyDown={(event) => {
									if (mentionOpen && mention && event.key === "Escape") {
										event.preventDefault();
										setMentionClosedAt(mention.start);
										return;
									}
									if (mentionOpen && mention && mention.candidates.length > 0) {
										if (event.key === "ArrowDown" || event.key === "ArrowUp") {
											event.preventDefault();
											setMentionIndex((index) => stepMentionIndex(index, event.key === "ArrowDown" ? 1 : -1, mention.candidates.length));
											return;
										}
										if (event.key === "Tab") {
											event.preventDefault();
											pickMention(mention.candidates[Math.min(mentionIndex, mention.candidates.length - 1)]!);
											return;
										}
									}
									if (event.key === "Escape" && dictating) {
										event.preventDefault();
										dictation.cancel();
										return;
									}
									if (event.key === "Enter") {
										const action = composerEnterAction({
											touch,
											shift: event.shiftKey,
											mentionOpen,
											hasCandidates: Boolean(mention && mention.candidates.length > 0),
											composing: event.nativeEvent.isComposing,
										});
										if (action === "newline") return;
										event.preventDefault();
										if (action === "pick-mention" && mention) pickMention(mention.candidates[Math.min(mentionIndex, mention.candidates.length - 1)]!);
										else submit();
									}
								}}
								enterKeyHint={touch ? "enter" : "send"}
								placeholder={dictating ? "" : `Mensagem para ${agentName}`}
								rows={1}
								value={value}
							/>
							{dictating && (
								<div
									aria-hidden="true"
									className="pointer-events-none col-start-1 row-start-1 whitespace-pre-wrap break-words px-3 py-1.5 text-sm"
									data-slot="dictation-preview"
								>
									<span className="text-transparent">{value}</span>
									<span className={cn("text-muted-foreground italic", transcribing && "animate-pulse")}>
										{previewText ? `${previewSeparator}${previewText}` : ""}
									</span>
								</div>
							)}
							{dictating && <span aria-live="polite" className="sr-only">{previewText}</span>}
						</div>
						<InputGroupAddon align="block-end" className="justify-between">
							<div className="flex min-w-0 items-center gap-1">
								{groupMode ? null : (
								<ChatAddMenu
									onPickFile={() => fileInputRef.current?.click()}
									onPickPhotos={() => imageInputRef.current?.click()}
									onPickSkill={(skill) => {
										updateValue(`Use a skill "${skill.name}": `);
										localTextareaRef.current?.focus();
									}}
									onTakePhoto={() => cameraInputRef.current?.click()}
									onTestPr={() => setTestPrOpen(true)}
									permission={devSessionsEnabled ? { mode: permission.mode, onChange: permission.change } : undefined}
									showTestPr={devSessionsEnabled}
								/>
								)}
								{groupMode ? null : (
								<ModelPicker
									emptyLabel="Automático"
									loading={loading}
									models={models}
									onChange={(next) => onModelChange?.(next)}
									suggestedHeading="Dos seus níveis"
									suggestedIds={tierModelIds}
									trigger={
										<InputGroupButton
											aria-label="Modelo de linguagem"
											className="max-w-[12rem] shrink gap-1.5 px-2 text-xs"
											disabled={disabled}
											type="button"
											variant="ghost"
										/>
									}
									value={model}
								/>
								)}
								{servedLabel ? (
									<span
										className="max-w-[10rem] truncate text-muted-foreground text-xs"
										title={model ? `Respondido por ${servedLabel} (o modelo escolhido não atendeu)` : `Respondido por ${servedLabel} (escolhido pela dificuldade)`}
									>
										via {servedLabel}
									</span>
								) : null}
							</div>
						<div className="flex items-center gap-1">
							{separateMic && (
								<Tooltip>
									<TooltipTrigger
										render={
											<InputGroupButton
												aria-label={recording ? "Parar ditado" : "Ditar"}
												aria-pressed={recording}
												disabled={disabled || transcribing}
												onClick={() => (recording ? dictation.stop() : dictation.start())}
												size="icon-sm"
												type="button"
												variant="secondary"
											/>
										}
									>
										{recording ? <AnimatedAudioLines /> : <AudioLinesIcon />}
									</TooltipTrigger>
									<TooltipContent className="px-2 py-1 text-[11px]">{recording ? "Parar ditado (Esc cancela)" : "Ditar"}</TooltipContent>
								</Tooltip>
							)}
							{primaryAction === "stop" ? (
								<Tooltip>
									<TooltipTrigger
										render={
											<InputGroupButton
												aria-label="Parar"
												className="bg-(--bot-accent,var(--primary)) text-(--bot-accent-foreground,var(--primary-foreground)) hover:bg-(--bot-accent,var(--primary))/90"
												disabled={!onStop}
												onClick={() => onStop?.()}
												size="icon-sm"
												type="button"
												variant="default"
											/>
										}
									>
										<SquareIcon className="fill-current" />
									</TooltipTrigger>
									<TooltipContent className="px-2 py-1 text-[11px]">Parar a tarefa</TooltipContent>
								</Tooltip>
							) : primaryAction === "dictate" || primaryAction === "dictating" ? (
								<Tooltip>
									<TooltipTrigger
										render={
											<InputGroupButton
												aria-label={recording ? "Parar ditado" : "Ditar"}
												aria-pressed={recording}
												className="bg-(--bot-accent,var(--primary)) text-(--bot-accent-foreground,var(--primary-foreground)) hover:bg-(--bot-accent,var(--primary))/90"
												disabled={disabled || transcribing}
												onClick={() => (recording ? dictation.stop() : dictation.start())}
												size="icon-sm"
												type="button"
												variant="default"
											/>
										}
									>
										{recording ? <AnimatedAudioLines /> : <AudioLinesIcon />}
									</TooltipTrigger>
									<TooltipContent className="px-2 py-1 text-[11px]">{recording ? "Parar ditado (Esc cancela)" : "Ditar"}</TooltipContent>
								</Tooltip>
							) : (
								<InputGroupButton
									aria-label="Enviar mensagem"
									className="bg-(--bot-accent,var(--primary)) text-(--bot-accent-foreground,var(--primary-foreground)) hover:bg-(--bot-accent,var(--primary))/90"
									disabled={disabled || primaryAction === "send-disabled"}
									size="icon-sm"
									title="Enviar mensagem"
									type="submit"
									variant="default"
								>
									<ArrowUpIcon />
								</InputGroupButton>
							)}
						</div>
						</InputGroupAddon>
					</InputGroup>
					</div>
				</form>
				{groupMode ? null : <TestPrDialog conversationId={conversationKey} onOpenChange={setTestPrOpen} onSubmit={(message) => onSend(message, [])} open={testPrOpen} />}
			</div>
		</div>
	);
}
