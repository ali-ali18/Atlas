// Montagem comum dos testes do executor.
import { z } from "zod";
import { type ExecutorDeps, createExecutor } from "../contract/executor.js";
import type { PolicyContext } from "../contract/authorize.js";
import { defineTool } from "../tools/define-tool.js";
import { fakePorts, sha256 } from "./fake-ports.js";

export const chatPolicy: PolicyContext = { surface: "chat", ownerPresent: true, autonomy: "balanced", rules: [] };

export function setup(policy: PolicyContext = chatPolicy, extra: Partial<ExecutorDeps> = {}) {
	const fake = fakePorts();
	const executor = createExecutor({ runId: "run-1", ownerId: "owner-1", ports: fake.ports, hash: sha256, policy, ...extra });
	return { ...fake, executor };
}

/** Tool de envio que conta quantas vezes rodou. */
export function sendTool(counter: { runs: number } = { runs: 0 }) {
	const tool = defineTool({
		name: "send_email",
		description: "Send an email. Use when the owner asked to send; not for drafts.",
		inputSchema: z.object({ to: z.string(), body: z.string() }),
		effect: "send",
		riskFacts: ({ to }) => ({ recipients: [to], externalRecipients: [to], irreversible: true }),
		execute: ({ to }) => {
			counter.runs++;
			return { ok: true, summary: `sent to ${to}`, receipt: { what: "E-mail enviado", where: to, externalId: "msg-1" } };
		},
	});
	return { tool, counter };
}
