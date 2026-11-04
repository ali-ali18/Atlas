import { resolveColor, resolveShape } from "@workspace/shared/avatar/identity";
import * as React from "react";
import { Pressable, View } from "react-native";
import { Avatar } from "@/components/ui/avatar";
import { Text } from "@/components/ui/text";
import { botExchangeLabel, exchangePeerId, exchangeStamp } from "@/lib/bot-thread";
import type { ChatItem } from "@/lib/chat-types";
import type { HomeBot } from "@/lib/home-types";

type ExchangeItem = Extract<ChatItem, { kind: "bot-exchange" }>;

const AVATAR = 18;

/** Prefixo antes do avatar ("4 mensagens com ") e o nome do parceiro: o rótulo único fica no `accessibilityLabel`. */
function labelParts(item: ExchangeItem): { lead: string; names: string } {
	const full = botExchangeLabel(item);
	const names = item.partners.map((partner) => partner.name);
	if (names.length === 0) return { lead: full.replace(/outro bot$/, ""), names: "outro bot" };
	const tail = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;
	return { lead: full.slice(0, full.length - tail.length), names: tail };
}

/**
 * Linha fina e centralizada no fio, com data e hora acima: "4 mensagens com [avatar] Grok Bot". É o que sobra da
 * conversa entre dois bots no chat do usuário (o texto não aparece aqui); tocar abre a conversa, somente leitura.
 * Sem o id do parceiro (bot apagado, cache antigo) a linha é só informativa.
 */
export function BotExchangeMarker({ item, botFor, onOpen, now }: { item: ExchangeItem; botFor: (id: string) => HomeBot | undefined; onOpen: (item: ExchangeItem) => void; now: number }) {
	const peerId = exchangePeerId(item);
	const peer = peerId ? botFor(peerId) : undefined;
	const { lead, names } = labelParts(item);
	const stamp = exchangeStamp(item.createdAt, now);
	const content = (
		<View className="flex-row flex-wrap items-center justify-center gap-x-1 px-4 py-1.5">
			<Text variant="caption" className="text-body">
				{lead}
			</Text>
			{peer ? <Avatar color={resolveColor(peer.color, peer.id)} shape={resolveShape(peer.shape, peer.id)} size={AVATAR} animated={false} /> : null}
			<Text variant="caption" className="text-body font-semibold">
				{names}
			</Text>
		</View>
	);
	return (
		<View className="items-center py-1.5">
			{stamp ? (
				<Text variant="caption" className="pb-0.5">
					{stamp}
				</Text>
			) : null}
			{peerId ? (
				<Pressable role="button" accessibilityLabel={`${botExchangeLabel(item)}. Abrir a conversa`} onPress={() => onOpen(item)} className="rounded-full active:bg-muted">
					{content}
				</Pressable>
			) : (
				<View accessibilityLabel={botExchangeLabel(item)}>{content}</View>
			)}
		</View>
	);
}
