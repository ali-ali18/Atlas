"use client";

import { useEffect, useState } from "react";

import { listDevEnvironments } from "@/lib/atlas-api";

let cached: Promise<boolean> | null = null;

/** As sessões de código estão ligadas neste servidor? (uma consulta por carregamento da página). */
export function useDevSessionsEnabled(): boolean {
	const [enabled, setEnabled] = useState(false);
	useEffect(() => {
		let cancelled = false;
		cached ??= listDevEnvironments()
			.then((result) => result.devSessionsEnabled === true)
			.catch(() => {
				cached = null;
				return false;
			});
		void cached.then((value) => {
			if (!cancelled) setEnabled(value);
		});
		return () => {
			cancelled = true;
		};
	}, []);
	return enabled;
}
