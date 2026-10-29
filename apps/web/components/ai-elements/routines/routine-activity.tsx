"use client";

import {
	Attachments,
	Attachment,
	AttachmentPreview,
	AttachmentInfo,
} from "@/components/ai-elements/attachments";
import type { AttachmentData } from "@/components/ai-elements/attachments";
import { CalendarClockIcon, ClockIcon, MailIcon, WebhookIcon } from "lucide-react";
import { useTranslations } from "@/lib/i18n/provider";
import { routineCardSummary } from "@/components/ui/templates/template-4/chat-context-panel/routine-map";

export type RoutineActivityAction = "created" | "listed" | "updated";

export type OpenRoutinePayload = {
	routineId: string;
	title?: string;
	triggerType?: "cron" | "event" | "once" | "interval";
	detail?: string;
	hookUrl?: string;
	hookSecret?: string;
};

function routineTriggerIcon(triggerType?: "cron" | "event" | "once" | "interval", detail?: string) {
	if (triggerType === "event" && detail?.startsWith("Quando chegar e-mail")) return MailIcon;
	if (triggerType === "cron" || triggerType === "interval") return CalendarClockIcon;
	if (triggerType === "once") return ClockIcon;
	return WebhookIcon;
}

function routineAttachmentData(id: string, name: string): AttachmentData {
	return {
		id,
		type: "file",
		filename: name,
		mediaType: "application/x-atlas-routine",
		url: "",
	};
}

export function RoutineActivityCard({
	action,
	title,
	routineId,
	triggerType,
	detail,
	hookUrl,
	hookSecret,
	onOpen,
}: {
	action: RoutineActivityAction;
	title?: string;
	routineId?: string;
	triggerType?: "cron" | "event" | "once" | "interval";
	detail?: string;
	hookUrl?: string;
	hookSecret?: string;
	onOpen?: (payload: OpenRoutinePayload) => void;
}) {
	const translator = useTranslations();
	const { t } = translator;
	const label = title ?? (action === "updated" ? t("aiElements.routines.updated") : t("aiElements.routines.routine"));
	const Icon = routineTriggerIcon(triggerType, detail);
	const canOpen = Boolean(routineId && onOpen);
	const summary = action === "created" ? routineCardSummary(triggerType, detail, translator) : null;

	return (
		<div className="flex w-full max-w-[min(68ch,100%)] flex-col gap-1 self-start">
			<Attachments variant="list" className="w-full">
				<Attachment
					data={routineAttachmentData(routineId ?? "routine", label)}
					className={
						canOpen
							? "cursor-pointer rounded-2xl border-transparent bg-muted/60"
							: "rounded-2xl border-transparent bg-muted/60"
					}
					role={canOpen ? "button" : undefined}
					tabIndex={canOpen ? 0 : undefined}
					onClick={() => {
						if (!routineId || !onOpen) return;
						onOpen({
							routineId,
							title,
							triggerType,
							detail,
							hookUrl,
							hookSecret,
						});
					}}
					onKeyDown={(event) => {
						if (!canOpen) return;
						if (event.key !== "Enter" && event.key !== " ") return;
						event.preventDefault();
						onOpen?.({
							routineId: routineId!,
							title,
							triggerType,
							detail,
							hookUrl,
							hookSecret,
						});
					}}
				>
					<AttachmentPreview
						fallbackIcon={<Icon className="size-4 text-muted-foreground" />}
					/>
					<AttachmentInfo />
				</Attachment>
			</Attachments>
			{summary ? (
				<p className="px-1 text-muted-foreground text-xs" data-routine-summary>
					{t("aiElements.routines.createdSummary", { summary })}
				</p>
			) : null}
		</div>
	);
}
