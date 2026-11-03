// Cartões de proposta com gate humano, na tela do app: "Criar agente" (o bot propõe um agente novo) e "Atualizar perfil"
// (o bot propõe mudar o próprio perfil, no onboarding). Mesma ideia e mesmos textos do web (bot-proposal-card.tsx e
// bot-profile-confirm-card.tsx); a casca é o `ChatCard` do app. Nada acontece antes do toque: quem decide é a pessoa.
import { CHAT_CARD_COPY } from "@workspace/ui/lib/chat-card-copy";
import * as React from "react";
import { View } from "react-native";
import { UserCogIcon, UserPlusIcon } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ChatCard, ChatCardActions, ChatCardDetails, ChatCardError, ChatCardHeader, type ChatCardTone } from "@/components/ui/chat-card";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { type BotProfileItem, type BotProposalItem, botProfileTitle, botProposalTitle, profileRows, proposalModelLabel, skillLabel, summarizeTask } from "@/lib/bot-cards";
import type { ProposalStatus } from "@/lib/chat-types";

type Decision = "approved" | "rejected";

const BADGE: Record<ProposalStatus, { tone: ChatCardTone; label: string }> = {
	pending: { tone: "pending", label: CHAT_CARD_COPY.needsYou },
	approved: { tone: "success", label: "Criado" },
	rejected: { tone: "muted", label: CHAT_CARD_COPY.dismissed },
};

/** O que a proposta de agente mostra por dentro: avatar, nome, modelo, papel, habilidades e a primeira tarefa. */
function ProposalBody({ item }: { item: BotProposalItem }) {
	// O app ainda não tem catálogo de modelos: sem nome de exibição conhecido, a linha do modelo não aparece.
	const modelLabel = proposalModelLabel(item.model);
	return (
		<View className="min-w-0 gap-3 rounded-xl bg-background/70 p-3" accessibilityLabel={`Agente ${item.name}`}>
			<View className="min-w-0 flex-row items-center gap-3">
				<Avatar color={item.color} shape={item.shape} size={48} animated={false} />
				<View className="min-w-0 flex-1 gap-0.5">
					<Text numberOfLines={1} className="text-base font-medium">
						{item.name}
					</Text>
					{modelLabel ? <Text variant="caption">{modelLabel}</Text> : null}
				</View>
			</View>
			<Text variant="muted" className="text-control">
				{item.description}
			</Text>
			{item.skills.length > 0 ? (
				<View className="min-w-0 flex-row flex-wrap items-center gap-1.5">
					<Text variant="caption">Habilidades</Text>
					{item.skills.map((skill) => (
						<View key={skill} className="rounded-full bg-foreground/[0.06] px-2 py-0.5">
							<Text className="text-caption font-medium">{skillLabel(skill)}</Text>
						</View>
					))}
				</View>
			) : null}
			{item.firstTask ? (
				<Text variant="caption" numberOfLines={3}>
					Primeira tarefa: {summarizeTask(item.firstTask)}
				</Text>
			) : null}
		</View>
	);
}

/**
 * "Criar agente" cria de verdade (uma vez só: o servidor devolve o mesmo resultado se o toque se repetir) e "Agora não"
 * dispensa. Decidido, ficam o selo e os detalhes recolhidos; criado, "Abrir conversa" leva ao chat do agente novo.
 */
