import { MarkdownText } from "@/components/chat/markdown-text";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/cn";
import { type Of } from "./page-theme";

/** Markdown pelo renderizador do chat: sem HTML, links só http(s) (abrem no navegador do sistema). */
export function TextNode({ node }: { node: Of<"text"> }) {
	return <MarkdownText source={node.props.markdown} />;
}

const HEADING = {
	1: "text-xl font-semibold leading-7",
	2: "text-lg font-semibold leading-6",
	3: "text-caption font-semibold uppercase tracking-wide text-muted-foreground",
} as const;

export function HeadingNode({ node }: { node: Of<"heading"> }) {
	return (
		<Text accessibilityRole="header" numberOfLines={4} className={cn(HEADING[node.props.level ?? 2])}>
			{node.props.text}
		</Text>
	);
}
