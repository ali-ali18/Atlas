import { groupPositionAt } from "@workspace/shared";
import { resolveColor, resolveShape } from "@workspace/shared/avatar/identity";
import * as React from "react";
import { FlatList, Pressable, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { RoundButton } from "@/components/chat/chat-top-bar";
import { ChevronLeftIcon, LockIcon } from "@/components/icons";
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
/** Avatar do autor ao lado do balão, e o espaço que a pílula flutuante reserva no fim da lista. */
const AVATAR_BOX = 28;
const FOOTER_SPACE = 72;
const STACK = 40;
const STACK_BODY = 24;

/**
 * Os dois bots empilhados, como o avatar de grupo do web: o segundo fica abaixo e à direita, cobrindo parte do primeiro,
 * e um disco na cor da pílula em volta dele os separa (os corpos não são círculos, então não há contorno próprio).
 */
function StackedAvatars({ first, second, fill }: { first: ExchangeBot; second: ExchangeBot; fill: string }) {
	const box = Math.round(STACK_BODY / 0.705);
	const cell = { position: "absolute" as const, width: STACK_BODY + 4, height: STACK_BODY + 4, alignItems: "center" as const, justifyContent: "center" as const };
	return (
		<View style={{ width: STACK, height: STACK }}>
			<View style={[cell, { left: 0, top: 0 }]}>
				<Avatar color={resolveColor(first.color, first.id)} shape={resolveShape(first.shape, first.id)} size={box} animated={false} />
			</View>
			<View style={[cell, { right: 0, bottom: 0, borderRadius: (STACK_BODY + 4) / 2, backgroundColor: fill }]}>
				<Avatar color={resolveColor(second.color, second.id)} shape={resolveShape(second.shape, second.id)} size={box} animated={false} />
			</View>
		</View>
	);
}

/**
 * Conversa entre dois bots, somente leitura: no topo, voltar e uma pílula com os dois avatares empilhados; as falas dos
 * dois ficam à esquerda como num grupo (nome do autor acima, avatar na base do último balão); a pílula "Somente
 * leitura" flutua sobre o conteúdo no lugar do composer.
 */
export function BotExchangeView({
	self,
	peer,
	entries,
	status,
	error,
	hasMore = false,
	loadingMore = false,
	loadMoreFailed = false,
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
	/** A busca de mensagens antigas falhou: o rodapé mostra "Tentar de novo". */
	loadMoreFailed?: boolean;
	onLoadMore?: () => void;
	onBack: () => void;
	onRetry?: () => void;
	/** Fala a levar à tela e destacar (`<id da troca>:req|reply`). */
	focusKey?: string | null;
}) {
	const scheme = useAppColorScheme();
	const insets = useSafeAreaInsets();
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
		const ends = position === "single" || position === "last";
		const stamp = breaks.has(item.key) ? exchangeStamp(item.createdAt, Date.now()) : "";
		// Como num grupo: as duas vozes ficam à esquerda; o avatar do autor fica na base do último balão da sequência.
		return (
			<View style={starts && !stamp ? { marginTop: 8 } : undefined}>
				{stamp ? (
					<Text variant="caption" className="py-2.5 text-center">
						{stamp}
					</Text>
				) : null}
				<View className="flex-row items-end gap-2">
					<View style={{ width: AVATAR_BOX, height: ends ? AVATAR_BOX : 0 }}>
						{ends ? <Avatar color={resolveColor(author.color, author.id)} shape={resolveShape(author.shape, author.id)} size={AVATAR_BOX} animated={false} /> : null}
					</View>
					<View className="min-w-0 shrink" style={{ maxWidth: "87%" }}>
						{starts ? (
							<Text variant="caption" numberOfLines={1} className="px-1.5 pb-1">
								{author.name}
								{item.title ? ` · ${item.title}` : ""}
							</Text>
						) : null}
						<View
							accessibilityLabel={`${author.name}: ${item.text}`}
							style={[{ backgroundColor: chatSurface(scheme, "bubble") }, bubbleCorners("left", position), flash === item.key ? { borderWidth: 2, borderColor: resolveColor(peer.color, peer.id) } : undefined]}
							className="px-3.5 py-3.5"
						>
							<MarkdownText source={item.text} />
						</View>
					</View>
				</View>
			</View>
		);
	};

	return (
		<SafeAreaView edges={["top", "left", "right"]} className="flex-1 bg-background">
			<View className="flex-row items-center gap-3 px-4 pb-2 pt-1.5">
				<RoundButton label="Voltar" onPress={onBack}>
					<ChevronLeftIcon />
				</RoundButton>
				<View accessibilityRole="header" accessibilityLabel={`${self.name} e ${peer.name}`} style={{ borderColor: chrome.edge, backgroundColor: chrome.fill }} className="h-[47px] items-center justify-center rounded-full border px-4">
					<StackedAvatars first={self} second={peer} fill={chrome.fill} />
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
					contentContainerClassName="px-4 pt-2"
					// Cabeçalho de lista invertida = embaixo: reserva o espaço da pílula flutuante.
					ListHeaderComponent={<View style={{ height: FOOTER_SPACE + insets.bottom }} />}
					ListFooterComponent={
						loadingMore ? (
							<Spinner label="Carregando mensagens antigas" />
						) : loadMoreFailed ? (
							<Pressable role="button" onPress={onLoadMore} className="min-h-11 items-center justify-center self-center rounded-full bg-secondary px-6 active:opacity-80">
								<Text className="text-control font-semibold">Tentar de novo</Text>
							</Pressable>
						) : undefined
					}
					ListEmptyComponent={
						<View className="items-center px-8 py-16" style={{ transform: [{ scaleY: -1 }] }}>
							<Text variant="muted" className="text-center text-control">
								{self.name} e {peer.name} ainda não trocaram mensagens.
							</Text>
						</View>
					}
				/>
			)}
			{/* Flutua sobre o conteúdo (que rola por trás), perto da borda de baixo, no lugar do composer. */}
			<View pointerEvents="none" className="absolute inset-x-0 items-center" style={{ bottom: insets.bottom + 12 }}>
				<View accessibilityLabel="Somente leitura: você não escreve nesta conversa" style={{ borderColor: chrome.edge, backgroundColor: chrome.fill }} className="min-h-11 flex-row items-center justify-center gap-2 rounded-full border px-5">
					<LockIcon />
					<Text variant="muted" className="text-control">
						Somente leitura
					</Text>
				</View>
			</View>
		</SafeAreaView>
	);
}
