"use client";

import {
	CodeBlock,
	CodeBlockActions,
	CodeBlockContent,
	CodeBlockCopyButton,
	CodeBlockHeader,
	CodeBlockLine,
	CodeBlockTitle,
} from "@workspace/ui/components/code-block";
import { useHighlightedCode } from "@workspace/ui/hooks/use-highlighted-code";
import { createContext, useContext } from "react";

import { resolveChartFence } from "../chart/chart-fence";
import { ChartPlaceholder, LazyChart } from "../chart/lazy-chart";

/** O texto que contém o bloco ainda está chegando (streaming): um bloco ```chart incompleto é "Gerando gráfico…". */
export const MarkdownStreamingContext = createContext(false);

/**
 * Bloco de código dentro de markdown (shadcn Code Block + Shiki): título com a linguagem à
 * esquerda, Copiar à direita. O realce é incremental (só as linhas novas), então o streaming
 * de um bloco ainda aberto não pisca; sem linguagem (ou desconhecida) fica texto plano.
 */
export function MarkdownCodeBlock({ code, language }: { code: string; language?: string }) {
	const streaming = useContext(MarkdownStreamingContext);
	if (language?.trim().toLowerCase() === "chart") return <ChartFenceBlock code={code} streaming={streaming} />;
	return <PlainCodeBlock code={code} language={language} />;
}

function ChartFenceBlock({ code, streaming }: { code: string; streaming: boolean }) {
	const fence = resolveChartFence(code, streaming);
	if (fence.kind === "chart") return <LazyChart spec={fence.spec} />;
	if (fence.kind === "pending") return <ChartPlaceholder />;
	return (
		<>
			<PlainCodeBlock code={code} language="chart" />
			<p className="-mt-1 mb-2 text-muted-foreground text-xs" data-testid="chart-invalid">
				Não foi possível desenhar o gráfico: o JSON está incompleto ou inválido.
			</p>
		</>
	);
}

function PlainCodeBlock({ code, language }: { code: string; language?: string }) {
	const text = code.replace(/\n$/, "");
	const lang = language?.trim() ?? "";
	const lines = useHighlightedCode(text, lang);

	return (
		<CodeBlock className="my-2 max-w-full bg-muted/60" size="sm">
			<CodeBlockHeader className="items-center justify-between pt-1.5 pr-1.5">
				<CodeBlockTitle className="font-mono text-caption font-normal text-muted-foreground lowercase">
					{lang || "texto"}
				</CodeBlockTitle>
				<CodeBlockActions className="m-0">
					<CodeBlockCopyButton value={text} />
				</CodeBlockActions>
			</CodeBlockHeader>
			<CodeBlockContent className="text-xs">
				{lines.map((line, index) => (
					<CodeBlockLine key={index}>{line}</CodeBlockLine>
				))}
			</CodeBlockContent>
		</CodeBlock>
	);
}
