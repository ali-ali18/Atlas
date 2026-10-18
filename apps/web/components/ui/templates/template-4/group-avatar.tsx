"use client";

import { cn } from "@workspace/ui/lib/utils";

import { AgentAvatar } from "./agent-avatar";
import type { Agent } from "./data";

/** O que o avatar composto precisa de cada membro. */
export type GroupAvatarMember = Pick<Agent, "id" | "color" | "shape">;

/**
 * Avatar de grupo: 2 ou 3 avatares dos membros empilhados num quadrado só
 * (2 em diagonal, 3 em triângulo). `ringClassName` é a cor do fundo ao redor,
 * para os avatares se separarem uns dos outros.
 */
export function GroupAvatar({
	members,
	size = 52,
	className,
	ringClassName = "ring-sidebar",
}: {
	members: readonly GroupAvatarMember[];
	size?: number;
	className?: string;
	ringClassName?: string;
}) {
	const shown = members.slice(0, 3);
	const count = shown.length;
	// Avatares menores quando são três; o ring come ~2px, então o quadrado cresce um pouco.
	const piece = Math.round(size * (count >= 3 ? 0.52 : 0.64));
	const spots: Array<{ left: number; top: number }> =
		count >= 3
			? [
					{ left: (size - piece) / 2, top: 0 },
					{ left: 0, top: size - piece },
					{ left: size - piece, top: size - piece },
				]
			: [
					{ left: 0, top: 0 },
					{ left: size - piece, top: size - piece },
				];
	return (
		<span
			aria-hidden="true"
			className={cn("relative inline-block shrink-0", className)}
			data-slot="group-avatar"
			style={{ width: size, height: size }}
		>
			{shown.map((member, index) => (
				<span
					className={cn("absolute rounded-full ring-2", ringClassName)}
					key={member.id}
					style={{ ...spots[index], width: piece, height: piece }}
				>
					<AgentAvatar
						animated={false}
						bodyColor={member.color}
						id={member.id}
						shape={member.shape}
						size={piece}
					/>
				</span>
			))}
		</span>
	);
}

/** Membros do grupo na ordem do grupo, só os que existem na lista de bots. */
export function resolveGroupMembers(group: Pick<Agent, "members">, agents: readonly Agent[]): Agent[] {
	return (group.members ?? []).flatMap((id) => {
		const found = agents.find((agent) => agent.id === id);
		return found ? [found] : [];
	});
}
