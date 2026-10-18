import type { ChatTool } from "@workspace/llm";
import { listSkillDocs, type SkillDocRecord } from "@workspace/db";
import {
	BOT_PROPOSAL_COLOR_IDS,
	BOT_PROPOSAL_DEFAULT_COLOR,
	BOT_PROPOSAL_DEFAULT_SHAPE,
	BOT_PROPOSAL_DESCRIPTION_MAX,
	BOT_PROPOSAL_MODEL_MAX,
	BOT_PROPOSAL_NAME_MAX,
	BOT_PROPOSAL_SHAPE_IDS,
	BOT_PROPOSAL_SKILLS_MAX,
	BOT_PROPOSAL_SNIPPET_MAX,
	BOT_PROPOSAL_TASK_MAX,
	isBareBotCreateRequest,
	isBotProposalShape,
	parseBotProposal,
	redactSecrets,
	resolveBotProposalColor,
	type BotProposalEvent,
	type ComputerUseEvent,
} from "@workspace/shared";
import { isUnattendedOrigin } from "../autonomy-gate.js";

/**
 * `propose_bot`: o agente PROPÕE criar outro agente. Só mostra um card; nada é
 * criado antes de o dono aprovar (a API cria o bot, copia as skills iniciais e
 * envia a primeira tarefa). Só existe em conversa com o usuário e no máximo uma
 * proposta por turno; o bot novo nasce com a autonomia padrão.
 */

export const PROPOSE_BOT_TOOL_NAME = "propose_bot";

export const PROPOSE_BOT_TOOL: ChatTool = {
	type: "function",
	function: {
		name: PROPOSE_BOT_TOOL_NAME,
		description:
			"Propose creating a NEW agent (bot) for the user when they ask for one. A card shows the agent (avatar, name, role, model, skills) and nothing is created until the user approves it. Only after the user said what the agent is for: if they only said \"create an agent\", call propose_questionnaire first (purpose, tone, apps). At most one proposal per turn. Do not use it for skills or routines, nor on your own initiative. name: short. description: the agent's role and behavior (its briefing). Optional: color and shape (avatar), model, skills (slugs of existing account skills to copy to it), first_task (a self-contained message sent to the new agent once created).",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: `Agent name, up to ${BOT_PROPOSAL_NAME_MAX} characters.` },
				description: { type: "string", description: `Role and behavior of the agent (briefing), up to ${BOT_PROPOSAL_DESCRIPTION_MAX} characters.` },
				snippet: { type: "string", description: `One short line for the chat list, up to ${BOT_PROPOSAL_SNIPPET_MAX} characters.` },
				color: { type: "string", enum: [...BOT_PROPOSAL_COLOR_IDS], description: "Avatar color." },
				shape: { type: "string", enum: [...BOT_PROPOSAL_SHAPE_IDS], description: "Avatar shape." },
				model: { type: "string", description: "Optional model id; omit to use the account default." },
				skills: {
					type: "array",
					items: { type: "string" },
					description: `Optional slugs of existing account skills to copy to the new agent (up to ${BOT_PROPOSAL_SKILLS_MAX}).`,
				},
				first_task: { type: "string", description: "Optional first request, self-contained, sent to the agent after it is created." },
			},
			required: ["name", "description"],
		},
	},
};

export type BotProposalContext = {
	userId?: string;
	botId?: string | null;
	conversationId?: string | null;
	runId?: string;
	origin?: string;
	/** Falas do usuário neste run (mais nova primeiro). */
	recentUserTexts?: string[];
	/** Propostas já feitas neste run (teto de uma por turno). */
	proposals?: { count: number };
	listSkills?: (userId: string) => Promise<SkillDocRecord[]>;
	persistCard: (event: ComputerUseEvent) => Promise<void>;
};

export type BotProposalOutcome = { summary: string; botProposalEvent: BotProposalEvent };

function text(value: unknown): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/** `propose_bot` só vale com o usuário no chat: rotina, webhook, subagente, evento e conversa entre bots ficam de fora. */
export function shouldExposeProposeBot(input: { origin: string | undefined; isSubagent: boolean }): boolean {
	return input.origin === "chat" && !input.isSubagent;
}

