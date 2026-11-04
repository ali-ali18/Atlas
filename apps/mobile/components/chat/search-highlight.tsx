import * as React from "react";
import { Text as RNText } from "react-native";
import { highlightParts } from "@/lib/chat-search";
import { hexAlpha } from "@/lib/color-math";
import { themeColor } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

/** Busca aberta no chat: a consulta e a mensagem da ocorrência atual (`null` = nenhuma). */
export type ChatSearchState = { query: string; activeId: string | null };

const SearchContext = React.createContext<ChatSearchState>({ query: "", activeId: null });
export const ChatSearchProvider = SearchContext.Provider;

type Highlight = { query: string; strong: boolean };
const HighlightContext = React.createContext<Highlight | null>(null);

/**
 * Liga o realce da busca para os textos de dentro da fala `itemId`. A mensagem da ocorrência atual ganha o realce forte;
 * as demais, o suave. Sem busca aberta não muda nada.
 */
export function MessageHighlight({ itemId, children }: { itemId: string; children: React.ReactNode }) {
	const { query, activeId } = React.useContext(SearchContext);
	const value = React.useMemo<Highlight | null>(() => (query.trim() ? { query, strong: activeId === itemId } : null), [query, activeId, itemId]);
	return <HighlightContext.Provider value={value}>{children}</HighlightContext.Provider>;
}

/**
 * Texto com os trechos achados realçados (fundo `warning` do tema com opacidade; forte na mensagem da ocorrência atual,
 * com o texto em `warning-foreground`). Sem busca devolve o texto cru. Usado só em texto corrido: código e link ficam
 * como estão.
 */
export function HighlightedText({ text }: { text: string }) {
	const highlight = React.useContext(HighlightContext);
	const scheme = useAppColorScheme();
	const parts = React.useMemo(() => (highlight ? highlightParts(text, highlight.query) : null), [highlight, text]);
	if (!highlight || !parts || !parts.some((part) => part.match)) return <>{text}</>;
	const style = highlight.strong ? { backgroundColor: hexAlpha(themeColor(scheme, "warning"), 0.85), color: themeColor(scheme, "warning-foreground") } : { backgroundColor: hexAlpha(themeColor(scheme, "warning"), 0.35) };
	return (
		<>
			{parts.map((part, index) =>
				part.match ? (
					<RNText key={index} style={style}>
						{part.text}
					</RNText>
				) : (
					<React.Fragment key={index}>{part.text}</React.Fragment>
				),
			)}
		</>
	);
}
