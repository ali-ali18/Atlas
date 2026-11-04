
import { resolveColor } from "@workspace/shared/avatar/identity";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import * as React from "react";
import { BackHandler, FlatList, KeyboardAvoidingView, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronDownIcon } from "@/components/icons";
import { SoonSheet } from "@/components/home/soon-sheet";
import { ChatMenu, type ChatMenuAction } from "@/components/chat/chat-menu";
import { Fade } from "@/components/ui/fade";
import { ChatTopBar, TOP_BAR_HEIGHT } from "@/components/chat/chat-top-bar";
import { ChatSearchBar } from "@/components/chat/chat-search-bar";
import { ChatSearchProvider } from "@/components/chat/search-highlight";
import { useChatSearch } from "@/lib/use-chat-search";
import { Composer } from "@/components/chat/composer";
import { ModelSheet } from "@/components/chat/model-sheet";
import { modelPill as buildModelPill } from "@/lib/model-pill";
import { MessageRow, type RowActions } from "@/components/chat/message-row";
import { useMessageMenu } from "@/components/chat/use-message-menu";
import { grokBubbleColors } from "@/lib/bubble-tone";
import { createNewItemTracker } from "@/lib/chat-appear";
import { groupPositionAt, parseSlashSkills, type GroupPosition } from "@workspace/shared";
import { SyncLine, ThinkingLine } from "@/components/chat/sync-line";
import { ScreenFrame } from "@/components/ui/screen-frame";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { useAtlasSession } from "@/lib/atlas-session";
import { botColors } from "@/lib/bot-color";
import { exchangePeerId } from "@/lib/bot-thread";
import { themeColor } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";
import { type ViewerTarget, viewerTargetForCard } from "@/lib/viewer-target";
import { ImageViewer } from "@/components/image-viewer/image-viewer";
import { useImageActions } from "@/components/image-viewer/use-image-actions";
import { ViewerSheet } from "@/components/viewer/viewer-sheet";
import { webChatUrl } from "@/lib/chat-links";
import { groupConsecutiveImages } from "@/lib/image-group";
import { collectViewerImages, viewerStartIndex } from "@/lib/image-viewer";
import type { ChatItem, ReplyQuote } from "@/lib/chat-types";
import { containsTable } from "@/lib/markdown";
import { replyQuoteFor } from "@/lib/reply-quote";
import { useChat } from "@/lib/use-chat";
import { mentionableBots } from "@/lib/mention-input";
import { useComposerSkills } from "@/lib/use-composer-skills";
import { ensureHomeBot } from "@/lib/ensure-bot";
import { useHomeData } from "@/lib/home-data";
import { fetchHomeBot } from "@/lib/home-sync";
import { useRequestActions } from "@/lib/use-request-actions";

/** Rolou para cima além disto (px do fim): aparece o botão de voltar ao fim. */
const JUMP_THRESHOLD = 360;
/** Respiro entre a última mensagem (ou a linha "Pensando…") e o composer que flutua sobre a lista. */
const LAST_MESSAGE_GAP = 16;

type Soon = "anexos" | "voz" | "compartilhar" | null;
const SOON_TITLE: Record<NonNullable<Soon>, string> = { anexos: "Anexos", voz: "Voz", compartilhar: "Compartilhar como modelo" };

const NO_IDS: ReadonlySet<string> = new Set();

/** Posição de cada fala no grupo do mesmo autor, em ordem de conversa (a lista mostra invertida). */
function bubblePositions(items: readonly ChatItem[]): ReadonlyMap<string, GroupPosition> {
	// Resposta vazia (ainda sem texto) não aparece e não conta para o grupo.
	const shown = items.filter((item) => item.kind !== "assistant" || item.text.trim());
	// Fala com tabela vira um cartão e não agrupa: os balões vizinhos ficam com a ponta arredondada junto dela, em vez da reta de falas seguidas.
	const kinds = shown.map((item) => (item.kind === "assistant" && containsTable(item.text) ? "assistant-table" : item.kind));
	return new Map(shown.map((item, index) => [item.id, groupPositionAt(kinds, index, (kind) => kind === "user" || kind === "assistant")]));
}

