import * as WebBrowser from "expo-web-browser";
import * as React from "react";
import { Platform, ScrollView, Text as RNText, View } from "react-native";
import { SendIcon } from "@/components/icons";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/cn";
import { parseMarkdown, tableColumnWidths, type Block, type Inline } from "@/lib/markdown";
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

/**
 * Tabela como no Grok: um cartão único (a tabela inteira é o balão, sem balão por fora), rola para o lado com a
 * barrinha de rolagem no canto. Larguras explícitas por coluna (`tableColumnWidths`): no Android um ScrollView
 * horizontal sem tamanho definido esticava as linhas até a altura da tela (cartão gigante e vazio).
 */
export function TableCard({ block, scheme }: { block: Extract<Block, { type: "table" }>; scheme: "light" | "dark" }) {
	const widths = tableColumnWidths(block.header, block.rows);
	const total = widths.reduce((sum, width) => sum + width, 0);
	return (
		<View className="self-stretch overflow-hidden rounded-3xl border border-border bg-muted">
			<ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator style={{ flexGrow: 0 }} contentContainerStyle={{ flexGrow: 0 }}>
				<View style={{ width: total }}>
					{[block.header, ...block.rows].map((row, rowIndex) => (
						<View key={`row-${rowIndex}`} style={{ flexDirection: "row" }} className={rowIndex > 0 ? "border-t border-border" : undefined}>
							{row.map((cell, column) => (
								<View key={`cell-${column}`} style={{ width: widths[column] }} className="px-5 py-3">
									<Text className={cn("text-base leading-snug", rowIndex === 0 && "font-semibold")}>
										<Inlines nodes={cell} scheme={scheme} />
									</Text>
								</View>
							))}
						</View>
					))}
				</View>
			</ScrollView>
		</View>
	);
}

function BlockView({ block, scheme }: { block: Block; scheme: "light" | "dark" }) {
	switch (block.type) {
		case "paragraph":
			return (
				<Text className="text-base leading-snug">
					<Inlines nodes={block.inline} scheme={scheme} />
				</Text>
			);
		case "heading":
			return (
				<Text className={cn("font-semibold leading-snug", block.level === 1 ? "text-xl leading-7" : block.level === 2 ? "text-lg leading-7" : "text-base")}>
					<Inlines nodes={block.inline} scheme={scheme} />
				</Text>
			);
		case "list":
			return (
				<View className="gap-1.5">
					{block.items.map((item, index) => (
						<View key={`${index}-${block.ordered}`} className="flex-row gap-2.5 pl-1">
							<Text variant="muted" className="w-5 text-base leading-snug">
								{block.ordered ? `${block.start + index}.` : "•"}
							</Text>
							{/*
							  `shrink`, não `flex-1`: o balão do bot se ajusta ao conteúdo (self-start), e no Android um `flex-1`
							  dentro dele mede largura 0. O texto da lista sumia e o balão virava uma coluna alta só com "1."
							*/}
							<Text className="min-w-0 shrink text-base leading-snug">
								<Inlines nodes={item} scheme={scheme} />
							</Text>
						</View>
					))}
				</View>
			);
		case "code":
			return (
				// Rola na horizontal dentro do balão (largura do balão, sem estourar nem cortar a linha).
				<View className="self-stretch overflow-hidden rounded-card bg-secondary">
					<ScrollView horizontal nestedScrollEnabled style={{ width: "100%" }} contentContainerStyle={{ padding: 12, minWidth: "100%" }}>
						<RNText style={{ fontFamily: MONO, fontSize: 13, lineHeight: 19, color: themeColor(scheme, "foreground") }}>
							{block.text}
						</RNText>
					</ScrollView>
				</View>
			);
		case "quote":
			return (
				<View className="border-l-2 border-border pl-3">
					<Text variant="muted" className="text-base leading-snug">
						<Inlines nodes={block.inline} scheme={scheme} />
					</Text>
				</View>
			);
		case "table":
			return <TableCard block={block} scheme={scheme} />;
		case "rule":
			return <View className="h-px bg-border" />;
	}
}

/** Blocos já separados (parágrafos, listas, código…) um sobre o outro, para o balão. */
export function MarkdownBlocks({ blocks }: { blocks: readonly Block[] }) {
	const scheme = useAppColorScheme();
	return (
		<View className="gap-3">
			{blocks.map((block, index) => (
				<BlockView key={`${index}-${block.type}`} block={block} scheme={scheme} />
			))}
		</View>
	);
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
