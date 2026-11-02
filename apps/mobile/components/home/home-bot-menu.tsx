import { useRouter } from "expo-router";
import * as React from "react";
import { MailOpenIcon, UserCircleIcon } from "@/components/icons";
import { ActionSheet, type SheetGroup } from "@/components/ui/action-sheet";
import { useAtlasSession } from "@/lib/atlas-session";
import { markConversationUnread } from "@/lib/chat-api";
import type { HomeBot } from "@/lib/home-types";

/** Menu de segurar uma conversa na home: a mesma gaveta do menu da mensagem. Só o que o app já sabe fazer de verdade. */
export function HomeBotMenu({ bot, onClose, onChanged }: { bot: HomeBot | null; onClose: () => void; onChanged: () => void }) {
	const router = useRouter();
	const { apiFetch } = useAtlasSession();
	// Guarda o último bot para a gaveta não esvaziar no meio da animação de fechar.
	const last = React.useRef<HomeBot | null>(null);
	if (bot) last.current = bot;
	const current = bot ?? last.current;
	const group: SheetGroup = [];
	if (current?.conversationId && !current.unread) {
		const conversationId = current.conversationId;
		group.push({
			key: "unread",
			label: "Marcar como não lida",
			icon: <MailOpenIcon />,
			onPress: () => {
				onClose();
				void markConversationUnread(apiFetch, conversationId).then(onChanged, () => undefined);
			},
		});
	}
	if (current) {
		const id = current.id;
		group.push({
			key: "profile",
			label: "Ver perfil",
			icon: <UserCircleIcon />,
			onPress: () => {
				onClose();
				router.push(`/profile/${encodeURIComponent(id)}` as never);
			},
		});
	}
	return <ActionSheet visible={bot !== null} onClose={onClose} groups={[group]} />;
}
