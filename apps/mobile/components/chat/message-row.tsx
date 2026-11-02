import * as React from "react";
import { View } from "react-native";
import Animated, { FadeIn, useReducedMotion } from "react-native-reanimated";
import { Text } from "@/components/ui/text";
import { taskCardActive } from "@/lib/chat-thread";
import type { ChatItem } from "@/lib/chat-types";
import type { AnswerMap } from "@/lib/questionnaire";
import { ConfirmCard, MarkerRow, QuestionnaireCard, WebCardRow } from "./cards";
import { MarkdownText } from "./markdown-text";
import { TaskSummary } from "./task-dock";

export type RowActions = {
	onDecide: (item: Extract<ChatItem, { kind: "confirm" }>, approve: boolean) => void;
	onAnswer: (item: Extract<ChatItem, { kind: "questionnaire" }>, answers: AnswerMap) => void;
	/** Run ativo (id): o cartão de tarefas desse run mostra a tarefa em execução. */
	activeRunId: string | null;
	/** Há um run em andamento (o cartão só é "ativo" durante um run). */
	running: boolean;
	onOpenWeb: (item: Extract<ChatItem, { kind: "web-card" }>) => void;
};

/** Balão do usuário: o do web (`Bubble variant="muted"`, à direita). */
function UserBubble({ text }: { text: string }) {
	return (
		<View className="max-w-[82%] self-end rounded-3xl bg-muted px-4 py-3">
			<Text selectable className="text-control leading-6">
				{text}
			</Text>
		</View>
	);
}

/** Balão do bot: escuro, arredondado, com markdown; ocupa quase toda a largura como na referência. */
function BotBubble({ text }: { text: string }) {
	return (
		<View className="max-w-[94%] self-start rounded-3xl bg-muted px-4 py-3.5">
			<MarkdownText source={text} />
		</View>
	);
}

/**
 * Mensagem que chegou com a tela aberta entra com um fade curto, como no web; as que já estavam (cache, histórico)
 * aparecem direto. Só opacidade: a lista é invertida, e deslocar na vertical sairia ao contrário.
 */
export const MessageRow = React.memo(function MessageRow({ item, actions, animate = false }: { item: ChatItem; actions: RowActions; animate?: boolean }) {
	const reduced = useReducedMotion();
	// O invólucro existe sempre (só o `entering` muda): trocar de estrutura remontaria o cartão e perderia o estado
	// dele (respostas do questionário, por exemplo). `entering` só vale na montagem.
	return (
		<Animated.View entering={animate && !reduced ? FadeIn.duration(220) : undefined}>
			<RowContent item={item} actions={actions} />
		</Animated.View>
	);
});

/** Escolhe o desenho pelo tipo, como o `message-row` do web. */
function RowContent({ item, actions }: { item: ChatItem; actions: RowActions }) {
	switch (item.kind) {
		case "user":
			return <UserBubble text={item.text} />;
		case "assistant":
			return item.text.trim() ? <BotBubble text={item.text} /> : null;
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
