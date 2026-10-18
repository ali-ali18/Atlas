"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@workspace/ui/components/button";

import { highlightCode, TOKEN_COLORS } from "./code-highlight";

/**
 * Bloco de código dentro de markdown: cabeçalho fino (linguagem + Copiar) e corpo com realce.
 * Tolerante a bloco incompleto (streaming): só re-renderiza o texto recebido até o momento.
 */
export function MarkdownCodeBlock({ code, language }: { code: string; language?: string }) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const text = code.replace(/\n$/, "");
	const html = useMemo(() => highlightCode(text, language), [text, language]);
	useEffect(() => () => {
		if (timer.current) clearTimeout(timer.current);
	}, []);

	return (
		<div
			className="my-2 w-full min-w-0 max-w-full overflow-hidden rounded-lg border border-border/60 bg-muted/60 text-foreground"
			data-slot="code-block"
		>
			<div className="flex h-8 items-center justify-between gap-2 border-border/60 border-b bg-muted/80 pr-1 pl-3">
				<span className="truncate font-mono text-[11px] text-muted-foreground lowercase">
					{language?.trim() || "texto"}
				</span>
				<Button
					aria-label="Copiar código"
					className="size-6 text-muted-foreground"
					onClick={() => {
						void navigator.clipboard.writeText(text).then(() => {
							setCopied(true);
							if (timer.current) clearTimeout(timer.current);
							timer.current = setTimeout(() => setCopied(false), 1500);
						});
					}}
					size="icon-xs"
					type="button"
					variant="ghost"
				>
					{copied ? <CheckIcon /> : <CopyIcon />}
				</Button>
			</div>
			<pre
				className={`m-0 overflow-x-auto p-3 font-mono text-xs leading-relaxed [overflow-wrap:normal] ${TOKEN_COLORS}`}
			>
				{html ? (
					<code className="font-mono" dangerouslySetInnerHTML={{ __html: html }} />
				) : (
					<code className="font-mono">{text}</code>
				)}
			</pre>
		</div>
	);
}
