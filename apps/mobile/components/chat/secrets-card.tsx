import * as React from "react";
import { Pressable, TextInput, View } from "react-native";
import { EyeIcon, EyeOffIcon, KeyRoundIcon } from "@/components/icons";
import { Text } from "@/components/ui/text";
import { chatChrome } from "@/lib/chat-surface";
import type { ChatItem } from "@/lib/chat-types";
import { canSaveSecrets, secretEntries, secretsBadge } from "@/lib/request-cards";
import { themeColor } from "@/lib/theme";
import type { ActionResult } from "@/lib/use-request-actions";
import { useAppColorScheme } from "@/lib/use-theme";
import { RequestButton, RequestShell, RequestTextButton } from "./request-shell";

type Secrets = Extract<ChatItem, { kind: "secrets" }>;

/** Um segredo: nome, campo MASCARADO e o olho para mostrar/ocultar. */
function SecretField({ name, value, onChange, invalid }: { name: string; value: string; onChange: (value: string) => void; invalid: boolean }) {
	const scheme = useAppColorScheme();
	const chrome = chatChrome(scheme);
	const [shown, setShown] = React.useState(false);
	return (
		<View className="gap-1.5">
			<Text variant="muted" className="px-1 font-mono text-caption" numberOfLines={1}>
				{name}
			</Text>
			<View className="h-12 flex-row items-center rounded-2xl border px-4" style={{ backgroundColor: chrome.control, borderColor: invalid ? themeColor(scheme, "destructive") : "transparent" }}>
				<TextInput
					accessibilityLabel={name}
					value={value}
					onChangeText={onChange}
					placeholder="Cole aqui"
					placeholderTextColor={themeColor(scheme, "muted-foreground")}
					secureTextEntry={!shown}
					autoCapitalize="none"
					autoCorrect={false}
					spellCheck={false}
					autoComplete="off"
					textContentType="none"
					className="min-w-0 flex-1 text-control text-foreground"
				/>
				<Pressable role="button" accessibilityLabel={shown ? `Ocultar ${name}` : `Mostrar ${name}`} onPress={() => setShown((current) => !current)} hitSlop={8} className="pl-2 active:opacity-60">
					{shown ? <EyeOffIcon /> : <EyeIcon />}
				</Pressable>
			</View>
		</View>
	);
}

/**
 * Pedido de segredo do bot para o Cofre: um campo mascarado por nome. O valor vai direto do campo à API do Cofre
 * (`POST /v1/vault/secrets`, o mesmo do web); só então o cartão é aprovado (nomes, nunca valores) e o estado é apagado.
 * O valor nunca entra no item do chat, no cache nem em log: vive só no `useState` deste cartão.
 */
export function SecretsCard({ item, onSave, onDecide }: { item: Secrets; onSave: (entries: { name: string; value: string }[]) => Promise<ActionResult>; onDecide: (item: Secrets, approve: boolean) => void }) {
	const [values, setValues] = React.useState<Record<string, string>>({});
	const [busy, setBusy] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const pending = item.status === "pending";
	const badge = secretsBadge(item.status);

	const save = async () => {
		const entries = secretEntries(item.names, values);
		if (busy || entries.length === 0) return;
		setBusy(true);
		setError(null);
		const result = await onSave(entries);
		setBusy(false);
		if (!result.ok) return setError(result.error);
		// Guardado: o valor sai do estado antes de qualquer outra coisa.
		setValues({});
		onDecide(item, true);
	};

	return (
		<RequestShell icon={<KeyRoundIcon />} label="Segredos" badge={badge ?? undefined} note={pending ? "Armazenado com segurança, nunca mostrado ao seu Bot." : undefined} noteIcon accessibilityLabel={item.title}>
			<View className="gap-1">
				<Text className="text-base font-semibold">{item.title}</Text>
				{item.description ? (
					<Text variant="muted" className="text-body">
						{item.description}
					</Text>
				) : null}
			</View>
			{pending ? (
				<>
					{item.names.map((name) => (
						<SecretField key={name} name={name} value={values[name] ?? ""} invalid={error !== null} onChange={(value) => { setValues((current) => ({ ...current, [name]: value })); setError(null); }} />
					))}
					{error ? (
						<Text variant="error" className="px-1 text-body" role="alert">
							{error}
						</Text>
					) : null}
					<View className="flex-row items-center justify-end gap-1">
						<RequestTextButton label={item.cancelLabel ?? "Agora não"} disabled={busy} onPress={() => onDecide(item, false)} />
						<RequestButton label={item.confirmLabel ?? "Salvar"} busy={busy} disabled={!canSaveSecrets(item.names, values)} onPress={() => void save()} />
					</View>
				</>
			) : (
				<Text variant="muted" className="font-mono text-caption">
					{item.names.join(", ")}
				</Text>
			)}
		</RequestShell>
	);
}
