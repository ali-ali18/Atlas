"use client";

import { CircleAlertIcon, SquareTerminalIcon } from "lucide-react";
import { Spinner } from "@workspace/ui/components/spinner";
import { useState } from "react";

import { ChatCard, ChatCardDetails, ChatCardLeading } from "@workspace/ui/components/chat-card";
import { cn } from "@workspace/ui/lib/utils";

import { MarkdownCodeBlock } from "@/components/ai-elements/files/markdown-code-block";
import { formatCodeRunDuration } from "@/lib/code-run";
import { useTranslations } from "@/lib/i18n/provider";

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
	const translator = useTranslations();
	const { t } = translator;
	const [showAll, setShowAll] = useState(false);
	const lines = output.split("\n");
	const truncated = !showAll && (lines.length > OUTPUT_PREVIEW_LINES || output.length > OUTPUT_PREVIEW_CHARS);
	const shown = truncated ? lines.slice(0, OUTPUT_PREVIEW_LINES).join("\n").slice(0, OUTPUT_PREVIEW_CHARS) : output;
	const duration = durationMs !== undefined ? ` · ${formatCodeRunDuration(durationMs, translator)}` : "";
	const label = status === "running" ? t("chat.code.running") : status === "error" ? t("chat.code.failed", { duration }) : t("chat.code.ran", { duration });

	return (
		<ChatCard variant="activity" className="my-1 w-full text-xs" data-testid="code-run-card" data-status={status}>
			<ChatCardDetails
				defaultOpen={defaultOpen}
				summary={
					<span className={cn("flex min-w-0 items-center gap-2", status === "error" ? "text-destructive" : "text-muted-foreground")}>
						<ChatCardLeading className="text-current">
							{status === "running" ? <Spinner /> : status === "error" ? <CircleAlertIcon /> : <SquareTerminalIcon />}
						</ChatCardLeading>
						<span className="truncate">{label}</span>
					</span>
				}
			>
				<MarkdownCodeBlock code={code} language="python" />
				{output.trim() ? (
					<div className="min-w-0 overflow-hidden rounded-xl bg-background/60" data-testid="code-run-output">
					<div className="flex h-8 items-center pl-3 font-mono text-caption text-muted-foreground">{t("chat.code.output")}</div>
					<pre className="m-0 max-h-80 overflow-auto p-3 pt-0 font-mono text-xs leading-relaxed whitespace-pre text-foreground/90">{shown}</pre>
					{truncated ? (
						<button
							className="w-full cursor-pointer px-3 py-1.5 text-left text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
							onClick={() => setShowAll(true)}
							type="button"
						>
							{t("ui.cardSeeAll")}
						</button>
					) : null}
					</div>
				) : null}
			</ChatCardDetails>
		</ChatCard>
	);
}
