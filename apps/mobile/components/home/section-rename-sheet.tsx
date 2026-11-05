import * as React from "react";
import { View } from "react-native";
import { SheetButton } from "@/components/ui/sheet-button";
import { ChromeInput } from "@/components/ui/chrome-input";
import { DraggableSheet } from "@/components/ui/draggable-sheet";
import { Text } from "@/components/ui/text";
import { normalizeSectionName } from "@/lib/section-actions";

/**
 * Renomear uma seção na gaveta de baixo (a mesma do menu da mensagem): rótulo, campo com o nome atual já selecionado e
 * "Salvar". Salvar só fica apagado com o nome vazio; com o mesmo nome, só fecha. A gaveta sobe junto com o teclado
 * (o `DraggableSheet` cuida disso).
 */
export function SectionRenameSheet({ section, onClose, onSave }: { section: { id: string; name: string } | null; onClose: () => void; onSave: (name: string) => void }) {
	const [draft, setDraft] = React.useState("");
	const last = React.useRef(section);
	if (section) last.current = section;
	const current = section ?? last.current;
	React.useEffect(() => {
		if (section) setDraft(section.name);
	}, [section]);
	const name = normalizeSectionName(draft);
	const canSave = Boolean(current && name);
	const save = () => {
		if (!current || !name) return;
		if (name === current.name) onClose();
		else onSave(name);
	};
	return (
		<DraggableSheet visible={section !== null} onClose={onClose}>
			<View className="gap-2 pt-2">
				<Text className="px-3 text-body text-muted-foreground">Nome da seção</Text>
				<ChromeInput autoFocus selectTextOnFocus value={draft} onChangeText={setDraft} returnKeyType="done" onSubmitEditing={save} maxLength={80} accessibilityLabel="Nome da seção" />
			</View>
			<SheetButton onPress={save} disabled={!canSave}>
				<Text>Salvar</Text>
			</SheetButton>
		</DraggableSheet>
	);
}
