import { CHAT_CARD_COPY } from "@workspace/ui/lib/chat-card-copy";
import * as React from "react";
import { Pressable, TextInput, View } from "react-native";
import { ExternalLinkIcon, ListChecksIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ChatCard, ChatCardActions, ChatCardHeader, ChatCardLine } from "@/components/ui/chat-card";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/cn";
import type { ChatItem } from "@/lib/chat-types";
import { buildAnswers, missingRequired, toggleChoice, type AnswerMap } from "@/lib/questionnaire";
import { themeColor } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

type Confirm = Extract<ChatItem, { kind: "confirm" }>;
type Questionnaire = Extract<ChatItem, { kind: "questionnaire" }>;
type WebCard = Extract<ChatItem, { kind: "web-card" }>;

const CONFIRM_BADGE: Record<Confirm["status"], { tone: "pending" | "success" | "muted" | "danger"; label: string }> = {
	pending: { tone: "pending", label: CHAT_CARD_COPY.needsYou },
	approved: { tone: "success", label: "Confirmado" },
	rejected: { tone: "muted", label: CHAT_CARD_COPY.dismissed },
	failed: { tone: "danger", label: "Não deu certo" },
};

/** Cartão de aprovação: confirmar ou dispensar. O clique volta ao servidor como o do web (`decisionConfirmId`). */
export function ConfirmCard({ item, onDecide }: { item: Confirm; onDecide: (item: Confirm, approve: boolean) => void }) {
	const pending = item.status === "pending";
	return (
		<ChatCard className="max-w-[min(68ch,100%)] self-start">
			<ChatCardHeader title={item.title} badge={CONFIRM_BADGE[item.status]} />
			{item.description ? (
				<Text variant="muted" className="text-control">
					{item.description}
				</Text>
			) : null}
			{pending ? (
				<ChatCardActions>
					<Button size="sm" accessibilityLabel={item.confirmLabel ?? "Confirmar"} onPress={() => onDecide(item, true)}>
						<Text>{item.confirmLabel ?? "Confirmar"}</Text>
					</Button>
					<Button size="sm" variant="secondary" accessibilityLabel={item.cancelLabel ?? CHAT_CARD_COPY.dismiss} onPress={() => onDecide(item, false)}>
						<Text>{item.cancelLabel ?? CHAT_CARD_COPY.dismiss}</Text>
					</Button>
				</ChatCardActions>
			) : null}
		</ChatCard>
	);
}

/** Pergunta do bot: escolhas (uma ou várias) e texto livre; "Responder" envia o mapa de respostas do web. */
export function QuestionnaireCard({ item, onAnswer }: { item: Questionnaire; onAnswer: (item: Questionnaire, answers: AnswerMap) => void }) {
	const scheme = useAppColorScheme();
	const [selected, setSelected] = React.useState<Record<string, string[]>>({});
	const [free, setFree] = React.useState<Record<string, string>>({});
	const [tried, setTried] = React.useState(false);
	const pending = item.status === "pending";
	const answers = buildAnswers(item.items, selected, free);
	const missing = missingRequired(item.items, answers);
	const submit = () => {
		if (missing.length > 0) {
			setTried(true);
			return;
		}
		onAnswer(item, answers);
	};
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
	return (
		<ChatCard className="max-w-[min(68ch,100%)] self-start">
			<ChatCardHeader title={item.title} badge={{ tone: "pending", label: CHAT_CARD_COPY.needsYou }} />
			{item.description ? (
				<Text variant="muted" className="text-control">
					{item.description}
				</Text>
			) : null}
			{item.items.map((entry) => {
				const invalid = tried && missing.includes(entry.name);
				return (
					<View key={entry.name} className="gap-2">
						<Text className="text-control font-medium">{entry.prompt}</Text>
						{entry.description ? (
							<Text variant="caption" className="text-body">
								{entry.description}
							</Text>
						) : null}
						{(entry.choices ?? []).map((choice) => {
							const on = (selected[entry.name] ?? []).includes(choice.value);
							return (
								<Pressable
									key={choice.value}
									role={entry.multiple ? "checkbox" : "radio"}
									accessibilityState={{ checked: on }}
									onPress={() => setSelected((previous) => ({ ...previous, [entry.name]: toggleChoice(previous[entry.name] ?? [], choice.value, entry.multiple === true) }))}
									className={cn("min-h-11 justify-center rounded-xl px-3 py-2 active:opacity-80", on ? "bg-primary/15" : "bg-background/40", invalid && "border border-destructive")}
								>
									<Text className="text-control">{choice.label ?? choice.value}</Text>
									{choice.description ? (
										<Text variant="caption" className="text-body">
											{choice.description}
										</Text>
									) : null}
								</Pressable>
							);
						})}
						{entry.input ? (
							<TextInput
								accessibilityLabel={entry.input.label}
								placeholder={entry.input.placeholder ?? entry.input.label}
								placeholderTextColor={themeColor(scheme, "muted-foreground")}
								value={free[entry.name] ?? ""}
								onChangeText={(text) => setFree((previous) => ({ ...previous, [entry.name]: text }))}
								multiline
								className={cn("min-h-11 rounded-xl bg-background/40 px-3 py-2 text-control text-foreground", invalid && "border border-destructive")}
							/>
						) : null}
						{invalid ? <Text className="text-body text-destructive">Responda esta pergunta.</Text> : null}
					</View>
				);
			})}
			<ChatCardActions>
				<Button size="sm" onPress={submit}>
					<Text>Responder</Text>
				</Button>
			</ChatCardActions>
		</ChatCard>
	);
}

/** Cartão sem tela nativa ainda (gráfico, painel, arquivo, rotina…): título e "Abrir no navegador". */
export function WebCardRow({ item, onOpen }: { item: WebCard; onOpen: (item: WebCard) => void }) {
	return (
		<Pressable role="button" accessibilityLabel={`${item.title}. Abrir no navegador`} onPress={() => onOpen(item)} className="self-start active:opacity-80">
			<ChatCard variant="activity" className="min-h-11 max-w-[min(68ch,100%)] justify-center">
				<ChatCardLine leading={<ExternalLinkIcon />} trailing={<Text className="text-body font-medium text-info">Abrir no navegador</Text>}>
					<Text numberOfLines={1} className="text-sm font-medium">
						{item.title}
					</Text>
				</ChatCardLine>
			</ChatCard>
		</Pressable>
	);
}

/** Marcador de uma linha no fio (conversa compactada, mensagem enviada a outro bot). */
export function MarkerRow({ text }: { text: string }) {
	return (
		<View className="items-center py-1">
			<Text variant="caption" className="text-body">
				{text}
			</Text>
		</View>
	);
}
