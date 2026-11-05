import * as React from "react";
import { SheetButton } from "@/components/ui/sheet-button";
import { DraggableSheet } from "@/components/ui/draggable-sheet";
import { Text } from "@/components/ui/text";

/** Gaveta de "em breve" para o que ainda não existe (novo chat, apps). */
export function SoonSheet({ open, title, onClose }: { open: boolean; title: string; onClose: () => void }) {
	return (
		<DraggableSheet visible={open} onClose={onClose} header={<Text variant="heading">{title}</Text>}>
			<Text variant="muted">Em breve.</Text>
			<SheetButton variant="secondary" onPress={onClose}>
				<Text>Entendi</Text>
			</SheetButton>
		</DraggableSheet>
	);
}
