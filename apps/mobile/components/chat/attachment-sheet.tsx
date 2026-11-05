import * as React from "react";
import { CameraIcon, FileIcon, ImageIcon } from "@/components/icons";
import { ActionSheet, type SheetGroup } from "@/components/ui/action-sheet";
import { Text } from "@/components/ui/text";

export type AttachmentAction = "camera" | "photos" | "files";

/** As três ações num grupo do `ActionSheet` (o mesmo desenho do menu da mensagem). */
export function attachmentGroups(onPick: (action: AttachmentAction) => void): SheetGroup[] {
	return [
		[
			{ key: "camera", label: "Câmera", icon: <CameraIcon />, onPress: () => onPick("camera") },
			{ key: "photos", label: "Fotos", icon: <ImageIcon />, onPress: () => onPick("photos") },
			{ key: "files", label: "Arquivo", icon: <FileIcon />, onPress: () => onPick("files") },
		],
	];
}

/** Folha do "+" do composer: Câmera, Fotos e Arquivo (os mesmos três do menu do web), pelo `ActionSheet`. Quem chama fecha ao escolher. */
export function AttachmentSheet({ open, onPick, onClose }: { open: boolean; onPick: (action: AttachmentAction) => void; onClose: () => void }) {
	return <ActionSheet visible={open} onClose={onClose} header={<Text variant="heading">Adicionar</Text>} groups={attachmentGroups(onPick)} />;
}
