// Cartões do dia no celular (F7): plano do dia, agenda e e-mail. Só mostram (sem ação); texto e ordem vêm de `lib/day-cards`.
import * as React from "react";
import { View } from "react-native";
import { ClockIcon, MailOpenIcon } from "@/components/icons";
import { ChatCard, ChatCardDetails, ChatCardHeader } from "@/components/ui/chat-card";
import { Text } from "@/components/ui/text";
import type { ChatItem } from "@/lib/chat-types";
import { CALENDAR_TITLE, DAY_PLAN_TITLE, calendarWhen, dayPlanDayLabel, dayPlanErrorText, dayPlanSectionTitle, draftSavedNote, guestsText, triageDeadline, triageGroups, triageSummary } from "@/lib/day-cards";

type Of<K extends ChatItem["kind"]> = Extract<ChatItem, { kind: K }>;

const CARD = "max-w-[min(68ch,100%)] self-start";

/** Plano do dia: abertura e só as seções com itens; fonte que falhou vira uma linha honesta no fim. */
export function DayPlanRow({ item }: { item: Of<"day-plan"> }) {
	return (
		<ChatCard className={CARD}>
			<ChatCardHeader leading={<ClockIcon size={16} />} title={DAY_PLAN_TITLE} />
			<Text variant="muted" className="text-caption">
				{dayPlanDayLabel(item.date)}
			</Text>
			<Text className="text-body font-medium">{item.headline}</Text>
			{item.sections.map((section) => (
				<View key={section.id} className="gap-1">
					<Text variant="muted" className="text-caption font-semibold uppercase">
						{dayPlanSectionTitle(section.id)}
					</Text>
					{section.items.map((entry, index) => (
						<View key={`${index}-${entry.text}`} className="flex-row gap-2">
							{entry.time ? (
								<Text variant="muted" className="w-14 text-caption">
									{entry.time}
								</Text>
							) : null}
							<View className="min-w-0 flex-1">
								<Text className="text-body">{entry.text}</Text>
								{entry.detail ? (
									<Text variant="muted" className="text-caption">
										{entry.detail}
									</Text>
								) : null}
							</View>
						</View>
					))}
				</View>
			))}
			{item.sourceErrors.map((error) => (
				<Text key={error.source} className="text-caption text-warning">
					{dayPlanErrorText(error)}
				</Text>
			))}
		</ChatCard>
	);
}

/** Evento criado/alterado ou compromissos de um período. Só mostra. */
export function CalendarRow({ item }: { item: Of<"calendar"> }) {
	const listed = item.action === "listed";
	return (
		<ChatCard className={CARD}>
			<ChatCardHeader leading={<ClockIcon size={16} />} title={CALENDAR_TITLE[item.action]} />
			{item.events.length === 0 ? (
				<Text variant="muted" className="text-body">
					Nada marcado neste período.
				</Text>
			) : null}
			{item.events.map((event) => (
				<View key={event.id} className="gap-0.5">
					<Text className="text-body font-medium">{event.title || "(sem título)"}</Text>
					<Text variant="muted" className="text-caption">
						{[calendarWhen(event, item.timeZone, !listed), event.location, event.attendeeCount ? guestsText(event.attendeeCount) : null].filter(Boolean).join(" · ")}
					</Text>
					{event.conflict ? <Text className="text-caption text-warning">Bate com outro compromisso</Text> : null}
				</View>
			))}
			{item.more ? (
				<Text variant="muted" className="text-caption">
					e mais {item.more}
				</Text>
			) : null}
			{item.notified ? (
				<Text variant="muted" className="text-caption">
					Convite enviado aos convidados
				</Text>
			) : null}
		</ChatCard>
	);
}

/** Triagem do e-mail em grupos (precisa de ação, só para saber, pode ignorar). */
export function EmailTriageRow({ item }: { item: Of<"email-triage"> }) {
	const groups = triageGroups(item.items);
	const [action, ...rest] = groups;
	const shown = action?.category === "needs_action" ? [action] : [];
	const hidden = action?.category === "needs_action" ? rest : groups;
	const renderGroup = (group: (typeof groups)[number]) => (
		<View key={group.category} className="gap-1">
			<Text variant="muted" className="text-caption font-semibold uppercase">
				{group.title}
			</Text>
			{group.items.map((entry) => (
				<View key={entry.id} className="gap-0.5">
					<Text className="text-body">{entry.summary}</Text>
					<Text variant="muted" className="text-caption">
						{[entry.from ? `De ${entry.from}` : null, entry.requester ? `Pedido por ${entry.requester}` : null, entry.deadline ? triageDeadline(entry.deadline) : null].filter(Boolean).join(" · ")}
					</Text>
				</View>
			))}
		</View>
	);
	return (
		<ChatCard className={CARD}>
			<ChatCardHeader leading={<MailOpenIcon size={16} />} title="Triagem do e-mail" />
			<Text variant="muted" className="text-body">
				{triageSummary(item.items)}
			</Text>
			{shown.map(renderGroup)}
			{hidden.length > 0 ? <ChatCardDetails label={`Ver tudo (${hidden.reduce((total, group) => total + group.items.length, 0)})`}>{hidden.map(renderGroup)}</ChatCardDetails> : null}
		</ChatCard>
	);
}

/** Rascunho de e-mail: para quem, assunto, o texto recolhido e a nota de que nada foi enviado. */
export function EmailDraftRow({ item }: { item: Of<"email-draft"> }) {
	return (
		<ChatCard className={CARD}>
			<ChatCardHeader leading={<MailOpenIcon size={16} />} title={item.reply ? "Rascunho de resposta" : "Rascunho de e-mail"} badge={{ tone: "muted", label: "Não enviado" }} />
			<Text className="text-body">Para: {item.to.join(", ")}</Text>
			{item.cc && item.cc.length > 0 ? <Text className="text-body">Cópia: {item.cc.join(", ")}</Text> : null}
			<Text className="text-body font-medium">Assunto: {item.subject}</Text>
			<ChatCardDetails label="Ler o texto">
				<Text className="text-body">{item.body}</Text>
			</ChatCardDetails>
			<Text variant="muted" className="text-caption">
				{draftSavedNote(item.source, item.saved)}
			</Text>
		</ChatCard>
	);
}