export function BotProposalCard({ item, onDecide, onOpenBot }: { item: BotProposalItem; onDecide: (item: BotProposalItem, decision: Decision) => void; onOpenBot: (botId: string) => void }) {
	const pending = item.status === "pending";
	const applying = item.applying === true;
	const blocked = applying || item.locked === true;
	return (
		<ChatCard className="max-w-[min(68ch,100%)] self-start">
			<ChatCardHeader leading={<UserPlusIcon />} title={botProposalTitle(item)} badge={BADGE[item.status]} />
			{pending ? (
				<ProposalBody item={item} />
			) : (
				<ChatCardDetails label="Ver o agente">
					<ProposalBody item={item} />
				</ChatCardDetails>
			)}
			{item.error ? <ChatCardError>{item.error}</ChatCardError> : null}
			{pending ? (
				<ChatCardActions>
					<Button size="sm" disabled={blocked} accessibilityLabel={applying ? "Criando o agente" : "Criar agente"} onPress={() => onDecide(item, "approved")}>
						{applying ? <Spinner tone="primary-foreground" label="Criando" /> : null}
						<Text>{applying ? "Criando…" : "Criar agente"}</Text>
					</Button>
					<Button size="sm" variant="secondary" disabled={blocked} accessibilityLabel={CHAT_CARD_COPY.dismiss} onPress={() => onDecide(item, "rejected")}>
						<Text>{CHAT_CARD_COPY.dismiss}</Text>
					</Button>
				</ChatCardActions>
			) : item.status === "approved" && item.botId ? (
				<ChatCardActions>
					<Button size="sm" variant="secondary" accessibilityLabel={`Abrir a conversa com ${item.name}`} onPress={() => onOpenBot(item.botId!)}>
						<Text>Abrir conversa</Text>
					</Button>
				</ChatCardActions>
			) : null}
		</ChatCard>
	);
}

const PROFILE_BADGE: Record<ProposalStatus, { tone: ChatCardTone; label: string }> = {
	pending: { tone: "pending", label: CHAT_CARD_COPY.needsYou },
	approved: { tone: "success", label: "Aplicado" },
	rejected: { tone: "muted", label: CHAT_CARD_COPY.dismissed },
};

function ProfileRows({ item }: { item: BotProfileItem }) {
	const rows = profileRows(item);
	return (
		<View className="min-w-0 overflow-hidden rounded-xl bg-background/70">
			{rows.map((row, index) => (
				<View key={row.field} className={index > 0 ? "min-w-0 gap-1 border-t border-border/60 px-3 py-3" : "min-w-0 gap-1 px-3 py-3"}>
					<Text variant="caption" className="font-medium">
						{row.label}
					</Text>
					<Text variant="muted" numberOfLines={2} className={row.before === "—" ? "text-control" : "text-control line-through"}>
						{row.before}
					</Text>
					<Text className="text-control font-medium">{row.after}</Text>
				</View>
			))}
		</View>
	);
}

/** "Aplicar" muda o perfil do bot como proposto; "Agora não" descarta sem mudar nada. */
export function BotProfileCard({ item, onDecide }: { item: BotProfileItem; onDecide: (item: BotProfileItem, decision: Decision) => void }) {
	const pending = item.status === "pending";
	const applying = item.applying === true;
	const blocked = applying || item.locked === true;
	return (
		<ChatCard className="max-w-[min(68ch,100%)] self-start">
			<ChatCardHeader leading={<UserCogIcon />} title={botProfileTitle(item)} badge={PROFILE_BADGE[item.status]} />
			{pending ? (
				<ProfileRows item={item} />
			) : (
				<ChatCardDetails label="Ver as mudanças">
					<ProfileRows item={item} />
				</ChatCardDetails>
			)}
			{item.error ? <ChatCardError>{item.error}</ChatCardError> : null}
			{pending ? (
				<ChatCardActions>
					<Button size="sm" disabled={blocked} accessibilityLabel={applying ? "Aplicando" : "Aplicar"} onPress={() => onDecide(item, "approved")}>
						{applying ? <Spinner tone="primary-foreground" label="Aplicando" /> : null}
						<Text>{applying ? "Aplicando…" : "Aplicar"}</Text>
					</Button>
					<Button size="sm" variant="secondary" disabled={blocked} accessibilityLabel={CHAT_CARD_COPY.dismiss} onPress={() => onDecide(item, "rejected")}>
						<Text>{CHAT_CARD_COPY.dismiss}</Text>
					</Button>
				</ChatCardActions>
			) : null}
		</ChatCard>
	);
}
