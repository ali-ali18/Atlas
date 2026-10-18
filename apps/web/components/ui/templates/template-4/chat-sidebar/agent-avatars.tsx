import { AvatarStatus } from "../avatar-status";
import type { Agent } from "../data";
import { GroupAvatar, resolveGroupMembers } from "../group-avatar";
import { LiveAgentAvatar } from "../live-agent-avatar";

export function AgentAvatars({
	agent,
	agents,
	size = 52,
}: {
	agent: Agent;
	agents: Agent[];
	size?: number;
}) {
	// Sidebar (lista, rail, fixados): avatar vivo. Respira só no painel grande;
	// aqui ele pisca de vez em quando, olha o mouse no hover, reage ao toque e
	// balança enquanto o bot trabalha (o loop dorme quando tudo assenta). Não lida e
	// trabalhando viram a bolinha no canto (AvatarStatus), sem trocar o avatar.
	if (!agent.members?.length) {
		return (
			<AvatarStatus botId={agent.id} primary={agent.isPrimary} size={size} unread={agent.notifications}>
				<LiveAgentAvatar
					bodyColor={agent.color}
					botId={agent.id}
					follow="hover"
					pokeOnClick
					shape={agent.shape}
					size={size}
				/>
			</AvatarStatus>
		);
	}

	// Grupo: 2 ou 3 avatares dos membros no mesmo quadrado do avatar de um bot.
	return (
		<AvatarStatus botId={agent.id} label="Grupo" size={size} unread={agent.notifications}>
			<GroupAvatar members={resolveGroupMembers(agent, agents)} size={size} />
		</AvatarStatus>
	);
}
