"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { BotExchangeItem } from "@workspace/shared";

import { flattenBotExchange, mergeExchangeItems } from "@/lib/bot-exchange";
import { listBotExchange } from "@/lib/atlas-api";

import type { BotRef } from "./bot-chip";
import { BotExchangeView, type BotExchangeStatus } from "./bot-exchange-view";

const PAGE_SIZE = 50;

/** Carrega (e pagina para trás) a conversa entre `self` e `peer` e a mostra somente leitura. */
export function BotExchangeScreen({
	self,
	peer,
	focusKey,
	onBack,
	onOpenPeer,
	className,
}: {
	self: BotRef & { id: string };
	peer: BotRef & { id: string };
	focusKey?: string | null;
	onBack: () => void;
	onOpenPeer?: () => void;
	className?: string;
}) {
	const [items, setItems] = useState<BotExchangeItem[]>([]);
	const [cursor, setCursor] = useState<string | null>(null);
	const [status, setStatus] = useState<BotExchangeStatus>("loading");
	const [error, setError] = useState<string | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setStatus("loading");
		setItems([]);
		setCursor(null);
		listBotExchange(self.id, peer.id, { limit: PAGE_SIZE })
			.then((page) => {
				if (cancelled) return;
				setItems(page.messages);
				setCursor(page.nextCursor);
				setStatus("ready");
			})
			.catch((reason: unknown) => {
				if (cancelled) return;
				setError(reason instanceof Error ? reason.message : null);
				setStatus("error");
			});
		return () => {
			cancelled = true;
		};
	}, [self.id, peer.id]);

	const loadMore = useCallback(() => {
		if (!cursor || loadingMore) return;
		setLoadingMore(true);
		listBotExchange(self.id, peer.id, { limit: PAGE_SIZE, cursor })
			.then((page) => {
				setItems((current) => mergeExchangeItems(page.messages, current));
				setCursor(page.nextCursor);
			})
			.catch(() => undefined)
			.finally(() => setLoadingMore(false));
	}, [cursor, loadingMore, self.id, peer.id]);

	const entries = useMemo(() => flattenBotExchange(items, self.id), [items, self.id]);
	return (
		<BotExchangeView
			className={className}
			entries={entries}
			error={error}
			focusKey={focusKey}
			hasMore={Boolean(cursor)}
			loadingMore={loadingMore}
			onBack={onBack}
			onLoadMore={loadMore}
			onOpenPeer={onOpenPeer}
			peer={peer}
			self={self}
			status={status}
		/>
	);
}
