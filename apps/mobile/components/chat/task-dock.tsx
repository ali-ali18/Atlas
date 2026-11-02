import { View } from "react-native";
import { CheckCircleIcon, CircleIcon, ListChecksIcon } from "@/components/icons";
import { ChatCard, ChatCardLine } from "@/components/ui/chat-card";
import { ChatCardDetails } from "@/components/ui/chat-card";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/cn";
import { taskListProgress, taskListSettledLabel } from "@/lib/chat-thread";
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
