import * as React from "react";
import { View } from "react-native";
import { CameraIcon, FileIcon, ImageIcon } from "@/components/icons";
import { DraggableSheet } from "@/components/ui/draggable-sheet";
import { SurfaceGroup, SurfaceRow } from "@/components/ui/surface-card";
import { Text } from "@/components/ui/text";

export type AttachmentAction = "camera" | "photos" | "files";

const ACTIONS: readonly { id: AttachmentAction; label: string; icon: React.ReactNode }[] = [
	{ id: "camera", label: "Câmera", icon: <CameraIcon /> },
	{ id: "photos", label: "Fotos", icon: <ImageIcon /> },
	{ id: "files", label: "Arquivo", icon: <FileIcon /> },
];

/** As três ações num grupo só (a pele de `SurfaceGroup`); a folha abaixo as põe numa gaveta. */
export function AttachmentActions({ onPick }: { onPick: (action: AttachmentAction) => void }) {
	return (
		<SurfaceGroup>
			{ACTIONS.map((action) => (
				<SurfaceRow key={action.id} label={action.label} onPress={() => onPick(action.id)}>
					<View className="size-6 items-center justify-center">{action.icon}</View>
					<Text className="text-control">{action.label}</Text>
				</SurfaceRow>
			))}
		</SurfaceGroup>
	);
}

/** Folha do "+" do composer: Câmera, Fotos e Arquivo (os mesmos três do menu do web). Fecha ao escolher. */
export function AttachmentSheet({ open, onPick, onClose }: { open: boolean; onPick: (action: AttachmentAction) => void; onClose: () => void }) {
	return (
		<DraggableSheet visible={open} onClose={onClose} header={<Text variant="heading">Adicionar</Text>}>
			<AttachmentActions onPick={onPick} />
		</DraggableSheet>
	);
}
