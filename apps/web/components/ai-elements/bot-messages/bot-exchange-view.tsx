"use client";

import { ArrowLeftIcon, ArrowRightLeftIcon, ExternalLinkIcon, LockIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Bubble, BubbleContent } from "@workspace/ui/components/bubble";
import { Button } from "@workspace/ui/components/button";
import { Marker, MarkerContent } from "@workspace/ui/components/marker";
import { cn } from "@workspace/ui/lib/utils";

import { buildTimeSeparators } from "@/lib/chat-time-separators";
import { formatTime } from "@/lib/format";
import type { UiLocale } from "@/lib/i18n/locales";
import { useLocale, useT } from "@/lib/i18n/provider";
import type { ExchangeEntry } from "@/lib/bot-exchange";
import { AgentAvatar } from "@/components/ui/templates/template-4/agent-avatar";
import { botAccentStyle } from "@/components/ui/templates/template-4/chat-context-panel/bot-accent";
import { markdownComponents } from "@/components/ui/templates/template-4/chat-thread/assistant-message";
import { bubbleRadius, type GroupPosition } from "@/components/ui/templates/template-4/chat-thread/bubble-radius";

import type { BotRef } from "./bot-chip";

export type BotExchangeStatus = "loading" | "ready" | "error";

const FLASH_MS = 4000;

function timeLabel(iso: string, locale: UiLocale): string {
	return formatTime(iso, locale);
}

function positionOf(entries: readonly ExchangeEntry[], index: number, separators: ReadonlyMap<string, string>): GroupPosition {
	const entry = entries[index]!;
	const prev = entries[index - 1];
	const next = entries[index + 1];
	const joinPrev = Boolean(prev) && prev!.authorId === entry.authorId && !separators.has(entry.key) && !entry.title;
	const joinNext = Boolean(next) && next!.authorId === entry.authorId && !separators.has(next!.key) && !next!.title;
	if (joinPrev && joinNext) return "middle";
	if (joinPrev) return "last";
	if (joinNext) return "first";
	return "single";
}

