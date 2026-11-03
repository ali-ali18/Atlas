import { groupPositionAt } from "@workspace/shared";
import { resolveColor, resolveShape } from "@workspace/shared/avatar/identity";
import * as React from "react";
import { FlatList, Pressable, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { RoundButton } from "@/components/chat/chat-top-bar";
import { ChevronLeftIcon } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { stampBreaks, type ExchangeEntry } from "@/lib/bot-exchange";
import { exchangeStamp } from "@/lib/bot-thread";
import { bubbleCorners } from "@/lib/bubble-corners";
import { chatChrome, chatSurface } from "@/lib/chat-surface";
import { useAppColorScheme } from "@/lib/use-theme";
import { MarkdownText } from "./markdown-text";

export type ExchangeBot = { id: string; name: string; color: string; shape: string };
export type ExchangeStatus = "loading" | "ready" | "error";

/** Quanto a fala tocada fica destacada ao abrir a conversa. */
const FLASH_MS = 4000;
const AVATAR = 30;

function Participant({ bot }: { bot: ExchangeBot }) {
	return <Avatar color={resolveColor(bot.color, bot.id)} shape={resolveShape(bot.shape, bot.id)} size={AVATAR} animated={false} />;
}

/**
 * Conversa entre dois bots, somente leitura: os dois avatares no topo, os balões de cada bot com o nome do autor
 * (o bot da conversa de origem à direita, o parceiro à esquerda) e a pílula "Somente leitura" no lugar do composer.
 */
export function BotExchangeView({
	self,
	peer,
	entries,
	status,
	error,
	hasMore = false,
	loadingMore = false,
	onLoadMore,
	onBack,
	onRetry,
	focusKey,
}: {
	self: ExchangeBot;
	peer: ExchangeBot;
	entries: readonly ExchangeEntry[];
	status: ExchangeStatus;
	error?: string | null;
	hasMore?: boolean;
	loadingMore?: boolean;
	onLoadMore?: () => void;
	onBack: () => void;
	onRetry?: () => void;
	/** Fala a levar à tela e destacar (`<id da troca>:req|reply`). */
	focusKey?: string | null;
}) {
	const scheme = useAppColorScheme();
	const chrome = chatChrome(scheme);
	const listRef = React.useRef<FlatList<ExchangeEntry>>(null);
	const [flash, setFlash] = React.useState<string | null>(null);
	// Lista invertida (abre no fim, como o chat): mais nova primeiro.
	const data = React.useMemo(() => [...entries].reverse(), [entries]);
	const breaks = React.useMemo(() => stampBreaks(entries), [entries]);
	const authors = React.useMemo(() => entries.map((entry) => entry.authorId), [entries]);
	const positions = React.useMemo(() => new Map(entries.map((entry, index) => [entry.key, groupPositionAt(authors, index, () => true, (at) => breaks.has(entries[at]!.key))])), [entries, authors, breaks]);
	const focusIndex = focusKey ? data.findIndex((entry) => entry.key === focusKey) : -1;
	const focused = React.useRef<string | null>(null);

	// Fala tocada no fio: leva ao centro e destaca um instante (uma vez por abertura).
	React.useEffect(() => {
		if (status !== "ready" || !focusKey || focusIndex < 0 || focused.current === focusKey) return;
		focused.current = focusKey;
		setFlash(focusKey);
		const scroll = setTimeout(() => listRef.current?.scrollToIndex({ index: focusIndex, viewPosition: 0.5, animated: false }), 60);
		const off = setTimeout(() => setFlash(null), FLASH_MS);
		return () => {
			clearTimeout(scroll);
			clearTimeout(off);
		};
	}, [status, focusKey, focusIndex]);

	const renderEntry = ({ item }: { item: ExchangeEntry }) => {
		const position = positions.get(item.key) ?? "single";
		const author = item.self ? self : peer;
		const starts = position === "single" || position === "first";
		const stamp = breaks.has(item.key) ? exchangeStamp(item.createdAt, Date.now()) : "";
		return (
			<View style={starts && !stamp ? { marginTop: 8 } : undefined}>
				{stamp ? (
					<Text variant="caption" className="py-2.5 text-center">
						{stamp}
					</Text>
				) : null}
				<View className={`max-w-[87%] ${item.self ? "self-end" : "self-start"}`}>
					{starts ? (
						<Text variant="caption" numberOfLines={1} className={`px-1.5 pb-1 ${item.self ? "text-right" : ""}`}>
							<Text variant="caption" className="font-semibold">
								{author.name}
							</Text>
							{item.title ? ` · ${item.title}` : ""}
						</Text>
					) : null}
					<View
						accessibilityLabel={`${author.name}: ${item.text}`}
						style={[{ backgroundColor: item.self ? chrome.fill : chatSurface(scheme, "bubble") }, bubbleCorners(item.self ? "right" : "left", position), flash === item.key ? { borderWidth: 2, borderColor: resolveColor(peer.color, peer.id) } : undefined]}
						className="px-3.5 py-3.5"
					>
						<MarkdownText source={item.text} />
					</View>
				</View>
			</View>
		);
	};

	return (
		<SafeAreaView className="flex-1 bg-background">
			<View className="flex-row items-center gap-3 px-4 pb-2 pt-1.5">
				<RoundButton label="Voltar" onPress={onBack}>
					<ChevronLeftIcon />
				</RoundButton>
				<View accessibilityRole="header" accessibilityLabel={`${self.name} e ${peer.name}`} style={{ borderColor: chrome.edge, backgroundColor: chrome.fill }} className="h-[47px] min-w-0 shrink flex-row items-center gap-2 rounded-full border pl-2.5 pr-4">
					<Participant bot={self} />
					<Participant bot={peer} />
					<Text numberOfLines={1} className="min-w-0 shrink text-control font-semibold">
						{self.name} e {peer.name}
					</Text>
				</View>
			</View>
			{status === "loading" ? (
				<View className="flex-1 items-center justify-center">
					<Spinner label="Carregando a conversa" />
				</View>
			) : status === "error" ? (
				<View className="flex-1 items-center justify-center gap-4 px-8">
					<Text variant="muted" role="alert" className="text-center text-control">
						{error || "Não consegui carregar a conversa."}
					</Text>
					{onRetry ? (
						<Pressable role="button" onPress={onRetry} className="min-h-11 justify-center rounded-full bg-secondary px-6 active:opacity-80">
							<Text className="text-control font-semibold">Tentar de novo</Text>
						</Pressable>
					) : null}
				</View>
			) : (
				<FlatList
					ref={listRef}
					inverted
					data={data}
					keyExtractor={(entry) => entry.key}
					renderItem={renderEntry}
					onEndReached={hasMore ? onLoadMore : undefined}
					onEndReachedThreshold={0.6}
					onScrollToIndexFailed={(info) => listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false })}
					contentContainerClassName="px-4 pb-4 pt-2"
					ListFooterComponent={loadingMore ? <Spinner label="Carregando mensagens antigas" /> : undefined}
					ListEmptyComponent={
						<View className="items-center px-8 py-16" style={{ transform: [{ scaleY: -1 }] }}>
							<Text variant="muted" className="text-center text-control">
								{self.name} e {peer.name} ainda não trocaram mensagens.
							</Text>
						</View>
					}
				/>
			)}
			<View className="items-center px-4 pb-3 pt-2">
				<View accessibilityLabel="Somente leitura: você não escreve nesta conversa" style={{ borderColor: chrome.edge, backgroundColor: chrome.fill }} className="min-h-11 items-center justify-center rounded-full border px-6">
					<Text variant="muted" className="text-control">
						Somente leitura
					</Text>
				</View>
			</View>
		</SafeAreaView>
	);
}
