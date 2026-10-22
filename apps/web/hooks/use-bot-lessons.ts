"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { connectorScopeKey, isReadOnlyMcpTool, mcpToolName, type LessonRule, type LessonView } from "@workspace/shared";
import { clearBotLessonRule, deleteBotLesson, editBotLesson, listApiConnections, listBotLessons, listMcpConnections, restoreBotLesson, setBotLessonRule } from "@/lib/atlas-api";
import type { LessonToolOption } from "@/components/ui/templates/template-4/chat-context-panel/lessons-tab-helpers";

function messageOf(cause: unknown, fallback: string): string {
	return cause instanceof Error && cause.message ? cause.message : fallback;
}

/**
 * Aba Lições: as lições ativas do bot e as ações (editar, apagar, restaurar a versão anterior). Recarrega ao abrir
 * a aba e depois de cada ação. Os nomes dos conectores vêm das conexões (melhor esforço: sem nome, o grupo diz só "Conector").
 */
export function useBotLessons(botId: string, active: boolean) {
	const [lessons, setLessons] = useState<LessonView[]>([]);
	const [names, setNames] = useState<Record<string, string>>({});
	const [tools, setTools] = useState<LessonToolOption[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const request = useRef(0);

	const refresh = useCallback(async () => {
		const id = ++request.current;
		try {
			const next = await listBotLessons(botId);
			if (id !== request.current) return;
			setLessons(next);
			setError(null);
		} catch (cause) {
			if (id !== request.current) return;
			setError(messageOf(cause, "Não foi possível carregar as lições."));
		} finally {
			if (id === request.current) setLoading(false);
		}
	}, [botId]);

	useEffect(() => {
		setLessons([]);
		setLoading(true);
		setError(null);
	}, [botId]);

	useEffect(() => {
		if (!active) return;
		void refresh();
	}, [active, refresh]);

	useEffect(() => {
		if (!active) return;
		let cancelled = false;
		void Promise.allSettled([listMcpConnections(), listApiConnections()]).then(([mcp, api]) => {
			if (cancelled) return;
			const map: Record<string, string> = {};
			if (mcp.status === "fulfilled") for (const connection of mcp.value) map[`mcp:${connection.id}`] = connection.name;
			// Seletor da regra: as ferramentas dos conectores ligados, com o nome exposto ao bot.
			const options: LessonToolOption[] = [];
			if (mcp.status === "fulfilled") {
				for (const connection of mcp.value) {
					if (connection.status !== "connected") continue;
					const key = connectorScopeKey("mcp", connection.id);
					for (const tool of connection.tools) {
						if (connection.disabledTools.includes(tool.name)) continue;
						options.push({ value: mcpToolName(connection.slug, tool.name), label: `${tool.title ?? tool.name}${isReadOnlyMcpTool(tool) ? " (leitura)" : ""}`, group: connection.name, connectorKey: key });
					}
				}
			}
			setTools(options);
			if (api.status === "fulfilled") for (const connection of api.value) map[`api:${connection.id}`] = connection.name;
			setNames(map);
		});
		return () => {
			cancelled = true;
		};
	}, [active]);

	/** Roda a ação e recarrega; devolve a mensagem de erro (para mostrar inline) ou null. */
	const act = useCallback(
		async (run: () => Promise<unknown>, fallback: string): Promise<string | null> => {
			try {
				await run();
			} catch (cause) {
				return messageOf(cause, fallback);
			}
			await refresh();
			return null;
		},
		[refresh],
	);

	const edit = useCallback((lessonId: string, content: string) => act(() => editBotLesson(lessonId, content), "Não foi possível salvar."), [act]);
	const remove = useCallback((lessonId: string) => act(() => deleteBotLesson(lessonId), "Não foi possível apagar."), [act]);
	const restore = useCallback((lessonId: string) => act(() => restoreBotLesson(lessonId), "Não foi possível restaurar."), [act]);

	const setRule = useCallback((lessonId: string, rule: LessonRule | null) => act(() => (rule ? setBotLessonRule(lessonId, rule) : clearBotLessonRule(lessonId)), "Não foi possível salvar a regra."), [act]);

	return { lessons, names, tools, loading, error, refresh, edit, remove, restore, setRule };
}
