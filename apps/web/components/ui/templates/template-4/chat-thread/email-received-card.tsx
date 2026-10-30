"use client";

import { MailIcon } from "lucide-react";
import { useState } from "react";
import { ChatCard, ChatCardHeader, ChatCardToggle } from "@workspace/ui/components/chat-card";
import { Collapsible } from "@workspace/ui/components/collapsible";
import { useT } from "@/lib/i18n/provider";

const COLLAPSED_CHARS = 420;

/**
 * E-mail recebido pelo bot, na conversa: quem escreveu, assunto e o texto (recolhido quando é longo).
 * O texto é de fora: o bot o trata como dado, nunca como instrução, e o cartão diz isso em palavras simples.
 */
export function EmailReceivedCard({ from, subject, text }: { from: string; subject: string; text: string }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const long = text.length > COLLAPSED_CHARS;
	const shown = !long || open ? text : `${text.slice(0, COLLAPSED_CHARS).trimEnd()}…`;
	return (
		<ChatCard aria-label={t("chat.email.ariaLabel", { subject: subject || t("chat.email.noSubject") })} className="self-start" data-testid="email-received-card">
			<ChatCardHeader leading={<MailIcon />} title={t("chat.email.received")} />
			<p className="m-0 truncate text-muted-foreground text-xs" title={from}>
				{t("chat.email.from", { from })}
			</p>
			<p className="m-0 break-words font-medium text-sm leading-snug">{subject || `(${t("chat.email.noSubject")})`}</p>
			<p className="m-0 break-words text-sm leading-relaxed whitespace-pre-wrap text-foreground/90">{shown}</p>
			{long ? (
				<Collapsible onOpenChange={setOpen} open={open}>
					<ChatCardToggle className="-ml-1" label={t("ui.cardSeeAll")} open={open} openLabel={t("ui.cardLess")} />
				</Collapsible>
			) : null}
			<p className="m-0 text-muted-foreground text-xs leading-relaxed">{t("chat.email.untrusted")}</p>
		</ChatCard>
	);
}
