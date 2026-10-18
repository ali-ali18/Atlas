"use client";

import { ChevronDownIcon, CircleAlertIcon, Loader2Icon, SquareTerminalIcon } from "lucide-react";
import { useId, useState } from "react";

import { cn } from "@workspace/ui/lib/utils";

import { MarkdownCodeBlock } from "@/components/ai-elements/files/markdown-code-block";
import { formatCodeRunDuration } from "@/lib/code-run";

const OUTPUT_PREVIEW_LINES = 12;
const OUTPUT_PREVIEW_CHARS = 1200;

export type CodeRunCardProps = {
	code: string;
	status: "running" | "ok" | "error";
	durationMs?: number;
	output?: string;
	defaultOpen?: boolean;
};

/** Linha recolhível "Executou código · 1,2 s" com o Python e a saída; abre para conferir o que rodou. */
export function CodeRunCard({ code, status, durationMs, output = "", defaultOpen = false }: CodeRunCardProps) {
	const [open, setOpen] = useState(defaultOpen);
	const [showAll, setShowAll] = useState(false);
	const panelId = useId();
	const lines = output.split("\n");
	const truncated = !showAll && (lines.length > OUTPUT_PREVIEW_LINES || output.length > OUTPUT_PREVIEW_CHARS);
	const shown = truncated ? lines.slice(0, OUTPUT_PREVIEW_LINES).join("\n").slice(0, OUTPUT_PREVIEW_CHARS) : output;
	const duration = durationMs !== undefined ? ` · ${formatCodeRunDuration(durationMs)}` : "";
	const label = status === "running" ? "Executando código…" : status === "error" ? `Falhou${duration}` : `Executou código${duration}`;

	return (
		<div className="my-1 w-full min-w-0 max-w-[min(68ch,100%)] text-xs" data-testid="code-run-card" data-status={status}>
			<button
				aria-controls={panelId}
				aria-expanded={open}
				className={cn(
					"inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md py-1 pr-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
					status === "error" ? "text-destructive/80 hover:text-destructive" : "text-muted-foreground hover:text-foreground",
				)}
				onClick={() => setOpen((value) => !value)}
				type="button"
			>
				{status === "running" ? (
					<Loader2Icon className="size-3.5 shrink-0 motion-safe:animate-spin" />
				) : status === "error" ? (
					<CircleAlertIcon className="size-3.5 shrink-0" />
				) : (
					<SquareTerminalIcon className="size-3.5 shrink-0" />
				)}
				<span className="truncate">{label}</span>
				<ChevronDownIcon className={cn("size-3.5 shrink-0 transition-transform", open ? "rotate-180" : "")} />
			</button>
			{open ? (
				<div className="mt-1 min-w-0" id={panelId}>
					<MarkdownCodeBlock code={code} language="python" />
					{output.trim() ? (
						<div className="mt-2 min-w-0 overflow-hidden rounded-lg border border-border/60 bg-muted/60" data-testid="code-run-output">
							<div className="flex h-8 items-center border-border/60 border-b bg-muted/80 pl-3 font-mono text-[11px] text-muted-foreground">
								saída
							</div>
							<pre className="m-0 max-h-80 overflow-auto p-3 font-mono text-xs leading-relaxed whitespace-pre text-foreground/90">{shown}</pre>
							{truncated ? (
								<button
									className="w-full cursor-pointer border-border/60 border-t px-3 py-1.5 text-left text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
									onClick={() => setShowAll(true)}
									type="button"
								>
									mostrar tudo
								</button>
							) : null}
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}
