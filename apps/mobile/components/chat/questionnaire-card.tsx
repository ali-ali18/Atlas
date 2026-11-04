import * as React from "react";
import { Pressable, TextInput, View } from "react-native";
import { ListChecksIcon } from "@/components/icons";
import { ChatCard, ChatCardLine } from "@/components/ui/chat-card";
import { Text } from "@/components/ui/text";
import { chatChrome } from "@/lib/chat-surface";
import type { ChatItem } from "@/lib/chat-types";
import { choiceLetter, initialStepState, stepFooter, stepReduce, stepSubtitle, type AnswerMap, type StepAction } from "@/lib/questionnaire";
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
 * Pergunta do bot, uma por vez no cartão (como o do web): título em negrito, opções com uma letra em caixa (A, B, C…),
 * pontos do passo à esquerda e Voltar · Pular · Avançar à direita; na última, "Enviar". O envio é um só, no fim, com o
 * mesmo mapa de respostas do web (`POST /v1/questionnaire/submit`). A lógica dos passos é pura (`lib/questionnaire.ts`).
 */
export function QuestionnaireCard({ item, onAnswer }: { item: Questionnaire; onAnswer: (item: Questionnaire, answers: AnswerMap) => void }) {
	const scheme = useAppColorScheme();
	const chrome = chatChrome(scheme);
	const [state, setState] = React.useState(initialStepState);
	const pending = item.status === "pending";
	if (!pending || item.items.length === 0) {
		return (
			<ChatCard variant="activity" className="self-start">
				<ChatCardLine leading={<ListChecksIcon />}>
					<Text numberOfLines={1} className="text-sm font-medium">
						{item.title}
					</Text>
				</ChatCardLine>
			</ChatCard>
		);
	}
	const entry = item.items[Math.min(state.index, item.items.length - 1)]!;
	const footer = stepFooter(item.items, state);
	const subtitle = stepSubtitle(entry);
	const dispatch = (action: StepAction) => {
		const result = stepReduce(item.items, state, action);
		setState(result.state);
		if (result.submit) onAnswer(item, result.submit);
	};
	const picked = state.selected[entry.name] ?? [];

	return (
		<RequestShell
			accessibilityLabel={item.title}
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
							style={{ backgroundColor: chrome.control }}
							className="min-h-12 flex-row items-center gap-3 rounded-2xl px-3 py-2 active:opacity-80"
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
		</RequestShell>
	);
}
