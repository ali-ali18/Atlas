"use client";

import { BotIcon, UsersIcon } from "lucide-react";
import type { ReactElement } from "react";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import { useT } from "@/lib/i18n/provider";

/** Menu do "+": novo bot ou chat em grupo. O gatilho é quem chama (botão da sidebar, do rail ou do celular). */
export function NewChatMenu({
	trigger,
	onNewBot,
	onNewGroup,
	align = "end",
	side = "bottom",
	itemClassName,
}: {
	trigger: ReactElement;
	onNewBot: () => void;
	onNewGroup: () => void;
	align?: "start" | "center" | "end";
	side?: "top" | "right" | "bottom" | "left";
	itemClassName?: string;
}) {
	const t = useT();
	return (
		<DropdownMenu>
			<DropdownMenuTrigger render={trigger} />
			<DropdownMenuContent align={align} className="min-w-44" side={side}>
				<DropdownMenuItem className={itemClassName} onClick={onNewBot}>
					<BotIcon /> {t("sidebar.newBot")}
				</DropdownMenuItem>
				<DropdownMenuItem className={itemClassName} onClick={onNewGroup}>
					<UsersIcon /> {t("sidebar.newGroup")}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
