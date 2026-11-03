import { MarkdownText } from "@/components/chat/markdown-text";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/cn";
import { headingStyle } from "@/lib/page-views";
import { type Of, usePageTheme } from "./page-theme";

/** Markdown pelo renderizador do chat: sem HTML, links só http(s) (abrem no navegador do sistema). */
export function TextNode({ node }: { node: Of<"text"> }) {
	return <MarkdownText source={node.props.markdown} />;
}

export function HeadingNode({ node }: { node: Of<"heading"> }) {
	const style = headingStyle(node.props.level);
	const { surface } = usePageTheme();
	return (
		<Text accessibilityRole="header" numberOfLines={4} className={cn("font-semibold", style.uppercase && "uppercase tracking-wide")} style={{ fontSize: style.size, lineHeight: style.lineHeight, ...(style.muted ? { color: surface.muted } : null) }}>
			{node.props.text}
		</Text>
	);
}
