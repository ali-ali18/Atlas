"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import { detectSecretsInText, replaceDetected, type DetectedSecret } from "@workspace/shared";
import { saveVaultSecrets } from "@/lib/atlas-api";
import { SecretPasteNotice } from "./secret-paste-notice";

/** Nomes sugeridos sem repetir dentro da mesma mensagem (o servidor ainda garante unicidade no cofre). */
export function nameDetected(detected: readonly DetectedSecret[]): string[] {
	const used = new Map<string, number>();
	return detected.map((item) => {
		const base = item.suggestedName;
		const count = (used.get(base) ?? 0) + 1;
		used.set(base, count);
		return count === 1 ? base : `${base}-${count}`;
	});
}

export type SecretPasteGuard = {
	/** Aviso para renderizar acima do campo (null quando não há nada suspeito). */
	notice: ReactNode;
	/** Chame no início do envio: true = barrou (o aviso fica em destaque). */
	intercept: () => boolean;
};

/**
 * Detecta segredo no texto do composer. Mudança mínima no composer: uma chamada do hook,
 * `intercept()` no início de `submit()` e `{notice}` acima do campo.
 */
export function useSecretPasteGuard(input: {
	value: string;
	setValue: (next: string) => void;
	/** Reenvia depois de "Enviar mesmo assim". */
	send: () => void;
	/** Injetável em testes. */
	save?: typeof saveVaultSecrets;
}): SecretPasteGuard {
	const { value, setValue, send, save = saveVaultSecrets } = input;
	const dismissed = useRef<string | null>(null);
	const [dismissedTick, setDismissedTick] = useState(0);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [attention, setAttention] = useState(false);
	const detected = useMemo(() => (value.length > 8 ? detectSecretsInText(value) : []), [value]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: o tick força reavaliar o ref de descarte.
	const active = useMemo(() => detected.length > 0 && dismissed.current !== value, [detected, value, dismissedTick]);

	async function saveToVault() {
		setBusy(true);
		setError(null);
		try {
			const names = nameDetected(detected);
			const { saved } = await save(
				detected.map((item, index) => ({ name: names[index]!, value: item.value })),
				"unique",
			);
			// A resposta vem na mesma ordem; o servidor pode ter renomeado para não sobrescrever.
			setValue(replaceDetected(value, detected, saved.map((entry) => entry.name)));
			setAttention(false);
		} catch (cause) {
			setError(cause instanceof Error && cause.message ? cause.message : "Não consegui guardar no cofre.");
		} finally {
			setBusy(false);
		}
	}

	return {
		notice: active ? (
			<SecretPasteNotice
				attention={attention}
				busy={busy}
				count={detected.length}
				error={error}
				onSave={() => void saveToVault()}
				onSendAnyway={() => {
					dismissed.current = value;
					setDismissedTick((tick) => tick + 1);
					setAttention(false);
					send();
				}}
			/>
		) : null,
		intercept: () => {
			// Lê o ref (não o render): "Enviar mesmo assim" descarta e reenvia no mesmo clique.
			if (detected.length === 0 || dismissed.current === value) return false;
			setAttention(true);
			return true;
		},
	};
}
