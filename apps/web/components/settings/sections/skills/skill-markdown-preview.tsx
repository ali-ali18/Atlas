"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@workspace/ui/lib/utils";
import { markdownComponents } from "@/components/ui/templates/template-4/chat-thread/assistant-message";

/**
 * Prévia do corpo da skill com o mesmo renderer do chat. Sem `rehype-raw`: HTML
 * cru no markdown aparece como texto, nunca é injetado (sem `dangerouslySetInnerHTML`).
 */
export function SkillMarkdownPreview({ markdown, className }: { markdown: string; className?: string }) {
	if (!markdown.trim()) {
		return <p className={cn("text-sm text-muted-foreground", className)}>Nada para visualizar ainda.</p>;
	}
	return (
		<div className={cn("text-sm break-words", className)} data-slot="skill-markdown-preview">
			<ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
				{markdown}
			</ReactMarkdown>
		</div>
	);
}
