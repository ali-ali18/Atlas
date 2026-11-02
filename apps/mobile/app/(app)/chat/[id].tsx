
import { resolveColor } from "@workspace/shared/avatar/identity";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import * as React from "react";
import { FlatList, KeyboardAvoidingView, Pressable, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronDownIcon } from "@/components/icons";
import { SoonSheet } from "@/components/home/soon-sheet";
import { ChatMenu, type ChatMenuAction } from "@/components/chat/chat-menu";
import { Fade } from "@/components/chat/fade";
import { ChatTopBar, TOP_BAR_HEIGHT } from "@/components/chat/chat-top-bar";
import { Composer } from "@/components/chat/composer";
import { MessageRow, type RowActions } from "@/components/chat/message-row";
import { useMessageMenu } from "@/components/chat/use-message-menu";
import { grokBubbleColors } from "@/lib/bubble-tone";
import { createNewItemTracker } from "@/lib/chat-appear";
import { groupPositionAt, type GroupPosition } from "@workspace/shared";
import { SyncLine, ThinkingLine } from "@/components/chat/sync-line";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { useAtlasSession } from "@/lib/atlas-session";
import { botColors } from "@/lib/bot-color";
import { themeColor } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";
import { webChatUrl } from "@/lib/chat-links";
import type { ChatItem, ReplyQuote } from "@/lib/chat-types";
import { containsTable } from "@/lib/markdown";
import { replyQuoteFor } from "@/lib/reply-quote";
import { useChat } from "@/lib/use-chat";
import { useHomeData } from "@/lib/home-data";

/** Rolou para cima além disto (px do fim): aparece o botão de voltar ao fim. */
const JUMP_THRESHOLD = 360;
/** Respiro entre a última mensagem (ou a linha "Pensando…") e o composer que flutua sobre a lista. */
const LAST_MESSAGE_GAP = 16;

type Soon = "anexos" | "voz" | "buscar" | "compartilhar" | null;
const SOON_TITLE: Record<NonNullable<Soon>, string> = { anexos: "Anexos", voz: "Voz", buscar: "Buscar no chat", compartilhar: "Compartilhar como modelo" };

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
	const { snapshot } = useHomeData();
	const { serverUrl } = useAtlasSession();
	const bot = snapshot?.bots.find((item) => item.id === id);
	const chat = useChat(bot);
	const listRef = React.useRef<FlatList<ChatItem>>(null);
	const [farFromEnd, setFarFromEnd] = React.useState(false);
	const [menu, setMenu] = React.useState(false);
	// Altura do composer (cresce com o texto): a lista passa por baixo dele e reserva esse espaço no fim.
	const [composerHeight, setComposerHeight] = React.useState(64);
	const [soon, setSoon] = React.useState<Soon>(null);
	const goBack = React.useCallback(() => (router.canGoBack() ? router.back() : router.replace("/")), [router]);
	const openProfile = React.useCallback(() => router.push(`/profile/${encodeURIComponent(id)}` as never), [router, id]);
	const openWeb = React.useCallback(
		(_item: Extract<ChatItem, { kind: "web-card" }>) => {
			const url = webChatUrl(serverUrl, id);
			if (url) void WebBrowser.openBrowserAsync(url).catch(() => undefined);
		},
		[serverUrl, id],
	);
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
	const actions = React.useMemo<RowActions>(
		() => ({
			onDecide: chat.decide,
			onAnswer: chat.answer,
			onOpenWeb: openWeb,
			onOpenMenu: messageMenu.open,
			activeRunId: chat.runTasks?.runId ?? null,
			running: chat.running,
			userBubble: userBubble,
		}),
		[chat.decide, chat.answer, openWeb, messageMenu.open, chat.running, chat.runTasks?.runId, userBubble],
	);

	// A lista é invertida (o fim da conversa fica embaixo e o teclado não a desloca): mais novo primeiro.
	const data = React.useMemo(() => [...chat.items].reverse(), [chat.items]);
	const animateIds = useNewItemIds(chat.items, chat.ready);
	const positions = React.useMemo(() => bubblePositions(chat.items), [chat.items]);

	if (!bot) {
		return (
			<SafeAreaView className="flex-1 items-center justify-center gap-4 bg-background px-8">
				<Text variant="muted" className="text-center text-control">
					Não encontrei esta conversa.
				</Text>
				<Pressable role="button" onPress={goBack} className="min-h-11 justify-center rounded-full bg-secondary px-6 active:opacity-80">
					<Text className="text-control font-semibold">Voltar</Text>
				</Pressable>
			</SafeAreaView>
		);
	}

	const { accent: color, foreground } = palette;
	// Pausado (esperando aprovação ou resposta) também mostra a linha: "Esperando você".
	const showThinking = chat.running && (chat.paused || chat.phase === "thinking" || chat.phase === "tool");
	const onMenuPick = (action: ChatMenuAction) => {
		setMenu(false);
		if (action === "profile") openProfile();
		else setSoon(action === "search" ? "buscar" : "compartilhar");
	};

	return (
		<SafeAreaView edges={["bottom", "left", "right"]} className="flex-1 bg-background">
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
					onEndReached={chat.hasMore ? chat.loadOlder : undefined}
					onEndReachedThreshold={0.6}
					contentContainerClassName="gap-1.5 px-4"
					// Cabeçalho de lista invertida = embaixo: a linha de sincronização fica logo abaixo da última mensagem.
					ListHeaderComponent={
						<View>
							{showThinking ? <ThinkingLine bot={bot} avatar={chat.avatar} /> : null}
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
					<Composer initialText={typeof draft === "string" ? draft : undefined} botName={bot.name} color={color} foreground={foreground} running={chat.running} onSend={(text) => {
							chat.send(text, replyTo ?? undefined);
							setReplyTo(null);
						}} onStop={chat.stop} onSoon={(what) => setSoon(what)} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} />
				</View>
			</KeyboardAvoidingView>
			<ChatMenu open={menu} onClose={() => setMenu(false)} onPick={onMenuPick} />
			{messageMenu.node}
			<SoonSheet open={soon !== null} title={soon ? SOON_TITLE[soon] : ""} onClose={() => setSoon(null)} />
		</SafeAreaView>
	);
}
