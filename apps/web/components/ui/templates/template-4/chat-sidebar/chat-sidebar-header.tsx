"use client";

import { PlusIcon, SearchIcon } from "lucide-react";

import { Button } from "@workspace/ui/components/button";
import { NewChatMenu } from "./new-chat-menu";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@workspace/ui/components/input-group";
import { useT } from "@/lib/i18n/provider";

export function ChatSidebarHeader({
	onQueryChange,
	onStartCreate,
	onStartCreateGroup,
	query,
}: {
	onQueryChange: (value: string) => void;
	onStartCreate: () => void;
	onStartCreateGroup: () => void;
	query: string;
}) {
	const t = useT();
	return (
		<div className="flex items-center gap-1">
			<InputGroup className="h-8 flex-1">
				<InputGroupAddon>
					<SearchIcon />
				</InputGroupAddon>
				<InputGroupInput
					aria-label={t("sidebar.search")}
					onChange={(event) => onQueryChange(event.target.value)}
					placeholder={t("sidebar.searchPlaceholder")}
					value={query}
				/>
			</InputGroup>
			<NewChatMenu
				onNewBot={onStartCreate}
				onNewGroup={onStartCreateGroup}
				trigger={
					<Button aria-label={t("sidebar.newBotOrGroup")} size="icon-sm" variant="ghost">
						<PlusIcon />
					</Button>
				}
			/>
		</div>
	);
}
