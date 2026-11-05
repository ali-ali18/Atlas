import { validateProfileName } from "@workspace/shared";
import * as React from "react";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { ChromeInput } from "@/components/ui/chrome-input";
import { DraggableSheet } from "@/components/ui/draggable-sheet";
import { Text } from "@/components/ui/text";
import { useKeyboardHeight } from "@/lib/use-keyboard-visible";

/**
 * Editar o nome do perfil numa gaveta: campo com o nome atual e "Salvar" (apagado sem mudança ou com nome inválido, com a
 * mesma validação do servidor). O teclado empurra o conteúdo: a gaveta vive num `Modal`, que no Android não encolhe com ele.
 */
export function ProfileNameSheet({ visible, currentName, email, saving, onClose, onSave }: { visible: boolean; currentName: string; email: string | null; saving: boolean; onClose: () => void; onSave: (name: string) => void }) {
	const keyboard = useKeyboardHeight();
	const [draft, setDraft] = React.useState(currentName);
	React.useEffect(() => {
		if (visible) setDraft(currentName);
	}, [visible, currentName]);
	const check = validateProfileName(draft);
	const canSave = check.ok && check.name !== currentName.trim() && !saving;
	const save = () => {
		if (check.ok && canSave) onSave(check.name);
	};
	return (
		<DraggableSheet visible={visible} onClose={onClose}>
			<View className="gap-2 pt-2">
				<Text className="px-3 text-body text-muted-foreground">Nome</Text>
				<ChromeInput autoFocus selectTextOnFocus accessibilityLabel="Nome" value={draft} onChangeText={setDraft} maxLength={80} autoCapitalize="words" returnKeyType="done" onSubmitEditing={save} invalid={!check.ok && draft.length > 0} editable={!saving} />
				{!check.ok && draft.length > 0 ? (
					<Text className="px-3 text-body text-destructive" accessibilityRole="alert">
						{check.error}
					</Text>
				) : null}
				{email ? (
					<>
						<Text className="px-3 pt-2 text-body text-muted-foreground">E-mail</Text>
						<ChromeInput readOnly accessibilityLabel="E-mail" value={email} />
						<Text variant="muted" className="px-3 text-body">
							O e-mail é o do seu login e não muda por aqui.
						</Text>
					</>
				) : null}
			</View>
			<Button size="lg" onPress={save} disabled={!canSave} className="w-full">
				<Text>{saving ? "Salvando…" : "Salvar"}</Text>
			</Button>
			{keyboard > 0 ? <View style={{ height: keyboard }} /> : null}
		</DraggableSheet>
	);
}
