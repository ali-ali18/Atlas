import * as React from "react";
import { Pressable, View } from "react-native";
import Animated, { FadeIn, useReducedMotion } from "react-native-reanimated";
import { bubbleRadius, type GroupPosition } from "@workspace/shared";
import { Text } from "@/components/ui/text";
import { taskCardActive } from "@/lib/chat-thread";
import type { ChatItem, Reaction, ReplyQuote } from "@/lib/chat-types";
import type { AnswerMap } from "@/lib/questionnaire";
import { ConfirmCard, MarkerRow, QuestionnaireCard, WebCardRow } from "./cards";
import { MarkdownBlocks, TableCard } from "./markdown-text";
import { useAppColorScheme } from "@/lib/use-theme";
import { chatSurface } from "@/lib/chat-surface";
import { parseMarkdown, splitSegments } from "@/lib/markdown";
import { ReplyPill } from "./reply-pill";
import { TaskSummary } from "./task-dock";

export type RowActions = {
	onDecide: (item: Extract<ChatItem, { kind: "confirm" }>, approve: boolean) => void;
	onAnswer: (item: Extract<ChatItem, { kind: "questionnaire" }>, answers: AnswerMap) => void;
	/** Run ativo (id): o cartão de tarefas desse run mostra a tarefa em execução. */
	activeRunId: string | null;
	/** Há um run em andamento (o cartão só é "ativo" durante um run). */
	running: boolean;
	onOpenWeb: (item: Extract<ChatItem, { kind: "web-card" }>) => void;
	/** Toque longo no balão: abre o menu da mensagem (só abre para fala já gravada; ver `messageMenuFor`). */
	onOpenMenu: (item: ChatItem) => void;
	/** Cor do bot para o balão do usuário (fundo e texto por cima dele). Sem ela, o balão usa o cinza neutro. */
	userBubble?: { background: string; foreground: string };
};

/** Balão do usuário, à direita, na cor do bot (como no Grok); sem a cor, o cinza do `Bubble variant="muted"` do web. */
function UserBubble({ text, position, reactions, replyTo, accent, onLongPress }: { text: string; position: GroupPosition; reactions?: Reaction[]; replyTo?: ReplyQuote; accent?: RowActions["userBubble"]; onLongPress: () => void }) {
	return (
		<View className="max-w-[87%] self-end">
			{replyTo ? <ReplyPill quote={replyTo} align="end" spaced={position !== "single" && position !== "first"} /> : null}
			{/* Sem `selectable`: o toque longo abre o menu (a seleção está em "Selecionar texto"). */}
			<Pressable
				onLongPress={onLongPress}
				accessibilityHint="Segure para ver as ações da mensagem"
				style={accent ? { backgroundColor: accent.background } : undefined}
				className={`px-3.5 py-3.5 ${accent ? "" : "bg-muted"} ${bubbleRadius("right", position)}`}
			>
				<Text className="text-base leading-snug" style={accent ? { color: accent.foreground } : undefined}>
					{text}
				</Text>
			</Pressable>
			<Reactions reactions={reactions} align="end" />
		</View>
	);
}

/**
 * Reações sob o balão, como os `ReactionBadges` do web: a do bot numa fala do usuário é a resposta dele quando só
 * reage ("valeu!" → ❤️), então precisa aparecer, senão parece que o bot não respondeu.
 */
function Reactions({ reactions, align }: { reactions?: Reaction[]; align: "start" | "end" }) {
	if (!reactions?.length) return null;
	return (
		<View className={`-mt-2 flex-row gap-1 px-2 ${align === "end" ? "self-end" : "self-start"}`} accessibilityLabel={`Reação: ${reactions.map((item) => item.emoji).join(" ")}`}>
			{reactions.map((item) => (
				<View key={item.actor} className="rounded-full border-2 border-background bg-muted px-1.5 py-0.5">
					<Text className="text-sm">{item.emoji}</Text>
				</View>
			))}
		</View>
	);
}

/**
 * Balão do bot: escuro, arredondado, com markdown. Medidas do Grok (print do dono): 80% da tela de largura máxima
 * (87% da lista), margem de 14 pt dos lados e de cima/baixo, texto de 16 pt com entrelinha de 22 pt.
 */