/**
 * Conversa entre dois bots, somente leitura: balões do bot aberto à direita e do
 * parceiro (com avatar) à esquerda, no mesmo estilo do chat. Sem composer.
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
	onOpenPeer,
	focusKey,
	className,
}: {
	self: BotRef;
	peer: BotRef;
	entries: readonly ExchangeEntry[];
	status: BotExchangeStatus;
	error?: string | null;
	hasMore?: boolean;
	loadingMore?: boolean;
	onLoadMore?: () => void;
	onBack: () => void;
	/** Navega para o chat do próprio parceiro (desktop). */
	onOpenPeer?: () => void;
	/** Fala a destacar e levar à tela (`<id>:req|reply`). */
	focusKey?: string | null;
	className?: string;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const [flash, setFlash] = useState<string | null>(focusKey ?? null);
	const locale = useLocale();
	const t = useT();
	const separators = useMemo(() => buildTimeSeparators(entries.map((entry) => ({ id: entry.key, createdAt: entry.createdAt })), new Date(), undefined, locale), [entries, locale]);
	const focusedPresent = Boolean(focusKey) && entries.some((entry) => entry.key === focusKey);

	// Sem foco: abre no fim; com foco: leva a fala tocada ao centro e a destaca um instante.
	useEffect(() => {
		const element = scrollRef.current;
		if (!element || status !== "ready") return;
		if (focusKey && focusedPresent) {
			setFlash(focusKey);
			const target = element.querySelector<HTMLElement>(`[data-entry-key="${CSS.escape(focusKey)}"]`);
			target?.scrollIntoView({ block: "center" });
			const timer = setTimeout(() => setFlash(null), FLASH_MS);
			return () => clearTimeout(timer);
		}
		element.scrollTop = element.scrollHeight;
	}, [status, focusKey, focusedPresent]);

	const title = t("aiElements.bots.exchangeTitle", { self: self.name, peer: peer.name });
	return (
		<div
			className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col bg-background", className)}
			data-testid="bot-exchange-view"
			style={botAccentStyle(peer.color) as CSSProperties}
		>
			<header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex h-14 items-center gap-2 px-3 md:h-12">
				<Button
					aria-label={t("chat.exchange.back")}
					className="pointer-events-auto size-10 shrink-0 rounded-full bg-card hover:bg-card/90 md:size-9"
					onClick={onBack}
					size="icon"
					variant="ghost"
				>
					<ArrowLeftIcon className="size-5" />
				</Button>
				<div
					className="pointer-events-auto flex h-11 min-w-0 max-w-[calc(100%-4rem)] items-center gap-2 rounded-full border bg-card px-3 md:max-w-[calc(100%-16rem)]"
					style={{ borderColor: "var(--bot-accent, var(--border))" }}
				>
					<span className="flex shrink-0 items-center gap-1">
						<AgentAvatar animated={false} bodyColor={self.color} id={self.id} shape={self.shape} size={28} />
						<ArrowRightLeftIcon aria-hidden className="size-3.5 text-muted-foreground" />
						<AgentAvatar animated={false} bodyColor={peer.color} id={peer.id} shape={peer.shape} size={28} />
					</span>
					<h2 className="min-w-0 truncate font-medium text-sm">{title}</h2>
				</div>
				{onOpenPeer ? (
					<Button
						className="pointer-events-auto ml-auto hidden shrink-0 gap-1.5 rounded-full bg-card hover:bg-card/90 md:inline-flex"
						onClick={onOpenPeer}
						size="sm"
						variant="ghost"
					>
						<ExternalLinkIcon className="size-3.5" />
						{t("aiElements.bots.openChatOf", { name: peer.name })}
					</Button>
				) : null}
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" ref={scrollRef}>
				<div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5 px-4 pt-22 pb-6 md:pt-20">
					{hasMore ? (
						<Button
							className="mx-auto mb-2 rounded-full text-xs"
							disabled={loadingMore}
							onClick={onLoadMore}
							size="sm"
							variant="ghost"
						>
							{loadingMore ? t("common.loading") : t("aiElements.bots.loadEarlier")}
						</Button>
					) : null}
					{status === "loading" ? <p className="text-center text-muted-foreground text-sm">{t("aiElements.bots.loadingConversation")}</p> : null}
					{status === "error" ? (
						<p className="rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-destructive text-sm" role="alert">
							{error || t("aiElements.bots.loadError")}
						</p>
					) : null}
					{status === "ready" && entries.length === 0 ? (
						<p className="text-center text-muted-foreground text-sm">
							{t("aiElements.bots.noMessages", { self: self.name, peer: peer.name })}
						</p>
					) : null}
					{entries.map((entry, index) => {
						const position = positionOf(entries, index, separators);
						const last = position === "single" || position === "last";
						const first = position === "single" || position === "first";
						const separator = separators.get(entry.key);
						const side = entry.self ? "right" : "left";
						const author = entry.self ? self : peer;
						return (
							<div className={first && index > 0 && !separator ? "mt-3" : undefined} key={entry.key}>
								{separator ? (
									<Marker className="my-2 text-xs" data-testid="time-separator" variant="separator">
										<MarkerContent>{separator}</MarkerContent>
									</Marker>
								) : null}
								<div
									className={cn("flex items-end gap-2", entry.self ? "justify-end" : "justify-start")}
									data-entry-key={entry.key}
									data-focused={flash === entry.key ? "true" : undefined}
									data-side={side}
								>
									{!entry.self ? (
										<span className="w-7 shrink-0">
											{last ? <AgentAvatar animated={false} bodyColor={author.color} id={author.id} shape={author.shape} size={28} /> : null}
										</span>
									) : null}
									<div className={cn("flex min-w-0 max-w-[85%] flex-col gap-0.5", entry.self ? "items-end" : "items-start")}>
										{entry.title && first ? (
											<span className="px-1 text-caption text-muted-foreground">{entry.title}</span>
										) : null}
										<Bubble align={entry.self ? "end" : "start"} variant="muted">
											<BubbleContent
												className={cn(
													"max-w-[min(68ch,100%)] [overflow-wrap:anywhere] text-foreground/90 transition-shadow duration-500 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
													bubbleRadius(side, position),
													flash === entry.key && "ring-2 ring-[var(--bot-accent,var(--ring))]",
												)}
											>
												<ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
													{entry.text}
												</ReactMarkdown>
											</BubbleContent>
										</Bubble>
										{last ? <span className="px-1 text-[10px] text-muted-foreground/80">{timeLabel(entry.createdAt, locale)}</span> : null}
									</div>
								</div>
							</div>
						);
					})}
				</div>
			</div>

			<footer className="flex shrink-0 items-center justify-center gap-1.5 border-t bg-background px-4 py-3 text-muted-foreground text-xs">
				<LockIcon aria-hidden className="size-3" />
				<span>{t("aiElements.bots.readOnly")}</span>
			</footer>
		</div>
	);
}
