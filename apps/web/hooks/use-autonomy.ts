"use client";

import { useCallback, useEffect, useState } from "react";
import type { AutonomyUpdateInput, AutonomyView } from "@workspace/shared";
import type { McpConnectionView } from "@workspace/shared";
import {
	getAccountAutonomy,
	getBotAutonomy,
	listMcpConnections,
	updateAccountAutonomy,
	updateBotAutonomy,
} from "@/lib/atlas-api";
import { activeT } from "@/lib/i18n/active";

/**
 * Autonomia de um escopo (conta ou bot) + conectores para nomear as
 * exceções. Cada mudança salva na hora e devolve a visão atualizada.
 */
export function useAutonomy(scope: "account" | "bot", botId?: string) {
	const [view, setView] = useState<AutonomyView | null>(null);
	const [connections, setConnections] = useState<McpConnectionView[]>([]);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		const load =
			scope === "bot" && botId ? getBotAutonomy(botId) : getAccountAutonomy();
		Promise.all([load, listMcpConnections().catch(() => [])])
			.then(([nextView, nextConnections]) => {
				if (cancelled) return;
				setView(nextView);
				setConnections(nextConnections);
			})
			.catch((cause) => {
				if (cancelled) return;
				setError(
					cause instanceof Error
						? cause.message
						: activeT("errors.loadAutonomy"),
				);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [scope, botId]);

	const save = useCallback(
		async (update: AutonomyUpdateInput) => {
			setSaving(true);
			setError(null);
			try {
				setView(
					scope === "bot" && botId
						? await updateBotAutonomy(botId, update)
						: await updateAccountAutonomy(update),
				);
			} catch (cause) {
				setError(
					cause instanceof Error
						? cause.message
						: activeT("errors.saveAutonomy"),
				);
			} finally {
				setSaving(false);
			}
		},
		[scope, botId],
	);

	return { view, connections, loading, saving, error, save };
}
