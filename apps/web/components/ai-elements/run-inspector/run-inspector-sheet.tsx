"use client";

import { ScanSearchIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { RunInspection } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@workspace/ui/components/sheet";
import { cn } from "@workspace/ui/lib/utils";

import { getRunInspection } from "@/lib/atlas-api";
import { hoverRevealClass } from "@/lib/hover-reveal";
import { copyText } from "@/components/ui/templates/template-4/chat-thread/message-reactions";

import { useTranslations } from "@/lib/i18n/provider";

import { RunInspectorView } from "./run-inspector-view";

type LoadState = { kind: "loading" } | { kind: "error" } | { kind: "ready"; inspection: RunInspection };

/** Painel lateral (tela cheia no celular) com o que o modelo recebeu em cada passo do run. */
export function RunInspectorSheet({ runId, open, onOpenChange }: { runId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
	const { t } = useTranslations();
	const [state, setState] = useState<LoadState>({ kind: "loading" });
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setState({ kind: "loading" });
		getRunInspection(runId)
			.then((body) => {
				if (!cancelled) setState({ kind: "ready", inspection: body.inspection });
			})
			.catch(() => {
				if (!cancelled) setState({ kind: "error" });
			});
		return () => {
			cancelled = true;
		};
	}, [open, runId]);

	useEffect(() => () => {
		if (timer.current) clearTimeout(timer.current);
	}, []);

	const copy = useCallback(() => {
		if (state.kind !== "ready") return;
		void copyText(JSON.stringify(state.inspection, null, 2)).then((ok) => {
			if (!ok) return;
			setCopied(true);
			if (timer.current) clearTimeout(timer.current);
			timer.current = setTimeout(() => setCopied(false), 1500);
		});
	}, [state]);

	return (
		<Sheet onOpenChange={onOpenChange} open={open}>
			<SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-xl" side="right">
				<SheetHeader>
					<SheetTitle>{t("aiElements.inspector.sheet.title")}</SheetTitle>
					<SheetDescription>{t("aiElements.inspector.sheet.description")}</SheetDescription>
				</SheetHeader>
				{state.kind === "ready" ? (
					<RunInspectorView copied={copied} inspection={state.inspection} onCopy={copy} />
				) : (
					<p className="px-4 text-muted-foreground text-sm">{state.kind === "loading" ? t("common.loading") : t("aiElements.inspector.sheet.loadError")}</p>
				)}
			</SheetContent>
		</Sheet>
	);
}

/** Botão discreto ao lado de copiar/reagir; abre o inspetor da execução que gerou a fala. */
export function RunInspectButton({ runId, className }: { runId: string; className?: string }) {
	const { t } = useTranslations();
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button aria-label={t("aiElements.inspector.sheet.title")} className={cn("shrink-0", hoverRevealClass("message"), className)} onClick={() => setOpen(true)} size="icon-xs" variant="ghost">
				<ScanSearchIcon />
			</Button>
			{open ? <RunInspectorSheet onOpenChange={setOpen} open={open} runId={runId} /> : null}
		</>
	);
}
