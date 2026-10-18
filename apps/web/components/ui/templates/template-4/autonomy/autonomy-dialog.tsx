"use client";

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@workspace/ui/components/dialog";
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
	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="max-h-[88dvh] w-[calc(100vw-24px)] overflow-y-auto sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Autonomia</DialogTitle>
					<DialogDescription>
						Quanto o agente pode fazer sozinho, sem pedir sua aprovação. Cada
						bot pode ter a sua própria.
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
