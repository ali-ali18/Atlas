import * as React from "react";
import { Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CopyIcon, HashIcon, MailOpenIcon, ReplyIcon, TextSelectIcon } from "@/components/icons";
import { ThemedModalRoot } from "@/components/home/themed-modal";
import { Text } from "@/components/ui/text";
import type { MessageMenu } from "@/lib/message-actions";
import { ReactionPicker } from "./reaction-picker";

export type SheetAction = { key: string; label: string; icon: React.ReactNode; onPress: () => void };

export type MessageSheetHandlers = {
	onReact: (emoji: string) => void;
	/** Sem ele a linha "Responder" não aparece. */
	onReply?: () => void;
	onMarkUnread: () => void;
	onCopy: () => void;
	onSelect: () => void;
	onCopyRunId: () => void;
};

/** Cartão escuro arredondado com linhas (ícone à esquerda) e um divisor fino entre elas. */
function ActionCard({ actions }: { actions: SheetAction[] }) {
	return (
		<View className="overflow-hidden rounded-card bg-muted">
			{actions.map((action, index) => (
				<React.Fragment key={action.key}>
					{index > 0 ? <View className="ml-14 h-px bg-border" /> : null}
					<Pressable role="button" accessibilityLabel={action.label} onPress={action.onPress} className="min-h-14 flex-row items-center gap-4 px-5 active:bg-foreground/10">
						{action.icon}
						<Text numberOfLines={1} className="flex-1 text-control">
							{action.label}
						</Text>
					</Pressable>
				</React.Fragment>
			))}
		</View>
	);
}

/**
 * Gaveta que abre ao segurar uma mensagem: reações, depois Responder / Marcar como não lida, depois Copiar /
 * Selecionar texto / Copiar ID da solicitação (esta só em fala do bot que tenha run). Padrão das gavetas do app:
 * `Modal` transparente com fundo que fecha ao tocar fora.
 */
export function MessageActionsSheet({ menu, onClose, handlers }: { menu: MessageMenu | null; onClose: () => void; handlers: MessageSheetHandlers }) {
	const insets = useSafeAreaInsets();
	const reply: SheetAction[] = [
		...(handlers.onReply ? [{ key: "reply", label: "Responder", icon: <ReplyIcon />, onPress: handlers.onReply }] : []),
		{ key: "unread", label: "Marcar como não lida", icon: <MailOpenIcon />, onPress: handlers.onMarkUnread },
	];
	const copy: SheetAction[] = [
		{ key: "copy", label: "Copiar", icon: <CopyIcon />, onPress: handlers.onCopy },
		{ key: "select", label: "Selecionar texto", icon: <TextSelectIcon />, onPress: handlers.onSelect },
		...(menu?.runId ? [{ key: "run-id", label: "Copiar ID da solicitação", icon: <HashIcon />, onPress: handlers.onCopyRunId }] : []),
	];
	return (
		<Modal visible={menu !== null} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
			<ThemedModalRoot>
				<Pressable accessibilityLabel="Fechar" onPress={onClose} className="flex-1 justify-end bg-black/50">
					<Pressable accessible={false} className="gap-4 rounded-t-panel bg-popover px-4 pt-3" style={{ paddingBottom: insets.bottom + 16 }}>
						<View className="h-1 w-10 self-center rounded-full bg-muted-foreground/40" />
						<ReactionPicker current={menu?.reaction ?? null} onPick={handlers.onReact} />
						<ActionCard actions={reply} />
						<ActionCard actions={copy} />
					</Pressable>
				</Pressable>
			</ThemedModalRoot>
		</Modal>
	);
}
