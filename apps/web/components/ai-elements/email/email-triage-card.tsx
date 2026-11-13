"use client";

import { CalendarClockIcon, MailCheckIcon } from "lucide-react";

import { ChatCard, ChatCardDetails, ChatCardHeader } from "@workspace/ui/components/chat-card";
import { EMAIL_TRIAGE_CATEGORIES, countEmailTriage, sortEmailTriage, type EmailTriageCategory, type EmailTriageEntry } from "@workspace/shared";

import { useFormat } from "@/lib/use-format";
import { useTranslations } from "@/lib/i18n/provider";

/** Quantos de cada grupo aparecem antes do "Ver tudo (n)" (só "Ignorar" nasce recolhido). */
const COLLAPSED_GROUP: EmailTriageCategory = "ignore";

/** Triagem do e-mail: o que o bot DECLAROU para cada mensagem (precisa de ação, só pra saber, ignorar), com prazo e quem pede. Só mostra. */
export function EmailTriageCard({ items }: { items: readonly EmailTriageEntry[] }) {
	const t = useTranslations();
	const sorted = sortEmailTriage(items);
	const counts = countEmailTriage(sorted);
	const badge = counts.needs_action > 0 ? ({ tone: "pending", label: t.tn("email.triage.needsActionCount", counts.needs_action) } as const) : ({ tone: "muted", label: t.t("email.triage.nothingToDo") } as const);
	return (
		<ChatCard data-testid="email-triage-card" variant="card">
			<ChatCardHeader badge={badge} leading={<MailCheckIcon />} title={t.t("email.triage.title")} />
			<div className="flex min-w-0 flex-col gap-3">
				{EMAIL_TRIAGE_CATEGORIES.map((category) => {
					const group = sorted.filter((item) => item.category === category);
					if (group.length === 0) return null;
					const list = <TriageList items={group} />;
					return (
						<section aria-label={t.t(`email.triage.group.${category}`)} className="flex min-w-0 flex-col gap-1.5" data-category={category} key={category}>
							<h4 className="m-0 text-caption font-medium text-muted-foreground uppercase">
								{t.t(`email.triage.group.${category}`)} · {group.length}
							</h4>
							{category === COLLAPSED_GROUP ? <ChatCardDetails label={t.t("email.triage.seeAll", { count: group.length })}>{list}</ChatCardDetails> : list}
						</section>
					);
				})}
			</div>
		</ChatCard>
	);
}

function TriageList({ items }: { items: readonly EmailTriageEntry[] }) {
	return (
		<ul className="m-0 flex list-none flex-col gap-2 p-0">
			{items.map((item) => (
				<TriageRow item={item} key={`${item.source ?? ""}:${item.id}`} />
			))}
		</ul>
	);
}

function TriageRow({ item }: { item: EmailTriageEntry }) {
	const t = useTranslations();
	const f = useFormat();
	const deadline = item.deadline ? (item.deadline.length === 10 ? f.date(item.deadline, { timeZone: "UTC", day: "numeric", month: "short" }) : f.dateTime(item.deadline, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })) : null;
	const who = item.requester ?? item.from;
	return (
		<li className="flex min-w-0 flex-col gap-0.5" data-testid="email-triage-item">
			<p className="m-0 text-body font-medium [overflow-wrap:anywhere]">{item.subject ?? item.summary}</p>
			{item.subject ? <p className="m-0 text-body [overflow-wrap:anywhere]">{item.summary}</p> : null}
			{deadline || who ? (
				<p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-caption text-muted-foreground">
					{deadline ? (
						<span className="inline-flex items-center gap-1" data-testid="email-triage-deadline">
							<CalendarClockIcon aria-hidden className="size-3.5" />
							{t.t("email.triage.deadline", { date: deadline })}
						</span>
					) : null}
					{who ? <span className="[overflow-wrap:anywhere]">{item.requester ? t.t("email.triage.askedBy", { who }) : t.t("email.triage.from", { who })}</span> : null}
				</p>
			) : null}
		</li>
	);
}
