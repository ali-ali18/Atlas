// `propose_bot`: PROPÕE criar um bot novo. Só mostra um cartão; nada é criado antes de o dono aprovar (a API cria o bot,
// copia as habilidades iniciais e manda a primeira tarefa quando ele aprova o cartão, como no legado). Por isso o efeito é
// `draft`: o cartão é a confirmação. No máximo uma proposta por run. O "o dono já disse para que serve?" é do modelo
// (descrição da tool), não de uma regex sobre o texto dele.
import {
	BOT_PROPOSAL_COLOR_IDS,
	BOT_PROPOSAL_DESCRIPTION_MAX,
	BOT_PROPOSAL_MODEL_MAX,
	BOT_PROPOSAL_NAME_MAX,
	BOT_PROPOSAL_SHAPE_IDS,
	BOT_PROPOSAL_SKILLS_MAX,
	BOT_PROPOSAL_SNIPPET_MAX,
	BOT_PROPOSAL_TASK_MAX,
	BOT_PROPOSAL_DEFAULT_COLOR,
	BOT_PROPOSAL_DEFAULT_SHAPE,
	isBotProposalShape,
	parseBotProposal,
	redactSecrets,
	resolveBotProposalColor,
	type BotProposalEvent,
} from "@workspace/shared";
import { z } from "zod";
import type { BotProposals } from "../../ports/bots.js";
import { defineTool } from "../../tools/define-tool.js";

export function createProposeBotTool(proposals: BotProposals) {
	// Uma proposta por run: a capacidade é montada por run, então o contador vive aqui.
	let proposed = 0;
	return defineTool({
		name: "propose_bot",
		description:
			"Propose creating a NEW agent (bot) when the owner asks for one. A card shows the agent (avatar, name, role, model, skills) and nothing is created until the owner approves it. " +
			"Use it only after the owner said what the agent is for: if they only said \"create an agent\", ask what it is for first (one question with ask_owner). Choose sensible defaults for tone and apps yourself. At most one proposal per turn. " +
			"Do not use it for skills or routines, nor on your own initiative. name: short. description: the agent's role and behavior (its briefing). Optional: color and shape (avatar), model, skills (slugs of existing account skills to copy to it), first_task (a self-contained message sent to the new agent once created).",
		inputSchema: z.object({
			name: z.string().trim().min(1).max(BOT_PROPOSAL_NAME_MAX).describe(`Agent name, up to ${BOT_PROPOSAL_NAME_MAX} characters.`),
			description: z.string().trim().min(1).max(BOT_PROPOSAL_DESCRIPTION_MAX).describe(`Role and behavior of the agent (briefing), up to ${BOT_PROPOSAL_DESCRIPTION_MAX} characters.`),
			snippet: z.string().trim().min(1).max(BOT_PROPOSAL_SNIPPET_MAX).optional().describe(`One short line for the chat list, up to ${BOT_PROPOSAL_SNIPPET_MAX} characters.`),
			color: z.string().trim().refine((value) => resolveBotProposalColor(value) !== null, `use one of: ${BOT_PROPOSAL_COLOR_IDS.join(", ")}`).optional().describe("Avatar color."),
			shape: z.string().trim().refine(isBotProposalShape, `use one of: ${BOT_PROPOSAL_SHAPE_IDS.join(", ")}`).optional().describe("Avatar shape."),
			model: z.string().trim().min(1).max(BOT_PROPOSAL_MODEL_MAX).optional().describe("Optional model id; omit to use the account default."),
			skills: z.array(z.string().trim().min(1).max(80)).max(BOT_PROPOSAL_SKILLS_MAX).optional().describe(`Optional slugs of existing account skills to copy to the new agent (up to ${BOT_PROPOSAL_SKILLS_MAX}).`),
			first_task: z.string().trim().min(1).max(BOT_PROPOSAL_TASK_MAX).optional().describe("Optional first request, self-contained, sent to the agent after it is created."),
		}),
		effect: "draft",
		async execute(args, ctx) {
			if (proposed >= 1) return { ok: false, error: "Only one agent proposal per turn: the card is already shown.", hint: "Wait for the owner's decision." };
			const skills = [...new Set(args.skills ?? [])];
			if (skills.length > 0) {
				const available = await proposals.skillNames(ctx.ownerId);
				const missing = skills.filter((slug) => !available.includes(slug));
				if (missing.length > 0) {
					return { ok: false, error: `Unknown account skills: ${missing.join(", ")}.`, hint: available.length > 0 ? `Available: ${available.slice(0, 30).join(", ")}. Use exact slugs or omit skills.` : "The account has no skills; omit skills." };
				}
			}
			const description = redactSecrets(args.description);
			const data = parseBotProposal({
				proposalId: `bot-${ctx.runId}`.slice(0, 120),
				status: "pending",
				name: args.name,
				description,
				snippet: redactSecrets(args.snippet ?? description.slice(0, BOT_PROPOSAL_SNIPPET_MAX)),
				color: resolveBotProposalColor(args.color) ?? BOT_PROPOSAL_DEFAULT_COLOR,
				shape: args.shape ?? BOT_PROPOSAL_DEFAULT_SHAPE,
				model: args.model ?? null,
				skills,
				firstTask: args.first_task ? redactSecrets(args.first_task) : null,
			});
			if (!data) return { ok: false, error: "Invalid agent proposal.", hint: "Check the name and description (not empty, within the size limits)." };
			const event: BotProposalEvent = { type: "bot-proposal", ...data };
			await proposals.show(ctx.ownerId, ctx.runId, event);
			proposed += 1;
			return {
				ok: true,
				receipt: { what: `Proposta de novo bot: ${data.name}`, where: "Bots" },
				summary: `Approval card shown for the new agent "${data.name}". Nothing was created: it is created only if the owner approves the card. Do not call propose_bot again; tell the owner in one short sentence to review the card.`,
			};
		},
	});
}
