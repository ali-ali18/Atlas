"use client";

import { useMemo, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import type { McpConnectionView } from "@workspace/shared";
import { hasIrreversibleToolName, hasServerToolAnnotation, pendingToolMarkSuggestions, toolDisplayLabel, toolMarkRefusal, type ToolMark } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@workspace/ui/components/item";
import { Switch } from "@workspace/ui/components/switch";
import { cn } from "@workspace/ui/lib/utils";
import { updateMcpConnection } from "@/lib/atlas-api";
import { useTranslations } from "@/lib/i18n/provider";

/**
 * "Consultas sem aprovação": o dono marca o que só lê. A sugestão automática vem pré-marcada, mas só vale depois de
 * "Confirmar" (uma vez). Tool que o servidor já anota não aparece aqui: a anotação vence. Recolhida por padrão.
 */
export function ToolMarksSection({ connection, onChanged, defaultOpen = false }: { connection: McpConnectionView; onChanged: (connection: McpConnectionView) => void; defaultOpen?: boolean }) {
	const { t, tn } = useTranslations();
	const [open, setOpen] = useState(defaultOpen);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const confirmed = connection.toolMarks ?? {};
	// Servidor mudou a descrição ou o schema da tool: a marca antiga não vale e o dono confirma de novo.
	const stale = connection.staleToolMarks ?? [];
	const editable = useMemo(
		() => connection.tools.filter((tool) => !hasServerToolAnnotation(tool) && !connection.disabledTools.includes(tool.name)),
		[connection.tools, connection.disabledTools],
	);
	const suggestions = useMemo(() => pendingToolMarkSuggestions(connection.tools, confirmed, connection.disabledTools), [connection.tools, confirmed, connection.disabledTools]);
	const pendingNames = Object.keys(suggestions);
	// Só as sugeridas como leitura contam como "sugestão"; o resto fica como escrita até o dono mudar.
	const suggestedRead = pendingNames.filter((name) => suggestions[name] === "read");
	// Rascunho só das pendentes (pré-marcadas com a sugestão); as já confirmadas salvam na hora.
	const [draft, setDraft] = useState<Record<string, ToolMark>>({});
	if (editable.length === 0) return null;

	const markOf = (name: string): ToolMark => draft[name] ?? confirmed[name] ?? suggestions[name] ?? "write";

	async function save(marks: Record<string, ToolMark>) {
		setBusy(true);
		setError(null);
		try {
			onChanged(await updateMcpConnection(connection.id, { toolMarks: marks }));
			setDraft({});
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("marketplace.marks.saveError"));
		} finally {
			setBusy(false);
		}
	}

	function toggle(name: string, readOnly: boolean) {
		const mark: ToolMark = readOnly ? "read" : "write";
		if (pendingNames.includes(name)) setDraft((current) => ({ ...current, [name]: mark }));
		else void save({ [name]: mark });
	}

	return (
		<Collapsible onOpenChange={setOpen} open={open}>
			<section className="rounded-xl border" data-tool-marks>
				<CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
					<ChevronDownIcon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
					<span className="min-w-0 flex-1 text-body font-medium">{t("marketplace.marks.title")}</span>
					{suggestedRead.length > 0 ? (
						<span className="shrink-0 rounded-full bg-info/10 px-2 py-0.5 text-caption text-info">{tn("marketplace.marks.pending", suggestedRead.length)}</span>
					) : null}
				</CollapsibleTrigger>
				<CollapsibleContent className="space-y-2 border-t p-3">
					<p className="text-caption text-muted-foreground">{t("marketplace.marks.hint")}</p>
					{pendingNames.length > 0 ? (
						<div className="flex flex-wrap items-center justify-between gap-2 rounded-card bg-muted/60 p-2">
							<p className="min-w-0 flex-1 text-caption text-muted-foreground">{t("marketplace.marks.suggestionNote")}</p>
							<Button
								disabled={busy}
								onClick={() => void save(Object.fromEntries(pendingNames.map((name) => [name, markOf(name)])))}
								size="sm"
								type="button"
							>
								{busy ? t("marketplace.marks.confirming") : t("marketplace.marks.confirm")}
							</Button>
						</div>
					) : null}
					{error ? <p className="text-caption text-destructive" role="alert">{error}</p> : null}
					<ItemGroup>
						{editable.map((tool) => {
							const label = toolDisplayLabel(tool);
							return (
								<Item data-tool-mark={tool.name} key={tool.name} size="sm">
									<ItemContent>
										<ItemTitle className="break-words">
											{label}
											{suggestedRead.includes(tool.name) ? <span className="text-caption font-normal text-muted-foreground">· {t("marketplace.marks.suggested")}</span> : null}
										</ItemTitle>
										{tool.description ? <ItemDescription className="line-clamp-2">{tool.description}</ItemDescription> : null}
										{toolMarkRefusal(tool) !== null ? <p className="text-caption text-warning">{t(hasIrreversibleToolName(tool.name) ? "marketplace.marks.alwaysAsks" : "marketplace.marks.notReadName")}</p> : null}
										{stale.includes(tool.name) ? <p className="text-caption text-warning" data-tool-mark-changed>{t("marketplace.marks.changed")}</p> : null}
									</ItemContent>
									<ItemActions>
										<span className="text-caption text-muted-foreground">{t("marketplace.marks.readOnly")}</span>
										<Switch
											aria-label={t("marketplace.marks.readOnlyOf", { name: label })}
											checked={markOf(tool.name) === "read"}
											disabled={busy || toolMarkRefusal(tool) !== null}
											onCheckedChange={(checked) => toggle(tool.name, checked)}
											size="sm"
										/>
									</ItemActions>
								</Item>
							);
						})}
					</ItemGroup>
				</CollapsibleContent>
			</section>
		</Collapsible>
	);
}
