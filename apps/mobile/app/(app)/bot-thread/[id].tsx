import { useLocalSearchParams, useRouter } from "expo-router";
import * as React from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { BotExchangeView, type ExchangeBot, type ExchangeStatus } from "@/components/chat/bot-exchange-view";
import { Text } from "@/components/ui/text";
import { useAtlasSession } from "@/lib/atlas-session";
import { fetchBotExchange, flattenBotExchange, mergeExchangeItems } from "@/lib/bot-exchange";
import { useHomeData } from "@/lib/home-data";
import type { BotExchangeItem } from "@workspace/shared";

const PAGE_SIZE = 50;

/**
 * Conversa entre dois bots do dono, somente leitura (`/bot-thread/<bot>?peer=<outro bot>&focus=<fala>`). Lê do mesmo
 * endpoint escopado do web; o servidor responde 404 se algum dos bots não é do usuário da sessão.
 */
export default function BotThreadScreen() {
	const router = useRouter();
	const { id, peer: peerId, focus } = useLocalSearchParams<{ id: string; peer?: string; focus?: string }>();
	const { snapshot } = useHomeData();
	const { apiFetch } = useAtlasSession();
	const self = snapshot?.bots.find((bot) => bot.id === id);
	const peer = snapshot?.bots.find((bot) => bot.id === peerId);
	const [items, setItems] = React.useState<BotExchangeItem[]>([]);
	const [cursor, setCursor] = React.useState<string | null>(null);
	const [status, setStatus] = React.useState<ExchangeStatus>("loading");
	const [error, setError] = React.useState<string | null>(null);
	const [loadingMore, setLoadingMore] = React.useState(false);
	const [attempt, setAttempt] = React.useState(0);
	const goBack = React.useCallback(() => (router.canGoBack() ? router.back() : router.replace("/")), [router]);

	React.useEffect(() => {
		if (!id || !peerId) return;
		const abort = new AbortController();
		setStatus("loading");
		setItems([]);
		setCursor(null);
		fetchBotExchange(apiFetch, id, peerId, { limit: PAGE_SIZE, signal: abort.signal })
			.then((page) => {
				setItems(page.messages);
				setCursor(page.nextCursor);
				setStatus("ready");
			})
			.catch((reason: unknown) => {
				if (abort.signal.aborted) return;
				setError(reason instanceof Error ? reason.message : null);
				setStatus("error");
			});
		return () => abort.abort();
	}, [apiFetch, id, peerId, attempt]);

	const loadMore = React.useCallback(() => {
		if (!id || !peerId || !cursor || loadingMore) return;
		setLoadingMore(true);
		fetchBotExchange(apiFetch, id, peerId, { limit: PAGE_SIZE, cursor })
			.then((page) => {
				setItems((current) => mergeExchangeItems(page.messages, current));
				setCursor(page.nextCursor);
			})
			.catch(() => undefined)
			.finally(() => setLoadingMore(false));
	}, [apiFetch, id, peerId, cursor, loadingMore]);

	const entries = React.useMemo(() => (id ? flattenBotExchange(items, id) : []), [items, id]);

	if (!self || !peer) {
		return (
			<SafeAreaView className="flex-1 items-center justify-center bg-background px-8">
				<Text variant="muted" className="text-center text-control">
					Não encontrei esta conversa.
				</Text>
			</SafeAreaView>
		);
	}
	const botOf = (bot: typeof self): ExchangeBot => ({ id: bot.id, name: bot.name, color: bot.color, shape: bot.shape });
	return (
		<BotExchangeView
			self={botOf(self)}
			peer={botOf(peer)}
			entries={entries}
			status={status}
			error={error}
			hasMore={Boolean(cursor)}
			loadingMore={loadingMore}
			onLoadMore={loadMore}
			onBack={goBack}
			onRetry={() => setAttempt((count) => count + 1)}
			focusKey={typeof focus === "string" ? focus : null}
		/>
	);
}
