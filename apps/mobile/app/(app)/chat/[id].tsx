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
import { SyncLine, ThinkingLine } from "@/components/chat/sync-line";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { useAtlasSession } from "@/lib/atlas-session";
import { webChatUrl } from "@/lib/chat-links";
import type { ChatItem } from "@/lib/chat-types";
import { useChat } from "@/lib/use-chat";
import { useHomeData } from "@/lib/home-data";

/** Rolou para cima além disto (px do fim): aparece o botão de voltar ao fim. */
const JUMP_THRESHOLD = 360;

type Soon = "anexos" | "voz" | "buscar" | "compartilhar" | null;
const SOON_TITLE: Record<NonNullable<Soon>, string> = { anexos: "Anexos", voz: "Voz", buscar: "Buscar no chat", compartilhar: "Compartilhar como modelo" };

/** Chat com o bot: o fio (cache + servidor + run ao vivo), o topo flutuante, a doca de tarefas e o composer. */
export default function ChatScreen() {
	const router = useRouter();
	const insets = useSafeAreaInsets();
	const { id } = useLocalSearchParams<{ id: string }>();
	const { snapshot } = useHomeData();
	const { serverUrl } = useAtlasSession();
	const bot = snapshot?.bots.find((item) => item.id === id);
	const chat = useChat(bot);
	const listRef = React.useRef<FlatList<ChatItem>>(null);
	const [farFromEnd, setFarFromEnd] = React.useState(false);
	const [menu, setMenu] = React.useState(false);
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
	const actions = React.useMemo<RowActions>(() => ({ onDecide: chat.decide, onAnswer: chat.answer, onOpenWeb: openWeb }), [chat.decide, chat.answer, openWeb]);

	// A lista é invertida (o fim da conversa fica embaixo e o teclado não a desloca): mais novo primeiro.
	const data = React.useMemo(() => [...chat.items].reverse(), [chat.items]);

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

	const color = resolveColor(bot.color, bot.id);
	const showThinking = chat.running && !chat.paused && (chat.phase === "thinking" || chat.phase === "tool");
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
					onScroll={(event) => setFarFromEnd(event.nativeEvent.contentOffset.y > JUMP_THRESHOLD)}
					scrollEventThrottle={100}
					inverted
					data={data}
					keyExtractor={(item) => item.id}
					renderItem={({ item }) => <MessageRow item={item} actions={actions} />}
					keyboardShouldPersistTaps="handled"
					keyboardDismissMode="on-drag"
					onEndReached={chat.hasMore ? chat.loadOlder : undefined}
					onEndReachedThreshold={0.6}
					contentContainerClassName="gap-3 px-4"
					// Cabeçalho de lista invertida = embaixo: a linha de sincronização fica logo abaixo da última mensagem.
					ListHeaderComponent={
						<View>
							{showThinking ? <ThinkingLine color={color} working={chat.phase === "tool"} /> : null}
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
				<ChatTopBar bot={bot} onBack={goBack} onMenu={() => setMenu(true)} onProfile={openProfile} />
				<View className="z-10">
					{farFromEnd ? (
						<Pressable role="button" accessibilityLabel="Ir para o fim da conversa" onPress={() => listRef.current?.scrollToOffset({ offset: 0, animated: true })} style={{ position: "absolute", right: 16, bottom: "100%", marginBottom: 12 }} className="size-11 items-center justify-center rounded-full border border-border bg-card active:opacity-70">
							<ChevronDownIcon size={22} tone="foreground" />
						</Pressable>
					) : null}
					<Fade from="bottom" height={24} />
				</View>
				<Composer botName={bot.name} color={color} running={chat.running} onSend={chat.send} onStop={chat.stop} onSoon={(what) => setSoon(what)} />
			</KeyboardAvoidingView>
			<ChatMenu open={menu} onClose={() => setMenu(false)} onPick={onMenuPick} />
			<SoonSheet open={soon !== null} title={soon ? SOON_TITLE[soon] : ""} onClose={() => setSoon(null)} />
		</SafeAreaView>
	);
}
