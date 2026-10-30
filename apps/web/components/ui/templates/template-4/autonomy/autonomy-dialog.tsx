"use client";

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@workspace/ui/components/dialog";
import { useT } from "@/lib/i18n/provider";
import { AutonomySettings } from "./autonomy-settings";

/** Autonomia padrão da conta (menu da conta → Autonomia). */
export function AutonomyDialog({
	open,
	connectorFilter,
	onOpenChange,
}: {
	open: boolean;
	connectorFilter?: string;
	onOpenChange: (open: boolean) => void;
}) {
	const t = useT();
	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="max-h-[88dvh] w-[calc(100vw-24px)] overflow-y-auto sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>{t("autonomy.title")}</DialogTitle>
					<DialogDescription>
						{t("autonomy.description")}
					</DialogDescription>
				</DialogHeader>
				{open ? (
					<AutonomySettings
						connectorFilter={connectorFilter}
						scope="account"
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
