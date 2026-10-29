"use client";

import { useRef, useState } from "react";
import { Textarea } from "@workspace/ui/components/textarea";
import { cn } from "@workspace/ui/lib/utils";

const CLAMP_FROM = 240;

/**
 * "Sobre": a descrição do bot, editada ali mesmo (clique no texto), sem tela de configurações.
 * Salva ao sair do campo; Esc cancela. Texto longo fica recolhido com "Mostrar mais".
 */
export function AboutSection({
	description,
	onChange,
}: {
	description: string | undefined;
	onChange: (description: string) => void;
}) {
	const text = description ?? "";
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(text);
	const [expanded, setExpanded] = useState(false);
	const doneRef = useRef(false);

	function commit() {
		if (doneRef.current) return;
		doneRef.current = true;
		setEditing(false);
		const next = draft.trim();
		if (next !== text.trim()) onChange(next);
	}

	const long = text.length > CLAMP_FROM;
	return (
		<section aria-labelledby="info-pane-about" className="space-y-2" data-about>
			<h3 className="font-medium text-muted-foreground text-xs" id="info-pane-about">
				Sobre
			</h3>
			{editing ? (
				<Textarea
					aria-label="Descrição do bot"
					autoFocus
					className="min-h-24 rounded-xl text-body"
					onBlur={commit}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							doneRef.current = true;
							setDraft(text);
							setEditing(false);
						}
					}}
					placeholder="Descreva o que este bot faz"
					value={draft}
				/>
			) : (
				<div className="rounded-xl border border-border/60 px-3 py-2.5">
					<button
						aria-label="Editar descrição do bot"
						className={cn(
							"w-full whitespace-pre-wrap break-words rounded-md text-left text-body leading-[18px] outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
							text ? "" : "text-muted-foreground",
							long && !expanded && "line-clamp-6",
						)}
						onClick={() => {
							setDraft(text);
							doneRef.current = false;
							setEditing(true);
						}}
						type="button"
					>
						{text || "Adicionar uma descrição"}
					</button>
					{long ? (
						<button
							className="mt-1.5 text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
							onClick={() => setExpanded((value) => !value)}
							type="button"
						>
							{expanded ? "Mostrar menos" : "Mostrar mais"}
						</button>
					) : null}
				</div>
			)}
		</section>
	);
}
