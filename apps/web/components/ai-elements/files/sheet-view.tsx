"use client";

import { useState } from "react";

import { cn } from "@workspace/ui/lib/utils";
import type { SheetPreview } from "@workspace/shared";

/** Tabela com abas (xlsx/csv); a primeira linha é o cabeçalho. */
export function SheetView({ sheets }: { sheets: SheetPreview[] }) {
	const [active, setActive] = useState(0);
	const sheet = sheets[active] ?? sheets[0];
	if (!sheet) return <p className="text-muted-foreground text-sm">Planilha vazia.</p>;
	const [header, ...body] = sheet.rows;
	return (
		<div className="flex min-h-0 flex-col gap-3">
			{sheets.length > 1 ? (
				<div className="flex gap-1 overflow-x-auto" role="tablist">
					{sheets.map((item, index) => (
						<button
							aria-selected={index === active}
							className={cn(
								"rounded-md px-3 py-1 text-xs",
								index === active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
							)}
							key={item.name}
							onClick={() => setActive(index)}
							role="tab"
							type="button"
						>
							{item.name}
						</button>
					))}
				</div>
			) : null}
			<div className="overflow-auto rounded-lg border">
				<table className="w-full border-collapse text-sm">
					{header ? (
						<thead className="sticky top-0 bg-muted">
							<tr>
								{header.map((cell, i) => (
									<th className="border-b px-3 py-1.5 text-left font-medium" key={i}>{cell}</th>
								))}
							</tr>
						</thead>
					) : null}
					<tbody>
						{body.map((row, r) => (
							<tr className="odd:bg-muted/30" key={r}>
								{row.map((cell, c) => (
									<td className="border-b px-3 py-1.5 align-top" key={c}>{cell}</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{sheet.truncated ? (
				<p className="text-muted-foreground text-xs">Mostrando as primeiras 500 linhas. Baixe o arquivo para ver tudo.</p>
			) : null}
		</div>
	);
}
