import * as React from "react";
import { Pressable, ScrollView, View } from "react-native";
import { CheckCircleIcon, ChevronUpIcon, CircleIcon, ListChecksIcon } from "@/components/icons";
import { ChatCard, ChatCardLine } from "@/components/ui/chat-card";
import { ChatCardDetails } from "@/components/ui/chat-card";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/cn";
import { taskListDockLine, taskListProgress, taskListSettledLabel } from "@/lib/chat-thread";
import type { TaskItem } from "@/lib/chat-types";

/** Os passos, um por linha, com um ícone por estado. */
export function TaskListItems({ items }: { items: readonly TaskItem[] }) {
	return (
		<View className="gap-2">
			{items.map((item, index) => (
				<View key={`${index}-${item.content}`} className="flex-row items-start gap-2.5">
					<View className="mt-0.5 size-4 items-center justify-center">
						{item.status === "completed" ? <CheckCircleIcon size={16} tone="success" /> : item.status === "in_progress" ? <Spinner label="Em andamento" /> : <CircleIcon size={16} />}
					</View>
					<Text className={cn("min-w-0 flex-1 text-control", item.status === "completed" ? "text-muted-foreground line-through" : item.status === "in_progress" ? "font-medium" : "text-muted-foreground")}>{item.content}</Text>
				</View>
			))}
		</View>
	);
}

/**
 * Doca de tarefas: seção do container único do composer (sem fundo nem raio próprios, só o divisor `border-b`), como a
 * doca do web. Enquanto o run está ativo: uma linha "2/5 · tarefa atual"; tocar abre os passos.
 */
export function TaskDock({ items }: { items: readonly TaskItem[] }) {
	const [open, setOpen] = React.useState(false);
	const { total, allDone } = taskListProgress(items);
	if (total === 0) return null;
	return (
		<View accessibilityLabel="Tarefas do bot">
			<Pressable role="button" accessibilityLabel={open ? "Recolher a lista de tarefas" : "Abrir a lista de tarefas"} accessibilityState={{ expanded: open }} onPress={() => setOpen((value) => !value)} className="min-h-11 flex-row items-center gap-2.5 pl-4 pr-3 active:opacity-70">
				<View className="size-5 items-center justify-center">{allDone ? <CheckCircleIcon size={18} tone="success" /> : <Spinner />}</View>
				<Text numberOfLines={1} className="min-w-0 flex-1 text-sm text-muted-foreground">
					{taskListDockLine(items)}
				</Text>
				<View style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}>
					<ChevronUpIcon />
				</View>
			</Pressable>
			{open ? (
				<ScrollView style={{ maxHeight: 240 }} className="px-4 pb-3" nestedScrollEnabled>
					<TaskListItems items={items} />
				</ScrollView>
			) : null}
		</View>
	);
}

/** Resumo que fica no fio depois do run: "Tarefas · 5/5 concluídas" (abre os passos). */
export function TaskSummary({ items }: { items: readonly TaskItem[] }) {
	const { total, allDone } = taskListProgress(items);
	if (total === 0) return null;
	return (
		<ChatCard variant="activity" className="self-start">
			<ChatCardDetails
				label={`Ver tudo (${total})`}
				summary={
					<ChatCardLine leading={allDone ? <CheckCircleIcon size={16} tone="success" /> : <ListChecksIcon />}>
						<Text numberOfLines={1} className="text-sm font-medium">
							{taskListSettledLabel(items)}
						</Text>
					</ChatCardLine>
				}
			>
				<TaskListItems items={items} />
			</ChatCardDetails>
		</ChatCard>
	);
}