/** Ids que acabaram de chegar (ver `createNewItemTracker`); vazio até a conversa ficar pronta. */
function useNewItemIds(items: readonly ChatItem[], ready: boolean): ReadonlySet<string> {
	const tracker = React.useRef(createNewItemTracker());
	return React.useMemo(() => (ready ? tracker.current.next(items) : NO_IDS), [items, ready]);
}

/** Chat com o bot: o fio (cache + servidor + run ao vivo), o topo flutuante, a doca de tarefas e o composer. */
export default function ChatScreen() {
	const router = useRouter();
	const scheme = useAppColorScheme();
	const insets = useSafeAreaInsets();
	const { id, draft } = useLocalSearchParams<{ id: string; draft?: string }>();
	const { snapshot, addBot, refresh } = useHomeData();
	const { serverUrl, apiFetch } = useAtlasSession();
	const bot = snapshot?.bots.find((item) => item.id === id);
	const chat = useChat(bot);
	// `@` oferece os outros bots (no grupo, os membros) e `/` as habilidades (só no 1:1, como no web).
	const mentionBots = React.useMemo(() => mentionableBots(snapshot?.bots ?? [], bot), [snapshot?.bots, bot]);
	const composerSkills = useComposerSkills();
	// Avatares das menções e do marcador "Enviou mensagem para X": todos os bots do usuário. Habilidades: as já lidas.
	const rowBots = React.useMemo(() => (snapshot?.bots ?? []).map((item) => ({ id: item.id, name: item.name, color: item.color, shape: item.shape })), [snapshot?.bots]);
	// Há `/habilidade` numa fala do usuário: lê a lista (uma vez) para desenhar o marcador, sem esperar o `/` do composer.
	const hasSlashText = React.useMemo(() => chat.items.some((item) => item.kind === "user" && parseSlashSkills(item.text).length > 0), [chat.items]);
	const loadSkills = composerSkills.load;
	React.useEffect(() => {
		if (hasSlashText && bot && bot.memberIds.length === 0) loadSkills();
	}, [hasSlashText, bot, loadSkills]);
	const skillSet = React.useMemo(() => new Set(composerSkills.skills.map((skill) => skill.name)), [composerSkills.skills]);
	const listRef = React.useRef<FlatList<ChatItem>>(null);
	const [farFromEnd, setFarFromEnd] = React.useState(false);
	const [menu, setMenu] = React.useState(false);
	// Altura do composer (cresce com o texto): a lista passa por baixo dele e reserva esse espaço no fim.
	const [composerHeight, setComposerHeight] = React.useState(64);
	const [soon, setSoon] = React.useState<Soon>(null);
	const [modelOpen, setModelOpen] = React.useState(false);
	const modelPill = React.useMemo(() => buildModelPill(chat.modelSelector.choice, chat.modelSelector.catalog.catalog), [chat.modelSelector.choice, chat.modelSelector.catalog.catalog]);
	const goBack = React.useCallback(() => (router.canGoBack() ? router.back() : router.replace("/")), [router]);
	const openProfile = React.useCallback(() => router.push(`/profile/${encodeURIComponent(id)}` as never), [router, id]);
	// Cartão já aprovado (em outro aparelho, ou a home perdeu o bot): busca o bot antes de abrir, senão a tela diria "Não encontrei esta conversa".
	const botIds = snapshot?.bots;
	const openBot = React.useCallback(
		(botId: string) => {
			const open = () => router.push(`/chat/${encodeURIComponent(botId)}` as never);
			if (botIds?.some((item) => item.id === botId)) return open();
			void ensureHomeBot({ fetchBot: (wanted) => fetchHomeBot(apiFetch, wanted), addBot, refresh }, botId).then(open);
		},
		[router, botIds, apiFetch, addBot, refresh],
	);
	const openWeb = React.useCallback(
		(_item: Extract<ChatItem, { kind: "web-card" }>) => {
			const url = webChatUrl(serverUrl, id);
			if (url) void WebBrowser.openBrowserAsync(url).catch(() => undefined);
		},
		[serverUrl, id],
	);
	// Painel e documento abrem numa folha por cima da conversa; o que não tem destino nativo continua no navegador.
	const [viewer, setViewer] = React.useState<ViewerTarget | null>(null);
	const closeViewer = React.useCallback(() => setViewer(null), []);
	const openPage = React.useCallback(
		(item: Extract<ChatItem, { kind: "web-card" }>) => {
			const target = viewerTargetForCard(item);
			if (target) setViewer(target);
			else openWeb(item);
		},
		[openWeb],
	);
	// O que se desenha: imagens seguidas viram um leque só (pura, depois do merge; o dedupe segue por evento).
	const shownItems = React.useMemo(() => groupConsecutiveImages(chat.items), [chat.items]);
	// Visualizador de imagens: todas as imagens do fio, abrindo na tocada (o índice é fixado ao abrir).
	const viewerImages = React.useMemo(() => collectViewerImages(shownItems), [shownItems]);
	const [imageStart, setImageStart] = React.useState<number | null>(null);
	const imageActions = useImageActions();
	const openImage = React.useCallback((artifactId: string) => setImageStart(viewerStartIndex(viewerImages, artifactId)), [viewerImages]);
	const closeImage = React.useCallback(() => setImageStart(null), []);
	const request = useRequestActions();
	// "Abrir a tela": o app ainda não tem o computador do bot; abre o chat no navegador, onde o web tem o viewer da VM.
	const openScreen = React.useCallback(() => {
		const url = webChatUrl(serverUrl, id);
		if (url) void WebBrowser.openBrowserAsync(url).catch(() => undefined);
	}, [serverUrl, id]);
	// "Responder": a mensagem citada fica no chip do composer até enviar ou cancelar.
	const [replyTo, setReplyTo] = React.useState<ReplyQuote | null>(null);
	const startReply = React.useCallback((item: ChatItem) => setReplyTo(replyQuoteFor(item)), []);
	const messageMenu = useMessageMenu({ chat, goBack, composerHeight, onReply: startReply });
	// Cor do bot para o botão do composer (destaque e o que fica por cima dele).
	const palette = React.useMemo(
		() => botColors(resolveColor(bot?.color, id), { accent: themeColor(scheme, "primary"), foreground: themeColor(scheme, "primary-foreground") }),
		[bot?.color, id, scheme],
	);
	// Balão do usuário na cor do bot, como no web (`grokBubbleColors`: o tom do Grok; texto branco, ou escuro em cor clara); sem cor válida, cinza.
	const userBubble = React.useMemo(() => grokBubbleColors(bot?.color) ?? undefined, [bot?.color]);
	// Conversa entre bots: a linha "N mensagens com X" abre a tela somente leitura (o servidor só entrega se os dois são do dono).
	const bots = snapshot?.bots;
	const botFor = React.useCallback((botId: string) => bots?.find((item) => item.id === botId), [bots]);
	const openExchange = React.useCallback(
		(item: Extract<ChatItem, { kind: "bot-exchange" }>) => {
			const peer = exchangePeerId(item);
			if (!peer) return;
			const focus = item.focus ? `&focus=${encodeURIComponent(item.focus)}` : "";
			router.push(`/bot-thread/${encodeURIComponent(id)}?peer=${encodeURIComponent(peer)}${focus}` as never);
		},
		[router, id],
	);
	const actions = React.useMemo<RowActions>(
		() => ({
			onDecide: chat.decide,
			onAnswer: chat.answer,
			onResolveProposal: chat.resolveProposal,
			onOpenBot: openBot,
			botFor,
			onOpenExchange: openExchange,
			onOpenWeb: openWeb,
			onOpenPage: openPage,
			onResumeLogin: chat.resumeLogin,
			onOpenScreen: openScreen,
			onConnectLogin: chat.connectLogin,
			connects: chat.connects,
			request,
			botName: bot?.name ?? "bot",
			serverUrl,
			onOpenMenu: messageMenu.open,
			onOpenImage: openImage,
			activeRunId: chat.runTasks?.runId ?? null,
			running: chat.running,
			userBubble: userBubble,
			bots: rowBots,
			skills: skillSet,
		}),
		[chat.decide, chat.answer, chat.resolveProposal, chat.resumeLogin, chat.connectLogin, chat.connects, openBot, botFor, openExchange, openWeb, openPage, openScreen, openImage, request, bot?.name, palette.accent, serverUrl, messageMenu.open, chat.running, chat.runTasks?.runId, userBubble, rowBots, skillSet],
	);

	// A lista é invertida (o fim da conversa fica embaixo e o teclado não a desloca): mais novo primeiro.
	const data = React.useMemo(() => [...shownItems].reverse(), [shownItems]);
	// Buscar na conversa: só nas mensagens já carregadas; a barra toma o lugar do composer e a lista rola até a ocorrência atual.
	const search = useChatSearch(shownItems);
	const searchState = React.useMemo(() => ({ query: search.query, activeId: search.activeId }), [search.query, search.activeId]);
	const dataRef = React.useRef(data);
	dataRef.current = data;
	const scrollToItem = React.useCallback((itemId: string) => {
		const index = dataRef.current.findIndex((item) => item.id === itemId);
		if (index >= 0) listRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
	}, []);
	const activeSearchId = search.activeId;
	React.useEffect(() => {
		if (activeSearchId) scrollToItem(activeSearchId);
	}, [activeSearchId, scrollToItem]);
	// Voltar do Android fecha a busca antes de sair da conversa.
	const closeSearch = search.close;
	React.useEffect(() => {
		if (!search.open) return;
		const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
			closeSearch();
			return true;
		});
		return () => subscription.remove();
	}, [search.open, closeSearch]);
	const animateIds = useNewItemIds(shownItems, chat.ready);
	const positions = React.useMemo(() => bubblePositions(shownItems), [shownItems]);

	if (!bot) {
		return (
			<ScreenFrame className="items-center justify-center gap-4 px-8">
				<Text variant="muted" className="text-center text-control">
					Não encontrei esta conversa.
				</Text>
				<Pressable role="button" onPress={goBack} className="min-h-11 justify-center rounded-full bg-secondary px-6 active:opacity-80">
					<Text className="text-control font-semibold">Voltar</Text>
				</Pressable>
			</ScreenFrame>
		);
	}

	const { accent: color, foreground } = palette;
	// Pausado (esperando aprovação ou resposta) também mostra a linha: "Esperando você".
	const showThinking = chat.running && (chat.paused || chat.phase === "thinking" || chat.phase === "tool");
	const onMenuPick = (action: ChatMenuAction) => {
		setMenu(false);
		if (action === "profile") openProfile();
		else if (action === "search") search.start();
		else setSoon("compartilhar");
	};

	return (
		<ScreenFrame edges={["bottom", "left", "right"]}>
			<ChatSearchProvider value={searchState}>
			<KeyboardAvoidingView behavior="padding" className="flex-1">
				<FlatList
					ref={listRef}
					// A lista vai até o fundo e passa por trás do composer (ele flutua sobre as mensagens, sem faixa preta).
					style={{ marginBottom: -composerHeight }}
					onScroll={(event) => setFarFromEnd(event.nativeEvent.contentOffset.y > JUMP_THRESHOLD)}
					scrollEventThrottle={100}
					inverted
					data={data}
					keyExtractor={(item) => item.id}
					renderItem={({ item }) => <MessageRow item={item} actions={actions} animate={animateIds.has(item.id)} position={positions.get(item.id)} />}
					keyboardShouldPersistTaps="handled"
					keyboardDismissMode="on-drag"
					// Item fora da janela renderizada: vai para o deslocamento estimado e tenta de novo quando ele existir.
					onScrollToIndexFailed={(info) => {
						listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
						setTimeout(() => listRef.current?.scrollToIndex({ index: info.index, viewPosition: 0.5, animated: true }), 120);
					}}
					onEndReached={chat.hasMore ? chat.loadOlder : undefined}
					onEndReachedThreshold={0.6}
					contentContainerClassName="gap-1.5 px-4"
					// Cabeçalho de lista invertida = embaixo: a linha de sincronização fica logo abaixo da última mensagem.
					ListHeaderComponent={
						<View>
							{showThinking ? <ThinkingLine bot={bot} avatar={chat.avatar} /> : null}
							{chat.compacting && !showThinking ? <ThinkingLine bot={bot} avatar={{ state: "working", label: "Compactando a conversa…" }} /> : null}
							{chat.line ? <SyncLine line={chat.line} color={color} /> : null}
							{chat.notice ? (
								<Text variant="muted" className="px-1 py-2 text-control">
									{chat.notice}
								</Text>
							) : null}
							{chat.error ? (
								<Pressable role="alert" onPress={chat.dismissError} className="my-1 rounded-2xl bg-destructive/10 px-4 py-3">
									<Text className="text-control text-destructive">{chat.error}</Text>
								</Pressable>
							) : null}
							<View style={{ height: composerHeight + LAST_MESSAGE_GAP }} />
						</View>
					}
					// Rodapé = em cima: o espaço do topo flutuante e o carregando mais antigas.
					ListFooterComponent={
						<View style={{ paddingTop: TOP_BAR_HEIGHT + 56 }} className="items-center pb-3">
							{chat.loadingOlder ? <Spinner label="Carregando mensagens antigas" /> : null}
						</View>
					}
					ListEmptyComponent={
						chat.ready && !chat.line ? (
							<View className="items-center px-8 py-16" style={{ transform: [{ scaleY: -1 }] }}>
								<Text variant="muted" className="text-center text-control">
									Comece a conversa com {bot.name}.
								</Text>
							</View>
						) : undefined
					}
				/>
				<Fade from="top" height={insets.top + TOP_BAR_HEIGHT + 24} className="absolute left-0 right-0 top-0" />
				<ChatTopBar bot={bot} avatarState={chat.avatar.state} onBack={goBack} onMenu={() => setMenu(true)} onProfile={openProfile} />
				<View className="z-10" onLayout={(event) => setComposerHeight(Math.round(event.nativeEvent.layout.height))}>
					{farFromEnd ? (
						<Pressable role="button" accessibilityLabel="Ir para o fim da conversa" onPress={() => listRef.current?.scrollToOffset({ offset: 0, animated: true })} style={{ position: "absolute", right: 16, bottom: "100%", marginBottom: 12 }} className="size-11 items-center justify-center rounded-full border border-border bg-card active:opacity-70">
							<ChevronDownIcon size={22} tone="foreground" />
						</Pressable>
					) : null}
					{search.open ? (
						<ChatSearchBar value={search.text} onChange={search.setText} positionLabel={search.label} empty={search.empty} canStep={search.hits.length > 0} onPrevious={search.previous} onNext={search.next} onClose={search.close} />
					) : null}
					{/* Escondido (não desmontado) durante a busca: o texto que o usuário digitava continua lá quando a barra fecha. */}
					<View style={search.open ? { display: "none" } : undefined}>
					<Composer onCompact={bot.memberIds.length > 0 ? undefined : (focus) => void chat.compact(focus)} mentionBots={mentionBots} skills={bot.memberIds.length > 0 ? null : composerSkills.skills} skillsLoading={composerSkills.loading} skillsFailed={composerSkills.failed} onSlash={composerSkills.load} initialText={typeof draft === "string" ? draft : undefined} botName={bot.name} color={color} foreground={foreground} running={chat.running} onSend={(text) => {
							chat.send(text, replyTo ?? undefined);
							setReplyTo(null);
						}} onStop={chat.stop} onSoon={(what) => setSoon(what)} onModel={() => setModelOpen(true)} modelPill={modelPill} holdWriting={modelOpen} onWriting={chat.modelSelector.loadCatalog} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} />
					</View>
				</View>
			</KeyboardAvoidingView>
			</ChatSearchProvider>
			<ChatMenu open={menu} onClose={() => setMenu(false)} onPick={onMenuPick} />
			<ViewerSheet target={viewer} onClose={closeViewer} apiFetch={apiFetch} />
			<ImageViewer visible={imageStart !== null} images={viewerImages} startIndex={imageStart ?? 0} onClose={closeImage} actions={imageActions} />
			{messageMenu.node}
			<ModelSheet visible={modelOpen} onClose={() => setModelOpen(false)} selector={chat.modelSelector} />
			<SoonSheet open={soon !== null} title={soon ? SOON_TITLE[soon] : ""} onClose={() => setSoon(null)} />
		</ScreenFrame>
	);
}
