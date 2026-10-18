"use client";

import { useEffect, useState } from "react";
import { getAccountSettings } from "@/lib/atlas-api";

let cached: string | undefined;

/**
 * Fuso horário escolhido nas configurações da conta (`undefined` = automático).
 * Busca de novo quando `refreshKey` muda (ex.: o painel do bot voltou a abrir),
 * mostrando o último valor enquanto isso. Falha de rede = sem fuso (vale o do bot).
 */
export function useAccountTimezone(refreshKey?: unknown): string | undefined {
	const [timezone, setTimezone] = useState<string | undefined>(cached);
	useEffect(() => {
		let cancelled = false;
		getAccountSettings()
			.then((view) => {
				cached = view.effective.general.timezone.value;
				if (!cancelled) setTimezone(cached);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [refreshKey]);
	return timezone;
}
