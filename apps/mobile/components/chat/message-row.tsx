import * as React from "react";
import { Pressable, View } from "react-native";
import Animated, { FadeIn, useReducedMotion } from "react-native-reanimated";
import type { GroupPosition } from "@workspace/shared";
import { BUBBLE_MAX_WIDTH_CLASS, bubbleCorners, cornersNextToTable } from "@/lib/bubble-corners";
import { Text } from "@/components/ui/text";
import { taskCardActive } from "@/lib/chat-thread";
import type { ChatItem, Reaction, ReplyQuote } from "@/lib/chat-types";
import type { ResumeOptions } from "@/lib/chat-api";
import type { AnswerMap } from "@/lib/questionnaire";
import type { HomeBot } from "@/lib/home-types";
import { BotExchangeMarker } from "./bot-exchange-marker";
import { ImagesRow } from "./image-card";
import { BotProfileCard, BotProposalCard } from "./bot-cards";
import { BotLinkMarkerRow, ConfirmCard, MarkerRow, WebCardRow } from "./cards";
import { loginVariant } from "@/lib/request-cards";
import type { RequestActions } from "@/lib/use-request-actions";
import { ConnectorCard } from "./connector-card";
import { LoginCard } from "./login-card";
import { QuestionnaireCard } from "./questionnaire-card";
import { SecretsCard } from "./secrets-card";
import { MarkdownBlocks, TableCard } from "./markdown-text";
import { useAppColorScheme } from "@/lib/use-theme";
import { surfaceColors } from "@/lib/surfaces";
import { parseMarkdown, splitSegments } from "@/lib/markdown";
import { MentionText } from "./mention-text";
import { HighlightedText, MessageHighlight } from "./search-highlight";
import { isPlainMessage, splitMessageText, type MentionBotRef } from "@/lib/message-text";
import { ReplyPill } from "./reply-pill";
import { TaskSummary } from "./task-dock";

export type RowActions = {
	onDecide: (item: Pick<Extract<ChatItem, { kind: "confirm" }>, "confirmId" | "title" | "status">, approve: boolean) => void;
	onAnswer: (item: Extract<ChatItem, { kind: "questionnaire" }>, answers: AnswerMap) => void;
	/** Run ativo (id): o cartão de tarefas desse run mostra a tarefa em execução. */
	activeRunId: string | null;
	/** Há um run em andamento (o cartão só é "ativo" durante um run). */
	running: boolean;
	/** "Criar agente" / "Aplicar" e "Agora não" dos cartões de proposta. */
	onResolveProposal: (item: Extract<ChatItem, { kind: "bot-proposal" | "bot-profile" }>, decision: "approved" | "rejected") => void;
	/** "Abrir conversa" do agente criado pelo cartão. */
	onOpenBot: (botId: string) => void;
	onOpenWeb: (item: Extract<ChatItem, { kind: "web-card" }>) => void;
	/** Painel com id: abre a tela nativa do painel. */
	onOpenPage: (item: Extract<ChatItem, { kind: "web-card" }>) => void;
	/** Toque numa imagem do fio: abre o visualizador nela. */
	onOpenImage: (artifactId: string) => void;
	/** Cartões de pedido (conectar app, login, segredo): retomar o run, abrir a tela do bot e as chamadas à API. */
	onResumeLogin: (item: Extract<ChatItem, { kind: "login" }>, options?: ResumeOptions) => void;
	onOpenScreen: () => void;
	/** "Autorizar" do conector e o estado das conexões em andamento (por `loginId`): o fluxo é do controller. */
	onConnectLogin: (item: Extract<ChatItem, { kind: "login" }>) => void;
	connects: Record<string, { busy: boolean; message: string | null }>;
	request: RequestActions;
	botName: string;
	serverUrl: string | null;
	/** Toque longo no balão: abre o menu da mensagem (só abre para fala já gravada; ver `messageMenuFor`). */
	onOpenMenu: (item: ChatItem) => void;
	/** Bot da lista da home pelo id (avatar da linha "N mensagens com X"); `undefined` = bot apagado. */
	botFor: (id: string) => HomeBot | undefined;
	/** Toque na linha de conversa entre bots: abre a conversa deles, somente leitura. */
	onOpenExchange: (item: Extract<ChatItem, { kind: "bot-exchange" }>) => void;
	/** Cor do bot para o balão do usuário (fundo e texto por cima dele). Sem ela, o balão usa o cinza neutro. */
	userBubble?: { background: string; foreground: string };
	/** Cor de destaque (bot ou neutro, conforme Aparência): a letra da alternativa escolhida no questionário respondido. */
	accent?: { background: string; foreground: string };
	/** Bots do usuário: o avatar da menção `@bot` no balão e o do marcador "Enviou mensagem para X". */
	bots?: readonly MentionBotRef[];
	/** Habilidades conhecidas (slugs): `/habilidade` no balão ganha o visual de marcador. */
	skills?: ReadonlySet<string>;
};

