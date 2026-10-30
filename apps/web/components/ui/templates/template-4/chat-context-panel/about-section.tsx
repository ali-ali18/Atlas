"use client";

import { useRef, useState } from "react";
import { Textarea } from "@workspace/ui/components/textarea";
import { cn } from "@workspace/ui/lib/utils";

import { useT } from "@/lib/i18n/provider";

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
	const t = useT();
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
				{t("botSettings.about.title")}
			</h3>
			{editing ? (
				<Textarea
					aria-label={t("botSettings.about.label")}
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
					placeholder={t("botSettings.about.placeholder")}
					value={draft}
				/>
			) : (
				<div className="rounded-xl border border-border/60 px-3 py-2.5">
					<button
						aria-label={t("botSettings.about.edit")}
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
						{text || t("botSettings.about.add")}
					</button>
					{long ? (
						<button
							className="mt-1.5 text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
							onClick={() => setExpanded((value) => !value)}
							type="button"
						>
							{expanded ? t("botSettings.about.less") : t("botSettings.about.more")}
						</button>
					) : null}
				</div>
			)}
		</section>
	);
}
