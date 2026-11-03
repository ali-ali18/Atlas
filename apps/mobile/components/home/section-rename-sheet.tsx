import * as React from "react";
import { TextInput, View } from "react-native";
import { Button } from "@/components/ui/button";
import { DraggableSheet } from "@/components/ui/draggable-sheet";
import { Text } from "@/components/ui/text";
import { chatChrome } from "@/lib/chat-surface";
import { normalizeSectionName } from "@/lib/section-actions";
import { colorTokens } from "@/lib/theme";
import { useKeyboardHeight } from "@/lib/use-keyboard-visible";
import { useAppColorScheme } from "@/lib/use-theme";

/**
 * Renomear uma seção na gaveta de baixo (a mesma do menu da mensagem): rótulo, campo com o nome atual já selecionado e
 * "Salvar". Salvar só fica apagado com o nome vazio; com o mesmo nome, só fecha. O teclado empurra o conteúdo para cima: a gaveta vive
 * num `Modal`, que no Android não encolhe com o teclado.
 */
export function SectionRenameSheet({ section, onClose, onSave }: { section: { id: string; name: string } | null; onClose: () => void; onSave: (name: string) => void }) {
	const scheme = useAppColorScheme();
	const chrome = chatChrome(scheme);
	const keyboard = useKeyboardHeight();
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
				<TextInput
					autoFocus
					selectTextOnFocus
					value={draft}
					onChangeText={setDraft}
					returnKeyType="done"
					onSubmitEditing={save}
					maxLength={80}
					accessibilityLabel="Nome da seção"
					placeholderTextColor={colorTokens[scheme]["muted-foreground"]}
					style={{ backgroundColor: chrome.fill, borderColor: chrome.edge }}
					className="h-14 rounded-2xl border px-5 text-lg text-foreground"
				/>
			</View>
			<Button size="lg" onPress={save} disabled={!canSave} className="h-14 w-full rounded-full">
				<Text className="text-lg">Salvar</Text>
			</Button>
			{keyboard > 0 ? <View style={{ height: keyboard }} /> : null}
		</DraggableSheet>
	);
}
