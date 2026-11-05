import { CHAT_CARD_COPY } from "@workspace/ui/lib/chat-card-copy";
import * as React from "react";
import { Pressable, View } from "react-native";
import { BellIcon, CalendarClockIcon, ClockIcon, GitBranchIcon, MailIcon, WebhookIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ChatCard, ChatCardActions, ChatCardBadge, ChatCardHeader, ChatCardLine } from "@/components/ui/chat-card";
import { DraggableSheet } from "@/components/ui/draggable-sheet";
import { SurfaceGroup, SurfaceRow } from "@/components/ui/surface-card";
import { Text } from "@/components/ui/text";
import { chatCardControl } from "@/lib/chat-surface";
import type { ChatItem, RoutineCardItem, RoutineListed } from "@/lib/chat-types";
import { badgeFor, listedSummary, proposalCopy, ROUTINE_SHEET_FULL_AFTER, routineGroupLabel, routineGroupNames, routineIcon, type RoutineIcon } from "@/lib/routine-cards";
import { useAppColorScheme } from "@/lib/use-theme";
import { MarkerRow } from "./cards";

type GroupItem = Extract<ChatItem, { kind: "routine-group" }>;
type ProposalItem = Extract<ChatItem, { kind: "routine-proposal" }>;

/** Ícone do tipo de gatilho: webhook, e-mail, GitHub, alerta, uma vez (relógio) ou recorrente (agenda). */
export function RoutineKindIcon({ kind, size = 16 }: { kind: RoutineIcon; size?: number }) {
	switch (kind) {
		case "webhook":
			return <WebhookIcon size={size} />;
		case "email":
			return <MailIcon size={size} />;
		case "github":
			return <GitBranchIcon size={size} />;
		case "alert":
			return <BellIcon size={size} />;
		case "once":
			return <ClockIcon size={size} />;
		default:
			return <CalendarClockIcon size={size} />;
	}
}

const canOpen = (item: RoutineCardItem): item is RoutineCardItem & { routineId: string } => Boolean(item.routineId) && (item.settled?.state ?? "created") !== "deleted";

/** Nome da rotina e a frase do agendamento ("Uma vez · 03/10 às 10:00", "A cada 50 min"). */
function RoutineTexts({ item }: { item: RoutineCardItem }) {
	const deleted = item.settled?.state === "deleted";
	return (
		<>
			<Text numberOfLines={1} className={`text-sm font-medium ${deleted ? "text-muted-foreground" : ""}`}>
				{item.title}
			</Text>
			{item.settled?.summary ? (
				<Text variant="caption" numberOfLines={1}>
					{item.settled.summary}
				</Text>
			) : null}
		</>
	);
}

/** Cartão de uma rotina, alerta ou gatilho: ícone do tipo, nome, frase do agendamento e o selo do estado ATUAL. */
export function RoutineCard({ item, onOpen }: { item: RoutineCardItem; onOpen: (routineId: string) => void }) {
	if (item.action === "listed") return <RoutineListCard item={item} onOpen={onOpen} />;
	const badge = badgeFor(item);
	const body = (
		<ChatCard variant="activity" className="min-h-11 max-w-full justify-center">
			<ChatCardLine leading={<RoutineKindIcon kind={routineIcon(item)} />} trailing={<ChatCardBadge {...badge} />}>
				<RoutineTexts item={item} />
			</ChatCardLine>
		</ChatCard>
	);
	if (!canOpen(item)) return <View className="max-w-full self-start">{body}</View>;
	return (
		<Pressable role="button" accessibilityLabel={`${item.title}. ${badge.label}. Abrir rotina`} onPress={() => onOpen(item.routineId)} className="max-w-full self-start active:opacity-80">
			{body}
		</Pressable>
	);
}

/** "Suas rotinas": o resumo da lista que o bot mostrou (quantas e quantas ativas); cada uma abre pelos detalhes. */
function RoutineListCard({ item, onOpen }: { item: RoutineCardItem; onOpen: (routineId: string) => void }) {
	const [open, setOpen] = React.useState(false);
	const rows = item.items ?? [];
	const active = rows.filter((row) => row.enabled).length;
	return (
		<>
			<Pressable role="button" accessibilityLabel={`${item.title}. Ver tudo`} onPress={() => rows.length > 0 && setOpen(true)} className="max-w-full self-start active:opacity-80">
				<ChatCard variant="activity" className="min-h-11 max-w-full justify-center">
					<ChatCardLine leading={<ClockIcon size={16} />} trailing={rows.length > 0 ? <Text className="text-body font-medium text-muted-foreground">{`${CHAT_CARD_COPY.seeAll} (${rows.length})`}</Text> : null}>
						<Text numberOfLines={1} className="text-sm font-medium">
							{item.title}
						</Text>
						<Text variant="caption" numberOfLines={1}>
							{rows.length > 0 ? `${rows.length} ${rows.length === 1 ? "rotina" : "rotinas"} · ${active} ${active === 1 ? "ativa" : "ativas"}` : "Nenhuma rotina"}
						</Text>
					</ChatCardLine>
				</ChatCard>
			</Pressable>
			<DraggableSheet visible={open} onClose={() => setOpen(false)} fullHeight={rows.length > ROUTINE_SHEET_FULL_AFTER} header={<SheetTitle text={item.title} />}>
				<SurfaceGroup>
					{rows.map((row) => (
						<ListedRow
							key={row.id}
							row={row}
							onPress={() => {
								setOpen(false);
								onOpen(row.id);
							}}
						/>
					))}
				</SurfaceGroup>
			</DraggableSheet>
		</>
	);
}

