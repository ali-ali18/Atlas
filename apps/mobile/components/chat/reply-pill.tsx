import * as React from "react";
import { ChromePill } from "@/components/ui/chrome-pill";
import { Text } from "@/components/ui/text";
import type { ReplyQuote } from "@/lib/chat-types";

/**
 * Pílula com o trecho citado, acima do balão que respondeu (à direita no balão do usuário, à esquerda no do bot).
 * `spaced`: margem própria no topo, para quando o balão está no meio do grupo (no início, o respiro vem da linha).
 */
export function ReplyPill({ quote, align, spaced = false }: { quote: ReplyQuote; align: "start" | "end"; spaced?: boolean }) {
	return (
		<ChromePill height={null} className={`mb-1 max-w-full px-3 py-1 ${spaced ? "mt-3" : ""} ${align === "end" ? "self-end" : "self-start"}`}>
			<Text accessibilityLabel={`Em resposta a: ${quote.text}`} numberOfLines={1} ellipsizeMode="tail" variant="caption">
				{quote.text}
			</Text>
		</ChromePill>
	);
}
