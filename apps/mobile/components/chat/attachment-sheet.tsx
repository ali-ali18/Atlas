import * as React from "react";
import { Modal, Pressable, View } from "react-native";
import { ThemedModalRoot } from "@/components/home/themed-modal";
import { CameraIcon, FileIcon, ImageIcon } from "@/components/icons";
import { SurfaceGroup, SurfaceRow } from "@/components/ui/surface-card";
import { Text } from "@/components/ui/text";
import { useSurfaces } from "@/lib/use-surfaces";

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
	const surfaces = useSurfaces();
	return (
		<Modal visible={open} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
			<ThemedModalRoot>
				<Pressable accessibilityLabel="Fechar" onPress={onClose} className="flex-1 justify-end bg-black/50">
					<Pressable accessible={false} style={{ backgroundColor: surfaces.sheet }} className="gap-3 rounded-t-panel px-4 pb-8 pt-4">
						<Text variant="heading" className="px-2">
							Adicionar
						</Text>
						<AttachmentActions onPick={onPick} />
					</Pressable>
				</Pressable>
			</ThemedModalRoot>
		</Modal>
	);
}
