"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@workspace/ui/components/button";

import { highlightCode, TOKEN_COLORS } from "./code-highlight";

/** Bloco de código com destaque de sintaxe e botão de copiar. */
export function CodeView({ text, language }: { text: string; language: string }) {
	const [copied, setCopied] = useState(false);
	// highlight.js escapa o texto de entrada: o HTML gerado só tem <span class="hljs-*">.
	const html = useMemo(() => highlightCode(text, language), [text, language]);

	return (
		<div className="relative">
			<Button
				aria-label="Copiar conteúdo"
				className="absolute top-2 right-2"
				onClick={() => {
					void navigator.clipboard.writeText(text).then(() => {
						setCopied(true);
						setTimeout(() => setCopied(false), 1500);
					});
				}}
				size="icon-sm"
				type="button"
				variant="ghost"
			>
				{copied ? <CheckIcon /> : <CopyIcon />}
			</Button>
			<pre className={`overflow-auto rounded-lg bg-muted p-4 font-mono text-xs leading-relaxed ${TOKEN_COLORS}`}>
				{html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{text}</code>}
			</pre>
		</div>
	);
}
