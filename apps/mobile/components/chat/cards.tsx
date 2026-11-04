import { CHAT_CARD_COPY } from "@workspace/ui/lib/chat-card-copy";
import { Pressable, View } from "react-native";
import { ExternalLinkIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ChatCard, ChatCardActions, ChatCardHeader, ChatCardLine } from "@/components/ui/chat-card";
import { Text } from "@/components/ui/text";
import type { ChatItem } from "@/lib/chat-types";

type Confirm = Extract<ChatItem, { kind: "confirm" }>;
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

/**
 * Marcador de uma linha no fio (horário, rotina, conversa compactada, mensagem enviada a outro bot). Respira como no
 * Grok (print de referência do dono): lá o vão visível é de ~29 pt entre um marcador e o seguinte e ~26 pt até o
 * balão; aqui são 10 pt de margem em cada lado, que somados ao gap de 6 da lista dão ~34 e ~20 pt visíveis.
 */
export function MarkerRow({ text }: { text: string }) {
	return (
		<View className="items-center py-2.5">
			<Text variant="caption" className="text-body">
				{text}
			</Text>
		</View>
	);
}
