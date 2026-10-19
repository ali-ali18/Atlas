"use client";

import { MailIcon, ShieldAlertIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@workspace/ui/components/button";

const COLLAPSED_CHARS = 420;

/**
 * E-mail recebido pelo bot, na conversa: quem escreveu, assunto e o texto (recolhido quando é longo).
 * O texto é de fora: o bot o trata como dado, nunca como instrução, e o cartão diz isso.
 */
export function EmailReceivedCard({ from, subject, text }: { from: string; subject: string; text: string }) {
	const [open, setOpen] = useState(false);
	const long = text.length > COLLAPSED_CHARS;
	const shown = !long || open ? text : `${text.slice(0, COLLAPSED_CHARS).trimEnd()}…`;
	return (
		<article
			aria-label={`E-mail recebido: ${subject || "sem assunto"}`}
			className="flex w-full min-w-0 max-w-[min(100%,34rem)] flex-col gap-2.5 self-start rounded-2xl border border-border bg-card p-3.5"
			data-testid="email-received-card"
		>
			<header className="flex min-w-0 items-center gap-2.5">
				<span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
					<MailIcon className="size-3.5" />
				</span>
				<div className="min-w-0 flex-1">
					<p className="text-muted-foreground text-xs">E-mail recebido</p>
					<p className="truncate text-sm" title={from}>
						{from}
					</p>
				</div>
			</header>
			<p className="break-words font-medium text-sm leading-snug">{subject || "(sem assunto)"}</p>
			<p className="break-words text-sm leading-relaxed whitespace-pre-wrap text-foreground/90">{shown}</p>
			{long ? (
				<Button className="w-fit" onClick={() => setOpen((value) => !value)} size="xs" variant="ghost">
					{open ? "Mostrar menos" : "Ver tudo"}
				</Button>
			) : null}
			<p className="flex items-start gap-1.5 border-border border-t pt-2.5 text-muted-foreground text-xs leading-relaxed">
				<ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0" />
				Conteúdo de fora: o bot lê como dado, não como instrução.
			</p>
		</article>
	);
}
