import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PageNode } from "@workspace/shared";
import { cn } from "@workspace/ui/lib/utils";

import { markdownComponents } from "@/components/ui/templates/template-4/chat-thread/assistant-message";

type Of<T extends PageNode["type"]> = Extract<PageNode, { type: T }>;

/** Markdown pelo renderizador seguro do chat (sem HTML cru). */
export function TextNode({ node }: { node: Of<"text"> }) {
	return (
		<div className="flex flex-col gap-2 text-sm [overflow-wrap:anywhere]" data-page-node="text">
			<ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
				{node.props.markdown}
			</ReactMarkdown>
		</div>
	);
}

const HEADING = {
	1: ["h3", "text-base"],
	2: ["h4", "text-sm"],
	3: ["h5", "text-xs uppercase tracking-wide text-muted-foreground"],
} as const;

export function HeadingNode({ node }: { node: Of<"heading"> }) {
	const [Tag, size] = HEADING[node.props.level ?? 2];
	return (
		<Tag className={cn("font-heading font-semibold [overflow-wrap:anywhere]", size)} data-page-node="heading">
			{node.props.text}
		</Tag>
	);
}
