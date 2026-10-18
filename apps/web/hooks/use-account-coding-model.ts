"use client";

import { useEffect, useState } from "react";
import { getAccountSettings } from "@/lib/atlas-api";

let cached: string | undefined;

/**
 * "Modelo para código" escolhido nas configurações da conta (`undefined` = nenhum).
 * Relê quando `refreshKey` muda; falha de rede = nenhum (o bot herda o modelo normal).
 */
export function useAccountCodingModel(refreshKey?: unknown): string | undefined {
	const [model, setModel] = useState<string | undefined>(cached);
	useEffect(() => {
		let cancelled = false;
		getAccountSettings()
			.then((view) => {
				cached = view.effective.models.coding.value;
				if (!cancelled) setModel(cached);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [refreshKey]);
	return model;
}
