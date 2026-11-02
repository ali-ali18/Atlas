import { type BotLanguage, formatLimitDuration, formatUsd, systemMessages } from "@workspace/shared";
import { View } from "react-native";
import { ChatCard, ChatCardDetails, ChatCardHeader } from "@/components/ui/chat-card";
import { Text } from "@/components/ui/text";

const LANGUAGE: BotLanguage = "pt-BR";

/** Prova de que o `@workspace/shared` roda no Metro: funções puras e tipo reais, renderizados na tela. */
export function SharedProof() {
	return (
		<ChatCard>
			<ChatCardHeader title="Núcleo compartilhado" badge={{ tone: "success", label: "@workspace/shared" }} />
			<View className="flex-row justify-between">
				<Text variant="muted">Limite de 5 min</Text>
				<Text variant="muted">{formatLimitDuration(5 * 60_000)}</Text>
			</View>
			<View className="flex-row justify-between">
				<Text variant="muted">Valor em dólar</Text>
				<Text variant="muted">US$ {formatUsd(LANGUAGE, 1.5)}</Text>
			</View>
			<ChatCardDetails>
				<Text variant="caption">{systemMessages(LANGUAGE).noProgress}</Text>
			</ChatCardDetails>
		</ChatCard>
	);
}
