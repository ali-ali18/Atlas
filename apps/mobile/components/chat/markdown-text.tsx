import * as WebBrowser from "expo-web-browser";
import * as React from "react";
import { Platform, ScrollView, Text as RNText, View } from "react-native";
import { SendIcon } from "@/components/icons";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/cn";
import { parseMarkdown, type Block, type Inline } from "@/lib/markdown";
import { themeColor } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, SFMono-Regular, Menlo, monospace" });

function openLink(url: string) {
	void WebBrowser.openBrowserAsync(url).catch(() => undefined);
}

function Inlines({ nodes, scheme }: { nodes: readonly Inline[]; scheme: "light" | "dark" }) {
	const info = themeColor(scheme, "info");
	return (
		<>
			{nodes.map((node, index) => {
				const key = `${index}-${node.type}`;
				switch (node.type) {
					case "text":
						return node.text;
					case "bold":
						return (
							<RNText key={key} style={{ fontWeight: "700" }}>
								<Inlines nodes={node.children} scheme={scheme} />
							</RNText>
						);
					case "italic":
						return (
							<RNText key={key} style={{ fontStyle: "italic" }}>
								<Inlines nodes={node.children} scheme={scheme} />
							</RNText>
						);
					case "code":
						return (
							<RNText key={key} style={{ fontFamily: MONO, fontSize: 14, backgroundColor: themeColor(scheme, "secondary") }}>
								{` ${node.text} `}
							</RNText>
						);
					case "link":
						// Link e referência a documento aparecem com o ícone azul de link, como na referência do dono.
						// (No celular o ícone é uma view em linha dentro do texto; na prévia web um <svg> quebraria a linha, então lá vai um glifo.)
						return (
							<RNText key={key} accessibilityRole="link" onPress={() => openLink(node.url)} style={{ color: info }}>
								{Platform.OS === "web" ? "➤ " : <SendIcon size={16} tone="info" />} {node.text}
							</RNText>
						);
				}
			})}
		</>
	);
}

function BlockView({ block, scheme }: { block: Block; scheme: "light" | "dark" }) {
	switch (block.type) {
		case "paragraph":
			return (
				<Text className="text-control leading-6">
					<Inlines nodes={block.inline} scheme={scheme} />
				</Text>
			);
		case "heading":
			return (
				<Text className={cn("font-semibold leading-6", block.level === 1 ? "text-xl leading-7" : block.level === 2 ? "text-lg leading-7" : "text-control")}>
					<Inlines nodes={block.inline} scheme={scheme} />
				</Text>
			);
		case "list":
			return (
				<View className="gap-1.5">
					{block.items.map((item, index) => (
						<View key={`${index}-${block.ordered}`} className="flex-row gap-2.5 pl-1">
							<Text variant="muted" className="w-5 text-control leading-6">
								{block.ordered ? `${block.start + index}.` : "•"}
							</Text>
							<Text className="min-w-0 flex-1 text-control leading-6">
								<Inlines nodes={item} scheme={scheme} />
							</Text>
						</View>
					))}
				</View>
			);
		case "code":
			return (
				<View className="overflow-hidden rounded-card bg-secondary">
					<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="p-3">
						<RNText selectable style={{ fontFamily: MONO, fontSize: 13, lineHeight: 19, color: themeColor(scheme, "foreground") }}>
							{block.text}
						</RNText>
					</ScrollView>
				</View>
			);
		case "quote":
			return (
				<View className="border-l-2 border-border pl-3">
					<Text variant="muted" className="text-control leading-6">
						<Inlines nodes={block.inline} scheme={scheme} />
					</Text>
				</View>
			);
		case "rule":
			return <View className="h-px bg-border" />;
	}
}

/** Fala do bot em markdown: negrito, listas, `código` inline, bloco de código, citação e links. */
export const MarkdownText = React.memo(function MarkdownText({ source }: { source: string }) {
	const scheme = useAppColorScheme();
	const blocks = React.useMemo(() => parseMarkdown(source), [source]);
	return (
		<View className="gap-3">
			{blocks.map((block, index) => (
				<BlockView key={`${index}-${block.type}`} block={block} scheme={scheme} />
			))}
		</View>
	);
});