function ListedRow({ row, onPress }: { row: RoutineListed; onPress: () => void }) {
	const summary = listedSummary(row);
	return (
		<SurfaceRow onPress={onPress} label={`${row.name}. ${row.enabled ? "Ativa" : "Pausada"}`}>
			<RoutineKindIcon kind={row.triggerType === "once" ? "once" : row.triggerType === "event" ? "webhook" : "schedule"} />
			<View className="min-w-0 flex-1 py-2">
				<Text numberOfLines={1} className="text-control">
					{row.name}
				</Text>
				{summary ? (
					<Text variant="caption" numberOfLines={1}>
						{summary}
					</Text>
				) : null}
			</View>
			<ChatCardBadge tone={row.enabled ? "success" : "pending"} label={row.enabled ? "Ativa" : "Pausada"} />
		</SurfaceRow>
	);
}

function SheetTitle({ text }: { text: string }) {
	return (
		<Text accessibilityRole="header" numberOfLines={2} className="px-1 pb-3 pt-1 text-lg font-semibold">
			{text}
		</Text>
	);
}

/**
 * Várias rotinas seguidas, numa linha só no fio ("Pausou 7 rotinas"), como o Grok: ícone do tipo, texto discreto, sem
 * casca. Tocar abre a gaveta com o cartão de cada uma (o selo mostra o estado atual); cada linha abre os detalhes.
 */
export function RoutineGroupRow({ group, onOpen }: { group: GroupItem; onOpen: (routineId: string) => void }) {
	const [open, setOpen] = React.useState(false);
	const label = routineGroupLabel(group);
	const names = routineGroupNames(group.items);
	return (
		<>
			<MarkerRow text={label.text} icon={<RoutineKindIcon kind={group.noun === "alerta" ? "alert" : "schedule"} size={14} />} onPress={() => setOpen(true)} accessibilityLabel={`${label.text}: ${names}. Ver lista`} />
			<DraggableSheet visible={open} onClose={() => setOpen(false)} fullHeight={group.items.length > ROUTINE_SHEET_FULL_AFTER} header={<SheetTitle text={label.text} />}>
				<SurfaceGroup>
					{group.items.map((item) => (
						<GroupRow
							key={item.id}
							item={item}
							onPress={
								canOpen(item)
									? () => {
											setOpen(false);
											onOpen(item.routineId);
										}
									: undefined
							}
						/>
					))}
				</SurfaceGroup>
			</DraggableSheet>
		</>
	);
}

function GroupRow({ item, onPress }: { item: RoutineCardItem; onPress?: () => void }) {
	const badge = badgeFor(item);
	return (
		<SurfaceRow onPress={onPress} label={`${item.title}. ${badge.label}`}>
			<RoutineKindIcon kind={routineIcon(item)} />
			<View className="min-w-0 flex-1 py-2">
				<RoutineTexts item={item} />
			</View>
			<ChatCardBadge {...badge} />
		</SurfaceRow>
	);
}

/**
 * Rotina que o bot propôs sozinho. Pendente: o app ainda não decide por aqui, então o último recurso é o navegador
 * (`onOpenWeb`); decidida, só o selo e a frase do agendamento.
 */
export function RoutineProposalRow({ item, onOpenWeb, onOpen }: { item: ProposalItem; onOpenWeb: () => void; onOpen: (routineId: string) => void }) {
	const scheme = useAppColorScheme();
	const copy = proposalCopy(item);
	const pending = item.status === "pending";
	const body = (
		<ChatCard className="max-w-[min(68ch,100%)] self-start">
			<ChatCardHeader leading={<CalendarClockIcon size={16} />} title={item.name} badge={copy.badge} />
			<Text variant="muted" className="text-control">
				{copy.line}
			</Text>
			{pending ? (
				<ChatCardActions>
					<Button size="sm" variant="secondary" style={chatCardControl(scheme)} accessibilityLabel="Decidir no navegador" onPress={onOpenWeb}>
						<Text>Decidir no navegador</Text>
					</Button>
				</ChatCardActions>
			) : null}
		</ChatCard>
	);
	if (pending || !item.routineId || item.status === "declined") return body;
	return (
		<Pressable role="button" accessibilityLabel={`${item.name}. Abrir rotina`} onPress={() => onOpen(item.routineId!)} className="active:opacity-80">
			{body}
		</Pressable>
	);
}
