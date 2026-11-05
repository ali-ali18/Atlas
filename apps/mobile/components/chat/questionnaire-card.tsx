import * as React from "react";
import { Pressable, TextInput, View } from "react-native";
import { CHAT_CARD_COPY } from "@workspace/ui/lib/chat-card-copy";
import { CheckIcon, CloseIcon, ListChecksIcon } from "@/components/icons";
import { ChatCard, ChatCardDetails, ChatCardHeader } from "@/components/ui/chat-card";
import { Text } from "@/components/ui/text";
import { chatChrome } from "@/lib/chat-surface";
import type { ChatItem } from "@/lib/chat-types";
import { answeredSummary, choiceLetter, EMPTY_QUESTIONNAIRE_NOTICE, initialStepState, stepFooter, stepReduce, stepSubtitle, type AnswerMap, type StepAction } from "@/lib/questionnaire";
import { clearQuestionnaireDraft, getQuestionnaireDraft, setQuestionnaireDraft } from "@/lib/request-memory";
import { themeColor } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";
import { RequestButton, RequestShell, RequestTextButton } from "./request-shell";

type Questionnaire = Extract<ChatItem, { kind: "questionnaire" }>;

function Dots({ count, index }: { count: number; index: number }) {
	if (count < 2) return <View />;
	return (
		<View className="flex-row items-center gap-1.5" accessibilityLabel={`Pergunta ${index + 1} de ${count}`}>
			{Array.from({ length: count }, (_unused, position) => (
				<View key={position} className={position === index ? "size-1.5 rounded-full bg-foreground" : "size-1.5 rounded-full bg-muted-foreground/40"} />
			))}
		</View>
	);
}

/**
 * Questionário que não está mais pendente (respondido, dispensado ou sem perguntas): cartão `card` com ícone, título e
 * selo de estado, como no web. Respondido traz as respostas recolhidas ("Ver detalhes"): pergunta e o rótulo escolhido.
 * Vive em `card` (largura cheia) de propósito: na variante `activity` o título `flex-1` encolhia a pílula a só o ícone.
 */
function ResolvedQuestionnaire({ item }: { item: Questionnaire }) {
	const dismissed = item.status === "dismissed";
	const lines = answeredSummary(item.items, item.answers);
	const header = (
		<ChatCardHeader
			leading={dismissed ? <CloseIcon /> : item.status === "submitted" ? <CheckIcon size={16} tone="success" /> : <ListChecksIcon />}
			title={item.title || "Perguntas do bot"}
			badge={dismissed ? { tone: "muted", label: CHAT_CARD_COPY.dismissed } : item.status === "submitted" ? { tone: "success", label: "Respondido" } : undefined}
		/>
	);
	return (
		<ChatCard className="max-w-[min(68ch,100%)] self-start">
			{header}
			{item.status === "submitted" ? (
				<ChatCardDetails>
					{lines.length === 0 ? (
						<Text variant="muted" className="text-body">
							Respostas enviadas.
						</Text>
					) : (
						lines.map((line) => (
							<View key={line.name} className="gap-0.5">
								<Text className="text-body font-medium">{line.prompt}</Text>
								<Text variant="muted" className="text-body">
									{line.labels.join(", ")}
								</Text>
							</View>
						))
					)}
				</ChatCardDetails>
			) : null}
		</ChatCard>
	);
}

/**
 * Pergunta do bot, uma por vez no cartão (como o do web): título em negrito, opções com uma letra em caixa (A, B, C…),
 * pontos do passo à esquerda e Voltar · Pular · Avançar à direita; na última, "Enviar". O envio é um só, no fim, com o
 * mesmo mapa de respostas do web (`POST /v1/questionnaire/submit`). A lógica dos passos é pura (`lib/questionnaire.ts`).
 */
