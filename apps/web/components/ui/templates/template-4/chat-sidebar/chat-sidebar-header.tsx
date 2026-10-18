"use client";

import { PlusIcon, SearchIcon } from "lucide-react";

import { Button } from "@workspace/ui/components/button";
import { NewChatMenu } from "./new-chat-menu";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@workspace/ui/components/input-group";

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
	return (
		<div className="flex items-center gap-1">
			<InputGroup className="h-8 flex-1">
				<InputGroupAddon>
					<SearchIcon />
				</InputGroupAddon>
				<InputGroupInput
					aria-label="Buscar bots"
					onChange={(event) => onQueryChange(event.target.value)}
					placeholder="Buscar"
					value={query}
				/>
			</InputGroup>
			<NewChatMenu
				onNewBot={onStartCreate}
				onNewGroup={onStartCreateGroup}
				trigger={
					<Button aria-label="Novo bot ou grupo" size="icon-sm" variant="ghost">
						<PlusIcon />
					</Button>
				}
			/>
		</div>
	);
}