export async function executeProposeBot(args: Record<string, unknown>, ctx: BotProposalContext): Promise<BotProposalOutcome> {
	if (ctx.origin !== "chat" || isUnattendedOrigin(ctx.origin)) {
		throw new Error("propose_bot só funciona numa conversa com o usuário (não em rotina, webhook, evento ou conversa entre bots).");
	}
	const userId = ctx.userId?.trim();
	if (!userId || userId === "default" || !ctx.botId || !ctx.conversationId) {
		throw new Error("propose_bot precisa de uma conversa de bot com o dono logado.");
	}
	const counter = ctx.proposals ?? { count: 0 };
	if (counter.count >= 1) {
		throw new Error("Only one agent proposal per turn: the card is already shown. Wait for the user's decision.");
	}
	if (isBareBotCreateRequest(ctx.recentUserTexts?.[0])) {
		throw new Error(
			"The user only asked to create an agent and did not say what it is for. Do NOT propose it yet: call propose_questionnaire with 1 item (what the agent is for, with 2-4 concrete options plus a free-text input), then ask tone and apps/connectors if still unclear, and propose it from the answers.",
		);
	}

	const name = text(args.name);
	if (!name) throw new Error('"name" is required.');
	if (name.length > BOT_PROPOSAL_NAME_MAX) throw new Error(`"name" is too long (max ${BOT_PROPOSAL_NAME_MAX} characters).`);
	const description = redactSecrets(typeof args.description === "string" ? args.description.trim() : "");
	if (!description) throw new Error('"description" is required: the agent role and how it should behave.');
	if (description.length > BOT_PROPOSAL_DESCRIPTION_MAX) {
		throw new Error(`"description" is too long (max ${BOT_PROPOSAL_DESCRIPTION_MAX} characters).`);
	}
	const snippet = text(args.snippet).slice(0, BOT_PROPOSAL_SNIPPET_MAX);

	let color = BOT_PROPOSAL_DEFAULT_COLOR;
	if (args.color !== undefined && args.color !== null && args.color !== "") {
		const resolved = resolveBotProposalColor(args.color);
		if (!resolved) throw new Error(`"color" must be one of: ${BOT_PROPOSAL_COLOR_IDS.join(", ")}.`);
		color = resolved;
	}
	let shape = BOT_PROPOSAL_DEFAULT_SHAPE;
	if (args.shape !== undefined && args.shape !== null && args.shape !== "") {
		if (!isBotProposalShape(args.shape)) throw new Error(`"shape" must be one of: ${BOT_PROPOSAL_SHAPE_IDS.join(", ")}.`);
		shape = args.shape.trim();
	}
	const model = text(args.model);
	if (model.length > BOT_PROPOSAL_MODEL_MAX) throw new Error(`"model" is too long (max ${BOT_PROPOSAL_MODEL_MAX} characters).`);

	let skills: string[] = [];
	if (args.skills !== undefined && args.skills !== null) {
		if (!Array.isArray(args.skills)) throw new Error('"skills" must be a list of skill slugs.');
		skills = [...new Set(args.skills.map((item) => text(item)).filter(Boolean))];
		if (skills.length > BOT_PROPOSAL_SKILLS_MAX) throw new Error(`At most ${BOT_PROPOSAL_SKILLS_MAX} initial skills.`);
		if (skills.length > 0) {
			const docs = await (ctx.listSkills ?? ((id: string) => listSkillDocs(id)))(userId);
			const available = docs.filter((doc) => doc.botId === null && doc.enabled && doc.status === "active").map((doc) => doc.name);
			const missing = skills.filter((slug) => !available.includes(slug));
			if (missing.length > 0) {
				throw new Error(
					`Unknown account skills: ${missing.join(", ")}. ${available.length ? `Available: ${available.slice(0, 30).join(", ")}.` : "The account has no skills."} Use exact slugs or omit "skills".`,
				);
			}
		}
	}

	const firstTask = redactSecrets(typeof args.first_task === "string" ? args.first_task.trim() : "");
	if (firstTask.length > BOT_PROPOSAL_TASK_MAX) throw new Error(`"first_task" is too long (max ${BOT_PROPOSAL_TASK_MAX} characters).`);

	const proposalId = `bot-${ctx.runId ?? "local"}`.slice(0, 120);
	const data = parseBotProposal({
		proposalId,
		status: "pending",
		name,
		description,
		snippet: snippet || description,
		color,
		shape,
		model: model || null,
		skills,
		firstTask: firstTask || null,
	});
	if (!data) throw new Error("Invalid agent proposal: check name, description and the other fields.");

	const event: BotProposalEvent = { type: "bot-proposal", ...data };
	await ctx.persistCard(event);
	counter.count += 1;
	return {
		summary: `Approval card sent for the new agent "${data.name}". Nothing was created: it is created only if the user approves the card. Do not call propose_bot again; tell the user in one short sentence to review the card.`,
		botProposalEvent: event,
	};
}