export function QuestionnaireCard({ item, onAnswer }: { item: Questionnaire; onAnswer: (item: Questionnaire, answers: AnswerMap) => void }) {
	const scheme = useAppColorScheme();
	const chrome = chatChrome(scheme);
	// O passo e as respostas ficam na memória por id (fora da linha): rolar a lista e voltar não perde nada.
	const [state, setState] = React.useState(() => getQuestionnaireDraft(item.questionnaireId) ?? initialStepState());
	const [notice, setNotice] = React.useState<string | null>(null);
	const pending = item.status === "pending";
	if (!pending || item.items.length === 0) return <ResolvedQuestionnaire item={item} />;
	const entry = item.items[Math.min(state.index, item.items.length - 1)]!;
	const footer = stepFooter(item.items, state);
	const subtitle = stepSubtitle(entry);
	const dispatch = (action: StepAction) => {
		const result = stepReduce(item.items, state, action);
		setState(result.state);
		setNotice(result.empty ? EMPTY_QUESTIONNAIRE_NOTICE : null);
		if (result.submit) {
			clearQuestionnaireDraft(item.questionnaireId);
			onAnswer(item, result.submit);
		} else setQuestionnaireDraft(item.questionnaireId, result.state);
	};
	const picked = state.selected[entry.name] ?? [];

	return (
		<RequestShell
			groupLabel={item.title}
			footer={
				<View className="flex-row items-center justify-between gap-2">
					<Dots count={footer.dots} index={footer.index} />
					<View className="flex-row items-center">
						{footer.back ? <RequestTextButton label="Voltar" onPress={() => dispatch({ type: "back" })} /> : null}
						{footer.skip ? <RequestTextButton label="Pular" onPress={() => dispatch({ type: "skip" })} /> : null}
						<RequestButton label={footer.primary === "send" ? "Enviar" : "Avançar"} disabled={!footer.primaryEnabled} onPress={() => dispatch({ type: "next" })} />
					</View>
				</View>
			}
		>
			<View className="gap-1">
				<Text className="text-base font-semibold">{entry.prompt}</Text>
				{subtitle ? (
					<Text variant="muted" className="text-body">
						{subtitle}
					</Text>
				) : null}
			</View>
			<View className="gap-2">
				{(entry.choices ?? []).map((choice, position) => {
					const on = picked.includes(choice.value);
					return (
						<Pressable
							key={choice.value}
							role={entry.multiple ? "checkbox" : "radio"}
							accessibilityState={{ checked: on }}
							onPress={() => dispatch({ type: "toggle", name: entry.name, value: choice.value, multiple: entry.multiple === true })}
							className={on ? "min-h-12 flex-row items-center gap-3 rounded-2xl bg-foreground/[0.06] px-2 py-2 active:opacity-80" : "min-h-12 flex-row items-center gap-3 rounded-2xl px-2 py-2 active:opacity-80"}
						>
							<View className={on ? "size-7 items-center justify-center rounded-lg bg-primary" : "size-7 items-center justify-center rounded-lg border"} style={on ? undefined : { borderColor: chrome.edge }}>
								<Text className={on ? "text-body font-semibold text-primary-foreground" : "text-body font-semibold text-muted-foreground"}>{choiceLetter(position)}</Text>
							</View>
							<View className="min-w-0 flex-1">
								<Text className="text-control">{choice.label ?? choice.value}</Text>
								{choice.description ? (
									<Text variant="caption" className="text-body">
										{choice.description}
									</Text>
								) : null}
							</View>
						</Pressable>
					);
				})}
				{entry.input ? (
					<TextInput
						accessibilityLabel={entry.input.label}
						placeholder={entry.input.placeholder ?? entry.input.label}
						placeholderTextColor={themeColor(scheme, "muted-foreground")}
						value={state.free[entry.name] ?? ""}
						onChangeText={(text) => dispatch({ type: "free", name: entry.name, text })}
						multiline
						style={{ backgroundColor: chrome.control }}
						className="min-h-12 rounded-2xl px-4 py-3 text-control text-foreground"
					/>
				) : null}
			</View>
			{notice ? (
				<Text variant="error" className="text-body" role="alert">
					{notice}
				</Text>
			) : null}
		</RequestShell>
	);
}
