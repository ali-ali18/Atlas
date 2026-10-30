"use client";

import {
	CheckIcon,
	CopyIcon,
	PlusIcon,
	SearchIcon,
	SmilePlusIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { BubbleReactions } from "@workspace/ui/components/bubble";
import { Button } from "@workspace/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@workspace/ui/components/popover";
import { BOT_REACTION_EMOJIS, type MessageReaction } from "@workspace/shared";
import { hoverRevealClass } from "@/lib/hover-reveal";
import { useT } from "@/lib/i18n/provider";
import { isPersistedMessageId, messageReactions, useMessageReactions } from "@/lib/message-reactions";
import { cn } from "@workspace/ui/lib/utils";
import { EMOJI_INDEX } from "./emoji-index";

/** Mesmo conjunto fixo que o bot usa para reagir; "+" abre o resto. */
export const REACTION_EMOJIS = BOT_REACTION_EMOJIS;


function normalize(value: string) {
	return value
		.trim()
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "");
}

function EmojiGrid({ onSelect }: { onSelect: (emoji: string) => void }) {
	const t = useT();
	const [query, setQuery] = useState("");
	const filtered = useMemo(() => {
		const q = normalize(query);
		if (!q) return EMOJI_INDEX;
		return EMOJI_INDEX.filter((entry) => normalize(Object.values(entry.keys).join(" ")).includes(q));
	}, [query]);
	return (
		<>
			<label className="flex items-center gap-2 border-b px-3 py-2.5">
				<SearchIcon className="size-4 shrink-0 text-muted-foreground" />
				<input
					aria-label={t("chatExtras.searchEmoji")}
					autoFocus
					className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
					onChange={(e) => setQuery(e.target.value)}
					placeholder={t("chatExtras.searchEmoji")}
					value={query}
				/>
			</label>
			<p className="px-3 pt-2.5 pb-1 text-muted-foreground text-xs">
				{t("chatExtras.emojiGroup")}
			</p>
			<div
				aria-label={t("chatExtras.emojisAvailable")}
				className="grid max-h-64 grid-cols-8 gap-0.5 overflow-y-auto px-2 pb-2"
				role="listbox"
			>
				{filtered.length > 0 ? (
					filtered.map((entry) => (
						<button
							aria-label={t("chatExtras.reactWith", { emoji: entry.char })}
							className="grid size-8 place-items-center rounded-lg text-xl transition-colors hover:bg-muted"
							key={entry.char}
							onClick={() => onSelect(entry.char)}
							role="option"
							type="button"
						>
							<span>{entry.char}</span>
						</button>
					))
				) : (
					<p className="col-span-8 px-2 py-4 text-center text-muted-foreground text-xs">
						{t("chatExtras.noEmoji")}
					</p>
				)}
			</div>
		</>
	);
}

export function ReactionTrigger({
	onSelect,
	className,
	align = "start",
}: {
	onSelect: (emoji: string) => void;
	className?: string;
	align?: "start" | "end" | "center";
}) {
	const t = useT();
	const [menuOpen, setMenuOpen] = useState(false);
	const [gridOpen, setGridOpen] = useState(false);
	const pick = (emoji: string) => {
		onSelect(emoji);
		setGridOpen(false);
		setMenuOpen(false);
	};
	const openGrid = () => {
		setMenuOpen(false);
		setGridOpen(true);
	};
	return (
		<Popover
			onOpenChange={(o) => setGridOpen(o)}
			open={gridOpen}
		>
			<DropdownMenu onOpenChange={(o) => setMenuOpen(o)} open={menuOpen}>
				<DropdownMenuTrigger
					render={
						<Button
							aria-label={t("chatExtras.react")}
							className={cn(
								"shrink-0 data-[popup-open]:opacity-100",
								hoverRevealClass("message"),
								className,
							)}
							size="icon-xs"
							variant="ghost"
						/>
					}
				>
					<SmilePlusIcon />
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align={align}
					className="flex w-auto min-w-0 items-center gap-0.5 rounded-full p-1.5"
					side="top"
					sideOffset={8}
				>
					{REACTION_EMOJIS.map((emoji) => (
						<button
							aria-label={t("chatExtras.reactWith", { emoji })}
							className="grid size-8 place-items-center rounded-full text-lg transition-colors hover:bg-muted"
							key={emoji}
							onClick={() => pick(emoji)}
							type="button"
						>
							<span>{emoji}</span>
						</button>
					))}
					<button
						aria-label={t("chatExtras.moreEmojis")}
						className="grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						onClick={openGrid}
						type="button"
					>
						<PlusIcon className="size-4" />
					</button>
				</DropdownMenuContent>
			</DropdownMenu>
			<PopoverTrigger
				nativeButton={false}
				render={<span aria-hidden className="size-0 shrink-0 overflow-hidden" />}
			/>
			<PopoverContent
				align={align}
				className="w-72 gap-0 overflow-hidden p-0 data-open:animate-none data-closed:animate-none"
				side="top"
				sideOffset={8}
			>
				<EmojiGrid onSelect={pick} />
			</PopoverContent>
		</Popover>
	);
}

export async function copyText(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// cai para o fallback abaixo
	}
	try {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.setAttribute("readonly", "");
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.select();
		const ok = document.execCommand("copy");
		document.body.removeChild(ta);
		return ok;
	} catch {
		return false;
	}
}

export function CopyButton({ text }: { text: string }) {
	const t = useT();
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		return () => {
			if (timer.current) clearTimeout(timer.current);
		};
	}, []);
	const copyLabel = copied ? t("chatExtras.copied") : t("common.copy");
	return (
		<Button
			aria-label={copyLabel}
			className={cn("shrink-0", hoverRevealClass("message"))}
			onClick={() => {
				void copyText(text).then((ok) => {
					if (!ok) return;
					setCopied(true);
					if (timer.current) clearTimeout(timer.current);
					timer.current = setTimeout(() => setCopied(false), 1500);
				});
			}}
			size="icon-xs"
			variant="ghost"
		>
			{copied ? <CheckIcon /> : <CopyIcon />}
		</Button>
	);
}

/** Reações de uma fala gravada no servidor: balão com os emojis, e o seletor que reage (otimista, com aviso se falhar). */
export function useMessageReactionControls(messageId: string | undefined) {
	const reactions = useMessageReactions(messageId ?? "");
	const canReact = Boolean(messageId && isPersistedMessageId(messageId));
	return {
		reactions,
		canReact,
		onSelect: (emoji: string) => {
			if (messageId && canReact) void messageReactions.toggle(messageId, emoji);
		},
	};
}

/** Emojis das reações (o usuário e o bot), sem repetir o mesmo emoji. */
export function ReactionBadges({ reactions }: { reactions: readonly MessageReaction[] }) {
	const t = useT();
	if (reactions.length === 0) return null;
	const emojis = [...new Set(reactions.map((reaction) => reaction.emoji))];
	return (
		<BubbleReactions aria-label={t("chatExtras.reactionLabel", { emojis: emojis.join(" ") })} role="img">
			{emojis.map((emoji) => (
				<span key={emoji}>{emoji}</span>
			))}
		</BubbleReactions>
	);
}

export function SelectedReaction({ emoji }: { emoji: string | null }) {
	const t = useT();
	if (!emoji) return null;
	return (
		<BubbleReactions role="img" aria-label={t("chatExtras.reactionLabel", { emojis: emoji })}>
			<span>{emoji}</span>
		</BubbleReactions>
	);
}
