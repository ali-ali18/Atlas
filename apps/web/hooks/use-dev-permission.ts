"use client";

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_DEV_APPROVAL_MODE, type DevApprovalMode } from "@workspace/shared";

import { listDevEnvironments, setDevApprovalDefault } from "@/lib/atlas-api";

/** Modo de aprovação de comandos da conta (o padrão dos ambientes); só carrega com as sessões de código ligadas. */
export function useDevPermission(enabled: boolean): { mode: DevApprovalMode; change: (mode: DevApprovalMode) => void } {
	const [mode, setMode] = useState<DevApprovalMode>(DEFAULT_DEV_APPROVAL_MODE);
	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		listDevEnvironments()
			.then((result) => {
				if (!cancelled && result.defaultApprovalMode) setMode(result.defaultApprovalMode);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [enabled]);
	const change = useCallback((next: DevApprovalMode) => {
		setMode((previous) => {
			void setDevApprovalDefault(next).catch(() => setMode(previous));
			return next;
		});
	}, []);
	return { mode, change };
}
