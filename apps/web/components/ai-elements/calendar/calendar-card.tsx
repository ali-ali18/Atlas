"use client";

import { AlertTriangleIcon, CalendarCheckIcon, CalendarClockIcon, CalendarDaysIcon, ExternalLinkIcon, MailIcon } from "lucide-react";

import { Button } from "@workspace/ui/components/button";
import { ChatCard, ChatCardActions, ChatCardHeader } from "@workspace/ui/components/chat-card";
import type { CalendarCardAction, CalendarCardEvent } from "@workspace/shared";

import { useFormat } from "@/lib/use-format";
import { useTranslations } from "@/lib/i18n/provider";

import { safeHttpUrl } from "../shopping/safe-image";

export type CalendarCardData = {
	action: CalendarCardAction;
	timeZone: string;
	events: readonly CalendarCardEvent[];
	more?: number | undefined;
	notified?: boolean | undefined;
};

/** Dia de calendário (AAAA-MM-DD) sem passar por fuso: o dia inteiro é uma data, não um instante. */
const dateOnly = (iso: string) => new Date(`${iso}T12:00:00Z`);

/** Evento criado/alterado ou os compromissos de um período do Google Agenda. Só mostra; não age. */
export function CalendarCard({ action, timeZone, events, more, notified }: CalendarCardData) {
	const t = useTranslations();
	const f = useFormat();
	const listed = action === "listed";
	const title = t.t(action === "created" ? "calendar.created" : action === "updated" ? "calendar.updated" : "calendar.listed");
	const day = (event: CalendarCardEvent) => (event.allDay ? f.date(dateOnly(event.start), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }) : f.date(event.start, { weekday: "short", day: "numeric", month: "short", timeZone }));
	const when = (event: CalendarCardEvent) => (event.allDay ? t.t("calendar.allDay") : `${f.time(event.start, { hour: "2-digit", minute: "2-digit", timeZone })}–${f.time(event.end, { hour: "2-digit", minute: "2-digit", timeZone })}`);
	return (
		<ChatCard data-testid="calendar-card" variant="card">
			<ChatCardHeader leading={action === "created" ? <CalendarCheckIcon /> : listed ? <CalendarDaysIcon /> : <CalendarClockIcon />} title={title} {...(!listed ? { badge: { tone: "success" as const, label: t.t(action === "created" ? "calendar.created" : "calendar.updated") } } : {})} />
			{events.length === 0 ? <p className="m-0 text-body text-muted-foreground">{t.t("calendar.listedEmpty")}</p> : null}
			<ul className="m-0 flex list-none flex-col gap-2 p-0">
				{events.map((event) => {
					const href = safeHttpUrl(event.link);
					return (
						<li className="flex min-w-0 flex-col gap-0.5" data-conflict={event.conflict ? "true" : undefined} key={event.id}>
							<div className="flex min-w-0 items-baseline gap-2">
								<span className="w-28 shrink-0 text-caption text-muted-foreground tabular-nums">{listed ? when(event) : `${day(event)} · ${when(event)}`}</span>
								<span className="min-w-0 flex-1 text-body font-medium [overflow-wrap:anywhere]">{event.title || t.t("calendar.untitled")}</span>
								{href && !listed ? (
									<a aria-label={t.t("calendar.openAria", { title: event.title })} className="shrink-0 text-muted-foreground hover:text-foreground" href={href} rel="noopener noreferrer" target="_blank">
										<ExternalLinkIcon aria-hidden className="size-4" />
									</a>
								) : null}
							</div>
							{event.location || event.attendeeCount ? (
								<p className="m-0 pl-30 text-caption text-muted-foreground [overflow-wrap:anywhere]">
									{[event.location, event.attendeeCount ? t.tn("calendar.guests", event.attendeeCount, { count: event.attendeeCount }) : null].filter(Boolean).join(" · ")}
								</p>
							) : null}
							{event.conflict ? (
								<p className="m-0 flex items-center gap-1 pl-30 text-caption text-warning">
									<AlertTriangleIcon aria-hidden className="size-3.5" />
									{t.t("calendar.conflict")}
								</p>
							) : null}
						</li>
					);
				})}
				{more ? <li className="text-caption text-muted-foreground">{t.t("calendar.more", { count: more })}</li> : null}
			</ul>
			{notified ? (
				<p className="m-0 flex items-center gap-1 text-caption text-muted-foreground">
					<MailIcon aria-hidden className="size-3.5" />
					{t.t("calendar.notified")}
				</p>
			) : null}
			{!listed && events[0] && safeHttpUrl(events[0].link) ? (
				<ChatCardActions>
					<Button nativeButton={false} render={<a href={safeHttpUrl(events[0].link)!} rel="noopener noreferrer" target="_blank" />} size="sm" variant="secondary">
						{t.t("calendar.open")}
						<ExternalLinkIcon aria-hidden />
					</Button>
				</ChatCardActions>
			) : null}
		</ChatCard>
	);
}
