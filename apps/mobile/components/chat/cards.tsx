import { resolveColor, resolveShape } from "@workspace/shared/avatar/identity";
import { CHAT_CARD_COPY } from "@workspace/ui/lib/chat-card-copy";
import { Pressable, View } from "react-native";
import { ExternalLinkIcon, LibraryIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ChatCard, ChatCardActions, ChatCardHeader, ChatCardLine } from "@/components/ui/chat-card";
import { Avatar } from "@/components/ui/avatar";
import { Text } from "@/components/ui/text";
import type { ChatItem } from "@/lib/chat-types";
import { FileCardRow } from "./file-card";
import { viewerTargetForCard } from "@/lib/viewer-target";
import { pageCardSummary } from "@/lib/web-card";
import { findLinkedBot, type MentionBotRef } from "@/lib/message-text";

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

/**
 * Cartão sem tela nativa ainda (gráfico, rotina…): título e "Abrir no navegador". Painel com `pageId` é o
 * resumo (título, "Painel · 2 fontes") e abre a tela nativa ("Abrir painel"); sem `pageId` (gravado antes) vai ao navegador.
 */
export function WebCardRow({ item, onOpen, onOpenPage }: { item: WebCard; onOpen: (item: WebCard) => void; onOpenPage?: (item: WebCard) => void }) {
	if (item.card === "file") return <FileCardRow item={item} onOpen={onOpen} onOpenPage={onOpenPage} />;
	const target = viewerTargetForCard(item);
	const native = onOpenPage && target ? onOpenPage : null;
	const nativeLabel = "Abrir painel";
	return (
		<Pressable
			role="button"
			accessibilityLabel={native ? `${item.title}. ${nativeLabel}` : `${item.title}. Abrir no navegador`}
			onPress={() => (native ? native(item) : onOpen(item))}
			className="self-start active:opacity-80"
		>
			<ChatCard variant="activity" className="min-h-11 max-w-[min(68ch,100%)] justify-center">
				<ChatCardLine leading={native ? <LibraryIcon size={16} /> : <ExternalLinkIcon />} trailing={<Text className="text-body font-medium text-info">{native ? nativeLabel : "Abrir no navegador"}</Text>}>
					<Text numberOfLines={1} className="text-sm font-medium">
						{item.title}
					</Text>
					{native && target ? (
						<Text variant="caption" numberOfLines={1}>
							{pageCardSummary(item)}
						</Text>
					) : null}
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

/**
 * "Enviou mensagem para [avatar] Bobinho: prévia", como o `BotLinkMarker` do web: centralizado no fio (igual aos outros
 * marcadores), com o avatar do bot antes do nome. A prévia vem logo depois e o texto todo quebra centralizado. Sem achar
 * o bot (apagado), fica só o nome, sem avatar.
 */
export function BotLinkMarkerRow({ link, fallback, bots }: { link: { botId: string; botName: string; title: string }; fallback: string; bots?: readonly MentionBotRef[] }) {
	const bot = bots ? findLinkedBot(bots, link) : undefined;
	if (!link.botName.trim()) return <MarkerRow text={fallback} />;
	const title = link.title.trim();
	// Linha flexível (e não `Text` aninhado): o avatar fica no centro vertical das palavras em qualquer plataforma (num
	// `Text` o View inline senta na linha de base e sobe/desce conforme a fonte). Quebrando, cada linha fica centralizada.
	return (
		<View className="flex-row flex-wrap items-center justify-center gap-x-1.5 px-4 py-2.5">
			<Text variant="caption" className="text-body">
				Enviou mensagem para
			</Text>
			{bot ? <Avatar color={resolveColor(bot.color, bot.id)} shape={resolveShape(bot.shape, bot.id)} size={16} animated={false} /> : null}
			<Text variant="caption" className="text-body">
				<Text className="text-body font-medium text-foreground">{link.botName.trim()}</Text>
				{title ? ":" : ""}
			</Text>
			{title ? (
				<Text variant="caption" numberOfLines={2} className="text-center text-body">
					{title}
				</Text>
			) : null}
		</View>
	);
}
