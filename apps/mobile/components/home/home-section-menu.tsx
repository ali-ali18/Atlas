import * as React from "react";
import { Alert } from "react-native";
import { ArrowDownIcon, ArrowUpIcon, PencilIcon, Trash2Icon } from "@/components/icons";
import { ActionSheet, type SheetAction, type SheetGroup } from "@/components/ui/action-sheet";
import { useAtlasSession } from "@/lib/atlas-session";
import { useHomeData } from "@/lib/home-data";
import { NO_SECTION_TITLE } from "@/lib/home-list";
import type { SectionRef } from "@/lib/home-types";
import { canMoveSection, normalizeSectionName, swapSectionOrder } from "@/lib/section-actions";
import { deleteSectionRemote, patchSection } from "@/lib/section-api";
import { themeColor } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

export type SectionMenuTarget = { id: string; name: string };

/**
 * Menu de segurar o título de uma seção na home: mesma gaveta (`ActionSheet`) do menu da conversa. Salva pelos
 * endpoints `/v1/sections/:id` do web; ao excluir, os bots voltam para "Sem sessão".
 */
export function HomeSectionMenu({
	section,
	onClose,
	onStartRename,
}: {
	section: SectionMenuTarget | null;
	onClose: () => void;
	onStartRename: (section: SectionMenuTarget) => void;
}) {
	const scheme = useAppColorScheme();
	const stroke = themeColor(scheme, "foreground");
	const { apiFetch } = useAtlasSession();
	const { snapshot, refresh, applySectionUpdate, applySectionsReplace, applySectionRemoved } = useHomeData();
	const last = React.useRef<SectionMenuTarget | null>(null);
	if (section) last.current = section;
	const current = section ?? last.current;
	const sections = snapshot?.sections ?? [];

	const move = React.useCallback(
		(target: SectionMenuTarget, direction: "up" | "down") => {
			const next = swapSectionOrder(sections, target.id, direction);
			if (!next) return;
			const ordered = [...sections].sort((a, b) => a.order - b.order);
			const index = ordered.findIndex((item) => item.id === target.id);
			const swapIndex = direction === "up" ? index - 1 : index + 1;
			const other = ordered[swapIndex];
			if (index < 0 || !other) return;
			const before = sections;
			onClose();
			applySectionsReplace(next);
			void Promise.all([patchSection(apiFetch, target.id, { order: other.order }), patchSection(apiFetch, other.id, { order: ordered[index]!.order })]).catch(() => {
				applySectionsReplace(before);
				void refresh();
			});
		},
		[apiFetch, applySectionsReplace, onClose, refresh, sections],
	);

	const remove = React.useCallback(
		(target: SectionMenuTarget) => {
			onClose();
			Alert.alert("Excluir seção?", `Os bots desta seção voltam para "${NO_SECTION_TITLE}".`, [
				{ text: "Cancelar", style: "cancel" },
				{
					text: "Excluir",
					style: "destructive",
					onPress: () => {
						applySectionRemoved(target.id);
						void deleteSectionRemote(apiFetch, target.id).catch(() => {
							void refresh();
						});
					},
				},
			]);
		},
		[apiFetch, applySectionRemoved, onClose, refresh],
	);

	const groups: SheetGroup[] = [];
	if (current) {
		const target = current;
		const actions: SheetAction[] = [
			{
				key: "rename",
				label: "Renomear",
				icon: <PencilIcon />,
				onPress: () => {
					onClose();
					onStartRename(target);
				},
			},
		];
		if (canMoveSection(sections, target.id, "up")) {
			actions.push({
				key: "up",
				label: "Mover para cima",
				icon: <ArrowUpIcon size={20} color={stroke} />,
				onPress: () => move(target, "up"),
			});
		}
		if (canMoveSection(sections, target.id, "down")) {
			actions.push({
				key: "down",
				label: "Mover para baixo",
				icon: <ArrowDownIcon />,
				onPress: () => move(target, "down"),
			});
		}
		actions.push({
			key: "delete",
			label: "Excluir",
			icon: <Trash2Icon />,
			tone: "destructive",
			onPress: () => remove(target),
		});
		groups.push(actions);
	}

	return <ActionSheet visible={section !== null} onClose={onClose} groups={groups} />;
}

/** Confirma o novo nome no servidor depois do modo de edição inline no título. */
export function commitSectionRename(
	apiFetch: (path: string, init?: RequestInit) => Promise<Response>,
	handlers: {
		applySectionUpdate: (sectionId: string, patch: Partial<Pick<SectionRef, "name">>) => void;
		refresh: () => Promise<void>;
	},
	sectionId: string,
	previousName: string,
	rawName: string,
) {
	const name = normalizeSectionName(rawName);
	if (!name || name === previousName) return;
	handlers.applySectionUpdate(sectionId, { name });
	void patchSection(apiFetch, sectionId, { name }).catch(() => {
		handlers.applySectionUpdate(sectionId, { name: previousName });
		void handlers.refresh();
	});
}
