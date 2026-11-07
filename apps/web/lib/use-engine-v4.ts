"use client";

import { useEffect, useState } from "react";
import type { AccountSettingsResponse } from "@workspace/shared";
import { getAccountSettings } from "@/lib/atlas-api";

/** O Motor v4 está ligado para esta conta? Sinal estrutural do servidor (`capabilities.engineV4`); ausente = desligado. */
export function isEngineV4On(settings: Pick<AccountSettingsResponse, "capabilities"> | null | undefined): boolean {
	return settings?.capabilities?.engineV4 === true;
}

/** Quanto tempo a resposta vale. Curto o bastante para a troca de conta ou de configuração aparecer sem recarregar. */
export const ENGINE_V4_TTL_MS = 60_000;

let cached: { value: Promise<boolean>; at: number } | null = null;

/**
 * O mesmo sinal serve todas as seções que dependem do v4 (Caderno, Agenda), sem chamada extra por bot. Vale por
 * `ENGINE_V4_TTL_MS` e é esquecido ao sair da conta (`resetEngineV4Cache`). Falha = desligado, sem guardar. O relógio é injetável.
 */
export function loadEngineV4(load: () => Promise<Pick<AccountSettingsResponse, "capabilities">> = getAccountSettings, now: number = Date.now()): Promise<boolean> {
	if (cached && now - cached.at < ENGINE_V4_TTL_MS) return cached.value;
	const entry = {
		at: now,
		value: load()
			.then(isEngineV4On)
			.catch(() => {
				if (cached === entry) cached = null;
				return false;
			}),
	};
	cached = entry;
	return entry.value;
}

/** Esquece a consulta guardada: ao sair da conta e nos testes. */
export function resetEngineV4Cache(): void {
	cached = null;
}

/** `false` até o servidor responder (nada de seção piscando) e quando o v4 está desligado. */
export function useEngineV4(): boolean {
	const [on, setOn] = useState(false);
	useEffect(() => {
		let alive = true;
		void loadEngineV4().then((value) => {
			if (alive) setOn(value);
		});
		return () => {
			alive = false;
		};
	}, []);
	return on;
}
