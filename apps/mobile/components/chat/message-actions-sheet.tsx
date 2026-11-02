import * as React from "react";
import { CopyIcon, HashIcon, MailOpenIcon, ReplyIcon, TextSelectIcon } from "@/components/icons";
import { ActionSheet, type SheetGroup } from "@/components/ui/action-sheet";
import type { MessageMenu } from "@/lib/message-actions";
import { ReactionPicker } from "./reaction-picker";

export type MessageSheetHandlers = {
	onReact: (emoji: string) => void;
	/** Sem ele a linha "Responder" não aparece. */
	onReply?: () => void;
	onMarkUnread: () => void;
	onCopy: () => void;
	onSelect: () => void;
	onCopyRunId: () => void;
};

/**
 * Gaveta que abre ao segurar uma mensagem: reações, depois Responder / Marcar como não lida, depois Copiar /
 * Selecionar texto / Copiar ID da solicitação (esta só em fala do bot que tenha run). A casca (alça, cartões,
 * divisores) é o `ActionSheet`, o mesmo de qualquer menu de segurar do app.
 */
export function MessageActionsSheet({ menu, onClose, handlers }: { menu: MessageMenu | null; onClose: () => void; handlers: MessageSheetHandlers }) {
	const reply: SheetGroup = [
		...(handlers.onReply ? [{ key: "reply", label: "Responder", icon: <ReplyIcon />, onPress: handlers.onReply }] : []),
		{ key: "unread", label: "Marcar como não lida", icon: <MailOpenIcon />, onPress: handlers.onMarkUnread },
	];
	const copy: SheetGroup = [
		{ key: "copy", label: "Copiar", icon: <CopyIcon />, onPress: handlers.onCopy },
		{ key: "select", label: "Selecionar texto", icon: <TextSelectIcon />, onPress: handlers.onSelect },
		...(menu?.runId ? [{ key: "run-id", label: "Copiar ID da solicitação", icon: <HashIcon />, onPress: handlers.onCopyRunId }] : []),
	];
	return <ActionSheet visible={menu !== null} onClose={onClose} header={<ReactionPicker current={menu?.reaction ?? null} onPick={handlers.onReact} />} groups={[reply, copy]} />;
}
