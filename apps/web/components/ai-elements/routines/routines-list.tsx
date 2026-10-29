"use client";

import {
	Attachments,
	Attachment,
	AttachmentPreview,
	AttachmentInfo,
} from "@/components/ai-elements/attachments";
import type { AttachmentData } from "@/components/ai-elements/attachments";
import { CalendarClockIcon, ClockIcon, WebhookIcon } from "lucide-react";
import type { HTMLAttributes } from "react";
import type { RoutineListItemData } from "@workspace/shared";
import { cn } from "@workspace/ui/lib/utils";
import { useT } from "@/lib/i18n/provider";
import type { OpenRoutinePayload } from "./routine-activity";

export type RoutinesListProps = HTMLAttributes<HTMLDivElement> & {
	items: RoutineListItemData[];
	onOpen?: (payload: OpenRoutinePayload) => void;
};

function itemData(item: RoutineListItemData): AttachmentData {
	return {
		id: item.id,
		type: "file",
		filename: item.name,
		mediaType: "application/x-atlas-routine",
		url: "",
	};
}

export function RoutinesList({
	items,
	className,
	onOpen,
	...props
}: RoutinesListProps) {
	const t = useT();
	if (items.length === 0) {
		return (
			<div className="text-muted-foreground text-xs">
				{t("aiElements.routines.empty")}
			</div>
		);
	}

	return (
		<Attachments
			variant="list"
			className={cn("w-full max-w-sm self-start", className)}
			{...props}
		>
			{items.map((item) => {
				const Icon =
					item.triggerType === "event"
						? WebhookIcon
						: item.triggerType === "once"
							? ClockIcon
							: CalendarClockIcon;
				const status = [item.enabled ? "" : t("aiElements.routines.paused"), item.createdBy === "bot" ? t("aiElements.routines.byBot") : "", item.groupName ? t("aiElements.routines.group", { name: item.groupName }) : ""].filter(Boolean);
				const label = status.length > 0 ? t("aiElements.routines.withStatus", { name: item.name, status: status.join(", ") }) : item.name;
				return (
					<Attachment
						key={item.id}
						data={{ ...itemData(item), filename: label }}
						className={
							onOpen
								? "cursor-pointer border-border bg-card shadow-sm"
								: "border-border bg-card shadow-sm"
						}
						role={onOpen ? "button" : undefined}
						tabIndex={onOpen ? 0 : undefined}
						onClick={() => {
							onOpen?.({
								routineId: item.id,
								title: item.name,
								triggerType: item.triggerType,
							});
						}}
						onKeyDown={(event) => {
							if (!onOpen) return;
							if (event.key !== "Enter" && event.key !== " ") return;
							event.preventDefault();
							onOpen({
								routineId: item.id,
								title: item.name,
								triggerType: item.triggerType,
							});
						}}
					>
						<AttachmentPreview
							fallbackIcon={
								<Icon className="size-4 text-muted-foreground" />
							}
						/>
						<AttachmentInfo />
					</Attachment>
				);
			})}
		</Attachments>
	);
}
