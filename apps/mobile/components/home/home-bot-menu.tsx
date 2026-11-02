import { useRouter } from "expo-router";
import * as React from "react";
import { FolderInputIcon, FolderOutputIcon, MailOpenIcon, PinIcon, PinOffIcon, UserCircleIcon } from "@/components/icons";
import { ActionSheet, type SheetAction, type SheetGroup } from "@/components/ui/action-sheet";
import { useAtlasSession } from "@/lib/atlas-session";
import { patchPlacement, pinPlacement, sectionPlacement, type Placement } from "@/lib/bot-placement";
import { markConversationUnread } from "@/lib/chat-api";
import { useHomeData } from "@/lib/home-data";
import type { HomeBot } from "@/lib/home-types";

/**
 * Menu de segurar uma conversa na home: a mesma gaveta do menu da mensagem. Salva pelo mesmo `PATCH /v1/bots/:id` do
 * web; a lista muda na hora e volta atrás se o servidor recusar.
 */
export function HomeBotMenu({ bot, onClose }: { bot: HomeBot | null; onClose: () => void }) {
	const router = useRouter();
	const { apiFetch } = useAtlasSession();
	const { snapshot, refresh, applyBotUpdate } = useHomeData();
	// Guarda o último bot para a gaveta não esvaziar no meio da animação de fechar.
	const last = React.useRef<HomeBot | null>(null);
	if (bot) last.current = bot;
	const current = bot ?? last.current;

	const place = React.useCallback(
		(target: HomeBot, patch: Partial<Placement>) => {
			onClose();
			// Volta só o que este patch mexeu (o resto pode ter mudado por outra ação).
			const original: Placement = { pinned: target.pinned, pinOrder: target.pinOrder, sectionId: target.sectionId };
			const before = Object.fromEntries(Object.keys(patch).map((key) => [key, original[key as keyof Placement]])) as Partial<Placement>;
			applyBotUpdate(target.id, patch);
			// Recusa do servidor: devolve o que estava e sincroniza com ele.
			void patchPlacement(apiFetch, target.id, patch).catch(() => {
				applyBotUpdate(target.id, before);
				void refresh();
			});
		},
		[apiFetch, applyBotUpdate, onClose, refresh],
	);

	const actions: SheetAction[] = [];
	if (current?.conversationId && !current.unread) {
		const conversationId = current.conversationId;
		actions.push({
			key: "unread",
			label: "Marcar como não lida",
			icon: <MailOpenIcon />,
			onPress: () => {
				onClose();
				void markConversationUnread(apiFetch, conversationId).then(() => refresh(), () => undefined);
			},
		});
	}
	if (current) {
		const target = current;
		const pinned = target.pinned;
		actions.push({
			key: "pin",
			label: pinned ? "Desafixar" : "Fixar",
			icon: pinned ? <PinOffIcon /> : <PinIcon />,
			onPress: () => place(target, pinPlacement(target, snapshot?.bots ?? [], !pinned)),
		});
		const sections = (snapshot?.sections ?? []).filter((section) => section.id !== target.sectionId);
		const moves: SheetAction[] = sections.map((section) => ({ key: `to-${section.id}`, label: section.name, onPress: () => place(target, sectionPlacement(section.id)) }));
		const out: SheetAction[] = target.sectionId ? [{ key: "out", label: "Tirar da seção", icon: <FolderOutputIcon />, onPress: () => place(target, sectionPlacement(null)) }] : [];
		if (moves.length > 0 || out.length > 0) {
			actions.push({ key: "move", label: "Mover para", icon: <FolderInputIcon />, submenu: { groups: [moves, out].filter((group) => group.length > 0) } });
		}
		actions.push({
			key: "profile",
			label: "Ver perfil",
			icon: <UserCircleIcon />,
			onPress: () => {
				onClose();
				router.push(`/profile/${encodeURIComponent(target.id)}` as never);
			},
		});
	}
	const groups: SheetGroup[] = [actions];
	return <ActionSheet visible={bot !== null} onClose={onClose} groups={groups} />;
}
