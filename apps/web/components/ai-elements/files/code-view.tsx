"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useMemo, useState } from "react";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

import { Button } from "@workspace/ui/components/button";
import { useT } from "@/lib/i18n/provider";

const LANGUAGES = { bash, css, go, java, javascript, json, markdown, python, sql, typescript, xml, yaml };
for (const [name, definition] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, definition);
const ALIASES: Record<string, string> = { jsx: "javascript", tsx: "typescript", html: "xml" };

const TOKEN_COLORS =
	"[&_.hljs-keyword]:text-violet-400 [&_.hljs-built_in]:text-sky-400 [&_.hljs-string]:text-emerald-400 [&_.hljs-number]:text-amber-400 [&_.hljs-comment]:text-muted-foreground [&_.hljs-title]:text-blue-400 [&_.hljs-attr]:text-sky-400 [&_.hljs-literal]:text-amber-400";

/** Bloco de código com destaque de sintaxe e botão de copiar. */
export function CodeView({ text, language }: { text: string; language: string }) {
	const t = useT();
	const [copied, setCopied] = useState(false);
	// highlight.js escapa o texto de entrada: o HTML gerado só tem <span class="hljs-*">.
	const html = useMemo(() => {
		const name = ALIASES[language] ?? language;
		if (!hljs.getLanguage(name)) return null;
		return hljs.highlight(text, { language: name, ignoreIllegals: true }).value;
	}, [text, language]);

	return (
		<div className="relative">
			<Button
				aria-label={t("aiElements.files.copyContent")}
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
