import * as React from "react";
import { Pressable, TextInput, View } from "react-native";
import { CHAT_CARD_COPY } from "@workspace/ui/lib/chat-card-copy";
import { Text } from "@/components/ui/text";
import { chatChrome } from "@/lib/chat-surface";
import type { ChatItem } from "@/lib/chat-types";
import { choiceLetter, EMPTY_QUESTIONNAIRE_NOTICE, initialStepState, reviewFooter, reviewQuestions, reviewStep, stepFooter, stepReduce, stepSubtitle, type AnswerMap, type StepAction } from "@/lib/questionnaire";
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

type Accent = { background: string; foreground: string };

/**
 * Letra numa caixinha + rótulo: a mesma peça da etapa pendente. `readOnly` (cartão respondido) não é pressionável, fica
 * esmaecida e a escolhida (`on`) enche a caixinha com a cor de destaque (`accent`), com o rótulo um pouco mais forte.
 */
function ChoiceRow({ letter, label, description, on, readOnly, borderColor, accent, onPress, multiple }: { letter: string; label: string; description?: string; on: boolean; readOnly?: boolean; borderColor: string; accent?: Accent; onPress?: () => void; multiple?: boolean }) {
	const filled = on && readOnly && accent;
	const body = (
		<>
			<View className={on && !(readOnly && accent) ? "size-7 items-center justify-center rounded-lg bg-primary" : filled ? "size-7 items-center justify-center rounded-lg" : "size-7 items-center justify-center rounded-lg border"} style={filled ? { backgroundColor: accent.background } : on ? undefined : { borderColor }}>
				<Text className={on && !filled ? "text-body font-semibold text-primary-foreground" : "text-body font-semibold text-muted-foreground"} style={filled ? { color: accent.foreground } : undefined}>
					{letter}
				</Text>
			</View>
			<View className="min-w-0 flex-1">
				<Text className={readOnly ? (on ? "text-control text-foreground/80" : "text-control text-muted-foreground/60") : "text-control"}>{label}</Text>
				{description ? (
					<Text variant="caption" className={readOnly ? "text-body opacity-60" : "text-body"}>
						{description}
					</Text>
				) : null}
			</View>
		</>
	);
	const box = !readOnly && on ? "min-h-12 flex-row items-center gap-3 rounded-2xl bg-foreground/[0.06] px-2 py-2" : "min-h-12 flex-row items-center gap-3 rounded-2xl px-2 py-2";
	if (readOnly) {
		return (
			<View role="listitem" accessibilityLabel={`${label}${on ? ", escolhida" : ""}`} className={box}>
				{body}
			</View>
		);
	}
	return (
		<Pressable role={multiple ? "checkbox" : "radio"} accessibilityState={{ checked: on }} onPress={onPress} className={`${box} active:opacity-80`}>
			{body}
		</Pressable>
	);
}

/**
 * Questionário que não está mais pendente (respondido ou dispensado): o MESMO formato de etapas do pendente (casca,
 * pergunta grande, alternativas com letra, pontos), só leitura e esmaecido, como no Grok. Voltar/Avançar passam entre as
 * perguntas (sem enviar nada); a escolhida leva a cor de destaque. Dispensado não marca nada e troca os botões por
 * "Dispensado". Ao vivo e reaberto são iguais: tudo vem do `item`.
 */
function ReviewQuestionnaire({ item, accent }: { item: Questionnaire; accent?: Accent }) {
	const chrome = chatChrome(useAppColorScheme());
	const [index, setIndex] = React.useState(0);
	const dismissed = item.status === "dismissed";
	const questions = reviewQuestions(item.items, item.answers, dismissed);
	const footer = reviewFooter(questions.length, index, dismissed);
	const question = questions[footer.index];
	const entry = item.items[footer.index];
	const subtitle = entry ? stepSubtitle(entry) : null;
	return (
		<RequestShell
			groupLabel={item.title}
			footer={
				<View className="flex-row items-center justify-between gap-2">
					<Dots count={footer.dots} index={footer.index} />
					{dismissed ? (
						<Text variant="caption" className="text-caption">
							{CHAT_CARD_COPY.dismissed}
						</Text>
					) : footer.dots > 1 ? (
						<View className="flex-row items-center gap-2">
							<RequestButton label="Voltar" variant="secondary" disabled={!footer.back} onPress={() => setIndex(reviewStep(questions.length, footer.index, -1))} />
							<RequestButton label="Avançar" variant="secondary" disabled={!footer.next} onPress={() => setIndex(reviewStep(questions.length, footer.index, 1))} />
						</View>
					) : null}
				</View>
			}
		>
			{question ? (
				<>
					<View className="gap-1">
						<Text className="text-base font-semibold text-muted-foreground">{question.prompt}</Text>
						{subtitle ? (
							<Text variant="muted" className="text-body opacity-60">
								{subtitle}
							</Text>
						) : null}
					</View>
					<View role="list" className="gap-2">
						{question.options.map((option) => (
							<ChoiceRow key={option.value} letter={option.letter} label={option.label} description={option.description} on={option.selected} readOnly borderColor={chrome.edge} accent={accent} />
						))}
						{question.text ? <Text className="px-2 text-control text-foreground/80">{question.text}</Text> : null}
						{!dismissed && !question.answered ? (
							<Text variant="muted" className="px-2 text-body">
								Sem resposta
							</Text>
						) : null}
					</View>
				</>
			) : (
				<Text variant="muted" className="text-body">
					{dismissed ? "Perguntas dispensadas." : "Respostas enviadas."}
				</Text>
			)}
		</RequestShell>
	);
}

/**
 * Pergunta do bot, uma por vez no cartão (como o do web): título em negrito, opções com uma letra em caixa (A, B, C…),
 * pontos do passo à esquerda e Voltar · Pular · Avançar à direita; na última, "Enviar". O envio é um só, no fim, com o
 * mesmo mapa de respostas do web (`POST /v1/questionnaire/submit`). A lógica dos passos é pura (`lib/questionnaire.ts`).
 */
export function QuestionnaireCard({ item, onAnswer, accent }: { item: Questionnaire; onAnswer: (item: Questionnaire, answers: AnswerMap) => void; accent?: Accent }) {
	const scheme = useAppColorScheme();
	const chrome = chatChrome(scheme);
	// O passo e as respostas ficam na memória por id (fora da linha): rolar a lista e voltar não perde nada.
	const [state, setState] = React.useState(() => getQuestionnaireDraft(item.questionnaireId) ?? initialStepState());
	const [notice, setNotice] = React.useState<string | null>(null);
	const pending = item.status === "pending";
	if (!pending || item.items.length === 0) return <ReviewQuestionnaire item={item} accent={accent} />;
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
					return <ChoiceRow key={choice.value} letter={choiceLetter(position)} label={choice.label ?? choice.value} description={choice.description} on={on} multiple={entry.multiple === true} borderColor={chrome.edge} onPress={() => dispatch({ type: "toggle", name: entry.name, value: choice.value, multiple: entry.multiple === true })} />;
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
