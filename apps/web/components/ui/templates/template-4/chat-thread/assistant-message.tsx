"use client";

import { isValidElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import {
	Bubble,
	BubbleContent,
	BubbleReactions,
} from "@workspace/ui/components/bubble";
import { cn } from "@workspace/ui/lib/utils";

import { MarkdownCodeBlock } from "@/components/ai-elements/files/markdown-code-block";
import { sanitizeAssistantText } from "@/lib/sanitize-message";
import { useRevealedText } from "@/hooks/use-revealed-text";

import { bubbleRadius, type GroupPosition } from "./bubble-radius";
import { CopyButton, ReactionBadges, ReactionTrigger, useMessageReactionControls } from "./message-reactions";

function nodeText(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(nodeText).join("");
	return "";
}

/** Reutilizado fora do chat (ex: instrução da rotina) — mesmo estilo de markdown. */
export const markdownComponents: Components = {
	h1: ({ node: _node, ...props }) => (
		<h1 className="mt-3 mb-1.5 font-heading font-semibold text-base" {...props} />
	),
	h2: ({ node: _node, ...props }) => (
		<h2 className="mt-3 mb-1.5 font-heading font-semibold text-sm" {...props} />
	),
	h3: ({ node: _node, ...props }) => (
		<h3 className="mt-2 mb-1 font-medium text-sm" {...props} />
	),
	p: ({ node: _node, ...props }) => (
		<p className="leading-relaxed [overflow-wrap:anywhere]" {...props} />
	),
	ul: ({ node: _node, ...props }) => (
		<ul className="my-1 list-disc space-y-0.5 pl-5" {...props} />
	),
	ol: ({ node: _node, ...props }) => (
		<ol className="my-1 list-decimal space-y-0.5 pl-5" {...props} />
	),
	li: ({ node: _node, ...props }) => (
		<li className="min-w-0 leading-relaxed [overflow-wrap:anywhere]" {...props} />
	),
	strong: ({ node: _node, ...props }) => (
		<strong className="font-semibold" {...props} />
	),
	a: ({ node: _node, ...props }) => (
		<a
			className="text-primary underline underline-offset-2 [overflow-wrap:anywhere]"
			rel="noreferrer"
			target="_blank"
			{...props}
		/>
	),
	code: ({ node: _node, className, children, ...props }) => {
		const isBlock =
			typeof className === "string" && className.startsWith("language-");
		if (isBlock) {
			return (
				<code className="font-mono text-xs" {...props}>
					{children}
				</code>
			);
		}
		return (
			<code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] [overflow-wrap:anywhere]" {...props}>
				{children}
			</code>
		);
	},
	pre: ({ node: _node, children }) => {
		const child = Array.isArray(children) ? children[0] : children;
		if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
			const lang = /language-([^\s]+)/.exec(child.props.className ?? "")?.[1];
			return <MarkdownCodeBlock code={nodeText(child.props.children)} language={lang} />;
		}
		return <MarkdownCodeBlock code={nodeText(children)} />;
	},
	table: ({ node: _node, ...props }) => (
		<div className="my-2 w-full max-w-full overflow-x-auto [overflow-wrap:normal]">
			<table className="w-full border-collapse text-sm" {...props} />
		</div>
	),
	th: ({ node: _node, ...props }) => (
		<th
			className="border-border border-b px-2 py-1 text-left font-medium"
			{...props}
		/>
	),
	td: ({ node: _node, ...props }) => (
		<td className="border-border/50 border-b px-2 py-1 align-top" {...props} />
	),
	blockquote: ({ node: _node, ...props }) => (
		<blockquote
			className="my-2 border-border border-l-2 pl-3 text-muted-foreground"
			{...props}
		/>
	),
	hr: ({ node: _node, ...props }) => (
		<hr className="my-3 border-border" {...props} />
	),
};

export function AssistantMessage({
	live = false,
	text,
	groupPosition = "single",
	reactions,
	messageId,
	markdownComponents: components = markdownComponents,
}: {
	live?: boolean;
	text: string;
	/** Id da fala no servidor: habilita reagir (e mostra as reações gravadas). */
	messageId?: string;
	groupPosition?: GroupPosition;
	reactions?: React.ReactNode | string | null;
	/** Grupo: markdown com chips de menção. Padrão: o mesmo de todo o chat. */
	markdownComponents?: Components;
}) {
	const clean = sanitizeAssistantText(text, { live });
	const revealed = useRevealedText(clean, live);
	const controls = useMessageReactionControls(messageId);
	const activeReaction = reactions ?? null;
	if (clean.length === 0) {
		return null;
	}

	return (
		<div className="group/message flex min-w-0 max-w-full items-center gap-2.5">
			<Bubble variant="muted">
				<BubbleContent
					className={cn(
						"max-w-[min(68ch,100%)] [overflow-wrap:anywhere] text-foreground/90 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
						bubbleRadius("left", groupPosition),
					)}
				>
					{revealed.length > 0 ? (
						<ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>
							{revealed}
						</ReactMarkdown>
					) : null}
					{live ? (
						<span
							aria-hidden
							className="ml-0.5 inline-block h-[1em] w-[1.5px] translate-y-[0.15em] bg-foreground/70 motion-safe:animate-pulse"
						/>
					) : null}
				</BubbleContent>
				{activeReaction ? (
					typeof activeReaction === "string" ? (
						<BubbleReactions role="img" aria-label={`Reaction: ${activeReaction}`}>
							<span>{activeReaction}</span>
						</BubbleReactions>
					) : (
						<BubbleReactions role="img">{activeReaction}</BubbleReactions>
					)
				) : (
					<ReactionBadges reactions={controls.reactions} />
				)}
			</Bubble>
			{!live ? (
				<div className="flex shrink-0 items-center">
					{controls.canReact ? <ReactionTrigger onSelect={controls.onSelect} /> : null}
					<CopyButton text={clean} />
				</div>
			) : null}
		</div>
	);
}
