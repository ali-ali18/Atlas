"use client";

import {
	Attachments,
	Attachment,
	AttachmentPreview,
	AttachmentInfo,
} from "@/components/ai-elements/attachments";
import type { AttachmentData } from "@/components/ai-elements/attachments";
import { CalendarClockIcon, ClockIcon, WebhookIcon } from "lucide-react";

export type RoutineActivityAction = "created" | "listed" | "updated";

export type OpenRoutinePayload = {
	routineId: string;
	title?: string;
	triggerType?: "cron" | "event" | "once" | "interval";
	detail?: string;
	hookUrl?: string;
	hookSecret?: string;
};

function routineTriggerIcon(triggerType?: "cron" | "event" | "once" | "interval") {
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
	const label = title ?? (action === "updated" ? "Rotina atualizada" : "Rotina");
	const Icon = routineTriggerIcon(triggerType);
	const canOpen = Boolean(routineId && onOpen);

	return (
		<Attachments variant="list" className="w-full max-w-sm self-start">
			<Attachment
				data={routineAttachmentData(routineId ?? "routine", label)}
				className={
					canOpen
						? "cursor-pointer border-border bg-card shadow-sm"
						: "border-border bg-card shadow-sm"
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
	);
}
