"use client";

import { CalendarDaysIcon, PackageIcon } from "lucide-react";

import { ChatCard, ChatCardHeader } from "@workspace/ui/components/chat-card";
import type { DayPlanSection, DayPlanSectionId, DayPlanSource, DayPlanSourceError } from "@workspace/shared";

import { useFormat } from "@/lib/use-format";
import { useTranslations } from "@/lib/i18n/provider";

export type DayPlanCardData = {
	date: string;
	timeZone: string;
	headline: string;
	sections: readonly DayPlanSection[];
	sourceErrors: readonly DayPlanSourceError[];
};

const SECTION_KEY: Record<DayPlanSectionId, "dayPlan.commitments" | "dayPlan.emails" | "dayPlan.pending" | "dayPlan.deliveries"> = {
	commitments: "dayPlan.commitments",
	emails: "dayPlan.emails",
	pending: "dayPlan.pending",
	deliveries: "dayPlan.deliveries",
};
const ERROR_KEY: Record<DayPlanSource, "dayPlan.error.calendar" | "dayPlan.error.email" | "dayPlan.error.agenda" | "dayPlan.error.notebook" | "dayPlan.error.purchases" | "dayPlan.error.tasks"> = {
	calendar: "dayPlan.error.calendar",
	email: "dayPlan.error.email",
	agenda: "dayPlan.error.agenda",
	notebook: "dayPlan.error.notebook",
	purchases: "dayPlan.error.purchases",
	tasks: "dayPlan.error.tasks",
};
const RECONNECT_KEY: Record<DayPlanSource, "dayPlan.reconnect.calendar" | "dayPlan.reconnect.email" | "dayPlan.reconnect.agenda" | "dayPlan.reconnect.notebook" | "dayPlan.reconnect.purchases" | "dayPlan.reconnect.tasks"> = {
	calendar: "dayPlan.reconnect.calendar",
	email: "dayPlan.reconnect.email",
	agenda: "dayPlan.reconnect.agenda",
	notebook: "dayPlan.reconnect.notebook",
	purchases: "dayPlan.reconnect.purchases",
	tasks: "dayPlan.reconnect.tasks",
};

/**
 * "Plano do dia" do brief: a frase de abertura e só as seções que têm itens (vazia some). Fonte que falhou vira UMA linha
 * honesta, escrita aqui no idioma do dono a partir do dado declarado pelo coletor, nunca inventada pelo modelo.
 */
export function DayPlanCard({ date, timeZone, headline, sections, sourceErrors }: DayPlanCardData) {
	const t = useTranslations();
	const f = useFormat();
	const dayLabel = f.date(new Date(`${date}T12:00:00Z`), { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
	void timeZone;
	return (
		<ChatCard data-testid="day-plan-card" variant="card">
			<ChatCardHeader leading={<CalendarDaysIcon />} title={t.t("dayPlan.title")} />
			<p className="m-0 text-caption text-muted-foreground first-letter:uppercase">{dayLabel}</p>
			<p className="m-0 text-body font-medium [overflow-wrap:anywhere]" data-testid="day-plan-headline">{headline}</p>
			{sections.map((section) => (
				<section className="flex flex-col gap-1" data-section={section.id} key={section.id}>
					<h4 className="m-0 flex items-center gap-1.5 text-caption font-semibold tracking-wide text-muted-foreground uppercase">
						{section.id === "deliveries" ? <PackageIcon aria-hidden className="size-3.5" /> : null}
						{t.t(SECTION_KEY[section.id])}
					</h4>
					<ul className="m-0 flex list-none flex-col gap-1.5 p-0">
						{section.items.map((item, index) => (
							<li className="flex min-w-0 items-baseline gap-2" key={`${index}-${item.text}`}>
								{item.time ? <span className="w-14 shrink-0 text-caption text-muted-foreground tabular-nums">{item.time}</span> : null}
								<span className="min-w-0 flex-1 text-body [overflow-wrap:anywhere]">
									{item.text}
									{item.detail ? <span className="block text-caption text-muted-foreground">{item.detail}</span> : null}
								</span>
							</li>
						))}
					</ul>
				</section>
			))}
			{sourceErrors.length > 0 ? (
				<ul className="m-0 flex list-none flex-col gap-0.5 p-0" data-testid="day-plan-errors">
					{sourceErrors.map((error) => (
						<li className="text-caption text-warning" key={error.source}>
							{t.t(error.reason === "needs_connection" ? RECONNECT_KEY[error.source] : ERROR_KEY[error.source])}
						</li>
					))}
				</ul>
			) : null}
		</ChatCard>
	);
}
