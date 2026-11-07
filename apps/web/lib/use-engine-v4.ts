"use client";

import { useEffect, useState } from "react";
import type { AccountSettingsResponse } from "@workspace/shared";
import { getAccountSettings } from "@/lib/atlas-api";

/** O Motor v4 está ligado para esta conta? Sinal estrutural do servidor (`capabilities.engineV4`); ausente = desligado. */
export function isEngineV4On(settings: Pick<AccountSettingsResponse, "capabilities"> | null | undefined): boolean {
	return settings?.capabilities?.engineV4 === true;
}

let cached: Promise<boolean> | null = null;

/** Uma consulta por carga da página, dividida entre todas as seções que dependem do v4 (Caderno, Agenda). Falha = desligado. */
export function loadEngineV4(load: () => Promise<Pick<AccountSettingsResponse, "capabilities">> = getAccountSettings): Promise<boolean> {
	cached ??= load()
		.then(isEngineV4On)
		.catch(() => {
			cached = null;
			return false;
		});
	return cached;
}

/** Só para teste: esquece a consulta guardada. */
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
