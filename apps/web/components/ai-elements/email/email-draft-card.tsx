"use client";

import { PencilLineIcon } from "lucide-react";

import { ChatCard, ChatCardDetails, ChatCardHeader } from "@workspace/ui/components/chat-card";
import type { EmailSourceId } from "@workspace/shared";

import { useTranslations } from "@/lib/i18n/provider";

export type EmailDraftCardData = {
	source: EmailSourceId;
	to: readonly string[];
	cc?: readonly string[];
	subject: string;
	body: string;
	reply?: boolean;
	saved: boolean;
};

/** Mensagens curtas aparecem inteiras; as longas ficam recolhidas (nunca cortadas: abrir mostra tudo). */
const SHORT_BODY_CHARS = 420;

/**
 * Rascunho de e-mail para o dono revisar: para quem, assunto e o texto. NADA foi enviado, e o cartão diz isso. O envio é outro
 * passo, com o cartão de aprovação; aqui não há botão de enviar.
 */
export function EmailDraftCard({ source, to, cc, subject, body, reply, saved }: EmailDraftCardData) {
	const t = useTranslations();
	const text = (
		<p className="m-0 text-body whitespace-pre-wrap [overflow-wrap:anywhere]" data-testid="email-draft-body">
			{body}
		</p>
	);
	return (
		<ChatCard data-testid="email-draft-card" variant="card">
			<ChatCardHeader badge={{ tone: "muted", label: t.t("email.draft.notSent") }} leading={<PencilLineIcon />} title={reply ? t.t("email.draft.titleReply") : t.t("email.draft.title")} />
			<dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-body">
				<dt className="text-muted-foreground">{t.t("email.draft.to")}</dt>
				<dd className="m-0 [overflow-wrap:anywhere]" data-testid="email-draft-to">{to.join(", ")}</dd>
				{cc && cc.length > 0 ? (
					<>
						<dt className="text-muted-foreground">{t.t("email.draft.cc")}</dt>
						<dd className="m-0 [overflow-wrap:anywhere]">{cc.join(", ")}</dd>
					</>
				) : null}
				<dt className="text-muted-foreground">{t.t("email.draft.subject")}</dt>
				<dd className="m-0 font-medium [overflow-wrap:anywhere]">{subject}</dd>
			</dl>
			{body.length > SHORT_BODY_CHARS ? <ChatCardDetails label={t.t("email.draft.readText")}>{text}</ChatCardDetails> : text}
			<p className="m-0 text-caption text-muted-foreground" data-testid="email-draft-where">
				{saved ? t.t(source === "gmail" ? "email.draft.savedGmail" : "email.draft.savedMailbox") : t.t("email.draft.onlyHere")}
			</p>
		</ChatCard>
	);
}