function BotBubble({ text, position, reactions, replyTo, onLongPress }: { text: string; position: GroupPosition; reactions?: Reaction[]; replyTo?: ReplyQuote; onLongPress: () => void }) {
	const scheme = useAppColorScheme();
	// Tabela não vai dentro do balão: é um cartão só (como no Grok); o texto em volta vira balões.
	const segments = React.useMemo(() => splitSegments(parseMarkdown(text)), [text]);
	return (
		<View className="max-w-[87%] gap-1.5 self-start">
			{replyTo ? <ReplyPill quote={replyTo} align="start" spaced={position !== "single" && position !== "first"} /> : null}
			{segments.map((segment, index) =>
				segment.kind === "table" ? (
					<Pressable key={`table-${index}`} onLongPress={onLongPress} accessibilityHint="Segure para ver as ações da mensagem">
						<TableCard block={segment.block} scheme={scheme} />
					</Pressable>
				) : (
					<Pressable key={`bubble-${index}`} onLongPress={onLongPress} accessibilityHint="Segure para ver as ações da mensagem" style={{ backgroundColor: chatSurface(scheme, "bubble") }} className={`px-3.5 py-3.5 ${bubbleRadius("left", position)}`}>
						<MarkdownBlocks blocks={segment.blocks} />
					</Pressable>
				),
			)}
			<Reactions reactions={reactions} align="start" />
		</View>
	);
}

/**
 * Respiro extra quando muda quem fala: 6 + o gap da lista (6) = 12 pt entre autores, como no Grok (medido no print de
 * referência do dono: 12,3 pt). Dentro do mesmo autor o vão fica só nos 6 do gap da lista.
 */
const AUTHOR_GAP = 6;

/** Primeira fala de um grupo do mesmo autor (ou fala sozinha): é onde a conversa troca de voz. */
function startsAuthorGroup(item: ChatItem, position: GroupPosition): boolean {
	return (item.kind === "user" || item.kind === "assistant") && (position === "single" || position === "first");
}

/**
 * Mensagem que chegou com a tela aberta entra com um fade curto, como no web; as que já estavam (cache, histórico)
 * aparecem direto. Só opacidade: a lista é invertida, e deslocar na vertical sairia ao contrário.
 */
export const MessageRow = React.memo(function MessageRow({
	item,
	actions,
	animate = false,
	position = "single",
}: {
	item: ChatItem;
	actions: RowActions;
	animate?: boolean;
	/** Posição no grupo de falas seguidas do mesmo autor: cantos "conectados" como no web (`bubbleRadius`). */
	position?: GroupPosition;
}) {
	const reduced = useReducedMotion();
	// O invólucro existe sempre (só o `entering` muda): trocar de estrutura remontaria o cartão e perderia o estado
	// dele (respostas do questionário, por exemplo). `entering` só vale na montagem.
	return (
		<Animated.View entering={animate && !reduced ? FadeIn.duration(220) : undefined} style={startsAuthorGroup(item, position) ? { marginTop: AUTHOR_GAP } : undefined}>
			<RowContent item={item} actions={actions} position={position} />
		</Animated.View>
	);
});

/** Escolhe o desenho pelo tipo, como o `message-row` do web. */
function RowContent({ item, actions, position }: { item: ChatItem; actions: RowActions; position: GroupPosition }) {
	switch (item.kind) {
		case "user":
			return <UserBubble text={item.text} position={position} reactions={item.reactions} replyTo={item.replyTo} accent={actions.userBubble} onLongPress={() => actions.onOpenMenu(item)} />;
		case "assistant":
			return item.text.trim() ? <BotBubble text={item.text} position={position} reactions={item.reactions} replyTo={item.replyTo} onLongPress={() => actions.onOpenMenu(item)} /> : null;
		case "task-list":
			return <TaskSummary items={item.items} active={taskCardActive(item.runId, actions.activeRunId, actions.running)} />;
		case "confirm":
			return <ConfirmCard item={item} onDecide={actions.onDecide} />;
		case "questionnaire":
			return <QuestionnaireCard item={item} onAnswer={actions.onAnswer} />;
		case "web-card":
			return <WebCardRow item={item} onOpen={actions.onOpenWeb} />;
		case "marker":
			return <MarkerRow text={item.text} />;
	}
}