/** Balão do usuário, à direita, na cor do bot (como no Grok); sem a cor, o cinza do `Bubble variant="muted"` do web. */
function UserBubble({ text, bots, skills, position, reactions, replyTo, accent, onLongPress }: { text: string; bots?: RowActions["bots"]; skills?: RowActions["skills"]; position: GroupPosition; reactions?: Reaction[]; replyTo?: ReplyQuote; accent?: RowActions["userBubble"]; onLongPress: () => void }) {
	const parts = React.useMemo(() => splitMessageText(text, bots ?? [], skills), [text, bots, skills]);
	return (
		<View className="max-w-[87%] self-end">
			{replyTo ? <ReplyPill quote={replyTo} align="end" spaced={position !== "single" && position !== "first"} /> : null}
			{/* Sem `selectable`: o toque longo abre o menu (a seleção está em "Selecionar texto"). */}
			<Pressable
				onLongPress={onLongPress}
				accessibilityHint="Segure para ver as ações da mensagem"
				style={[accent ? { backgroundColor: accent.background } : undefined, bubbleCorners("right", position)]}
				className={`px-3.5 py-3.5 ${accent ? "" : "bg-muted"}`}
			>
				<Text className="text-base leading-snug" style={accent ? { color: accent.foreground } : undefined}>
					{isPlainMessage(parts) ? <HighlightedText text={text} /> : <MentionText parts={parts} eyeColor={accent?.background} />}
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
		<View className={`${BUBBLE_MAX_WIDTH_CLASS} gap-1.5 self-start`}>
			{replyTo ? <ReplyPill quote={replyTo} align="start" spaced={position !== "single" && position !== "first"} /> : null}
			{segments.map((segment, index) =>
				segment.kind === "table" ? (
					<TableCard key={`table-${index}`} block={segment.block} scheme={scheme} onLongPress={onLongPress} />
				) : (
					<Pressable key={`bubble-${index}`} onLongPress={onLongPress} accessibilityHint="Segure para ver as ações da mensagem" style={[{ backgroundColor: surfaceColors(scheme).bubble }, cornersNextToTable(bubbleCorners("left", position), "left", index > 0, index < segments.length - 1)]} className="px-3.5 py-3.5">
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
			return (
				<MessageHighlight itemId={item.id}>
					<UserBubble text={item.text} bots={actions.bots} skills={actions.skills} position={position} reactions={item.reactions} replyTo={item.replyTo} accent={actions.userBubble} onLongPress={() => actions.onOpenMenu(item)} />
				</MessageHighlight>
			);
		case "assistant":
			return item.text.trim() ? (
				<MessageHighlight itemId={item.id}>
					<BotBubble text={item.text} position={position} reactions={item.reactions} replyTo={item.replyTo} onLongPress={() => actions.onOpenMenu(item)} />
				</MessageHighlight>
			) : null;
		case "task-list":
			return <TaskSummary items={item.items} active={taskCardActive(item.runId, actions.activeRunId, actions.running)} />;
		case "confirm":
			return <ConfirmCard item={item} onDecide={actions.onDecide} />;
		case "questionnaire":
			return <QuestionnaireCard item={item} onAnswer={actions.onAnswer} accent={actions.accent} />;
		case "bot-proposal":
			return <BotProposalCard item={item} onDecide={actions.onResolveProposal} onOpenBot={actions.onOpenBot} />;
		case "bot-profile":
			return <BotProfileCard item={item} onDecide={actions.onResolveProposal} />;
		case "login":
			return loginVariant(item) === "connector" ? (
				<ConnectorCard item={item} botName={actions.botName} serverUrl={actions.serverUrl} connect={actions.connects[item.loginId]} onAuthorize={actions.onConnectLogin} onOpenWeb={actions.onOpenScreen} />
			) : (
				<LoginCard item={item} botName={actions.botName} onResume={actions.onResumeLogin} onSaveLogin={(login, username, password) => actions.request.saveLogin(login, username, password)} onOpenScreen={actions.onOpenScreen} />
			);
		case "secrets":
			return <SecretsCard item={item} onSave={actions.request.saveSecrets} onDecide={actions.onDecide} />;
		case "web-card":
			return <WebCardRow item={item} onOpen={actions.onOpenWeb} onOpenPage={actions.onOpenPage} />;
		case "images":
			return <ImagesRow item={item} onOpen={actions.onOpenImage} />;
		case "marker":
			return item.link ? <BotLinkMarkerRow link={item.link} fallback={item.text} bots={actions.bots} /> : <MarkerRow text={item.text} />;
		case "bot-exchange":
			return <BotExchangeMarker item={item} botFor={actions.botFor} onOpen={actions.onOpenExchange} now={Date.now()} />;
	}
}
