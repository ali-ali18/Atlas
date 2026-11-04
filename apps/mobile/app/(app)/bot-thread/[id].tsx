import type { BotExchangeItem } from "@workspace/shared";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as React from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { BotExchangeView, type ExchangeBot, type ExchangeStatus } from "@/components/chat/bot-exchange-view";
import { Text } from "@/components/ui/text";
import { useAtlasSession } from "@/lib/atlas-session";
import { fetchBotExchange, flattenBotExchange, hasFocus, MAX_FOCUS_PAGES, mergeExchangeItems } from "@/lib/bot-exchange";
import { isUnauthorized } from "@/lib/chat-api";
import { useHomeData } from "@/lib/home-data";

const PAGE_SIZE = 50;

/**
 * Conversa entre dois bots do dono, somente leitura (`/bot-thread/<bot>?peer=<outro bot>&focus=<fala>`). Lê do mesmo
 * endpoint escopado do web; o servidor responde 404 se algum dos bots não é do usuário da sessão.
 */
export default function BotThreadScreen() {
	const router = useRouter();
	const { id, peer: peerId, focus } = useLocalSearchParams<{ id: string; peer?: string; focus?: string }>();
	const { snapshot } = useHomeData();
	const { apiFetch, signOut } = useAtlasSession();
	const self = snapshot?.bots.find((bot) => bot.id === id);
	const peer = snapshot?.bots.find((bot) => bot.id === peerId);
	const [items, setItems] = React.useState<BotExchangeItem[]>([]);
	const [cursor, setCursor] = React.useState<string | null>(null);
	const [status, setStatus] = React.useState<ExchangeStatus>("loading");
	const [error, setError] = React.useState<string | null>(null);
	const [loadingMore, setLoadingMore] = React.useState(false);
	const [moreFailed, setMoreFailed] = React.useState(false);
	const [attempt, setAttempt] = React.useState(0);
	// Geração da conversa aberta: resposta de uma conversa anterior (bots trocados no voo) não entra na atual.
	const generation = React.useRef(0);
	const latest = React.useRef({ apiFetch, signOut });
	latest.current = { apiFetch, signOut };
	const goBack = React.useCallback(() => (router.canGoBack() ? router.back() : router.replace("/")), [router]);
	const focusKey = typeof focus === "string" ? focus : null;

	// 401: a sessão acabou, igual ao resto do app. Outro erro vira a mensagem da tela.
	const fail = React.useCallback((reason: unknown): string | null => {
		if (isUnauthorized(reason)) void latest.current.signOut();
		return reason instanceof Error ? reason.message : null;
	}, []);

	React.useEffect(() => {
		if (!id || !peerId) return;
		generation.current += 1;
		const mine = generation.current;
		const current = () => generation.current === mine;
		setStatus("loading");
		setItems([]);
		setCursor(null);
		setMoreFailed(false);
		setLoadingMore(false);
		void (async () => {
			try {
				let page = await fetchBotExchange(latest.current.apiFetch, id, peerId, { limit: PAGE_SIZE });
				let all = page.messages;
				// A fala tocada pode estar além da primeira página: busca páginas antigas (até o limite) até achá-la.
				for (let extra = 0; extra < MAX_FOCUS_PAGES && page.nextCursor && !hasFocus(all, focusKey); extra += 1) {
					page = await fetchBotExchange(latest.current.apiFetch, id, peerId, { limit: PAGE_SIZE, cursor: page.nextCursor });
					all = mergeExchangeItems(page.messages, all);
				}
				if (!current()) return;
				setItems(all);
				setCursor(page.nextCursor);
				setStatus("ready");
			} catch (reason) {
				if (!current()) return;
				setError(fail(reason));
				setStatus("error");
			}
		})();
		return () => {
			generation.current += 1;
		};
	}, [id, peerId, focusKey, attempt, fail]);

	const loadMore = React.useCallback(() => {
		if (!id || !peerId || !cursor || loadingMore) return;
		const mine = generation.current;
		setLoadingMore(true);
		setMoreFailed(false);
		fetchBotExchange(latest.current.apiFetch, id, peerId, { limit: PAGE_SIZE, cursor })
			.then((page) => {
				if (generation.current !== mine) return;
				setItems((currentItems) => mergeExchangeItems(page.messages, currentItems));
				setCursor(page.nextCursor);
			})
			.catch((reason: unknown) => {
				if (generation.current !== mine) return;
				fail(reason);
				setMoreFailed(true);
			})
			.finally(() => {
				if (generation.current === mine) setLoadingMore(false);
			});
	}, [id, peerId, cursor, loadingMore, fail]);

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
			hasMore={Boolean(cursor) && !moreFailed}
			loadingMore={loadingMore}
			loadMoreFailed={moreFailed}
			onLoadMore={loadMore}
			onBack={goBack}
			onRetry={() => setAttempt((count) => count + 1)}
			focusKey={focusKey}
		/>
	);
}
