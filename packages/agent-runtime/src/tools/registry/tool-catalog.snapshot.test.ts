import type { ChatTool } from "@workspace/llm";
import { describe, expect, it } from "vitest";
import { COMPUTER_USE_TOOLS } from "../../computer-use.js";
import { MCP_TOOL_SEARCH_TOOL } from "../catalog.js";
import { isReadOnlyToolName } from "../../execution/run-governor.js";
import { DELEGATE_V2_TOOL } from "../../engine-v2/helpers.js";
import { NOTEBOOK_READ_TOOL, NOTEBOOK_WRITE_TOOL } from "../../engine-v2/notebook.js";
import { API_CALL_TOOL, API_SEARCH_TOOL, PROPOSE_API_CONNECTION_TOOL } from "../../api-connector/tools.js";
import { EMAIL_TOOLS } from "../../email/tools.js";
import { ATTACHMENT_LIST_TOOL, ATTACHMENT_READ_TOOL, ATTACHMENT_TO_COMPUTER_TOOL } from "../attachment-tools.js";
import { DECIDE_BOT_PENDING_TOOL } from "../bot-pending.js";
import { PROPOSE_BOT_TOOL } from "../bot-proposal.js";
import { SEND_TO_BOT_TOOL, SET_PRIMARY_BOT_TOOL } from "../bot-messaging.js";
import { NATIVE_COMPUTER_TOOL } from "../computer-native.js";
import { SET_CONNECTOR_TOOL_MARKS_TOOL } from "../connector-tool-marks.js";
import { CREATE_FILE_TOOL } from "../create-file.js";
import { DELEGATE_TASK_TOOL } from "../delegate-task.js";
import { DEV_SESSION_TOOLS, DEV_SESSION_TOOL_NAMES } from "../dev-session.js";
import { GENERATE_IMAGE_TOOL } from "../generate-image.js";
import { INSPECT_PRESENTATION_TOOL } from "../inspect-presentation.js";
import { PAGE_TOOLS } from "../pages.js";
import { PROPOSE_PLAN_TOOL } from "../propose-plan.js";
import { LIST_FOLLOWUPS_TOOL, CANCEL_FOLLOWUP_TOOL, NOTIFY_USER_TOOL, RESCHEDULE_FOLLOWUP_TOOL, SCHEDULE_FOLLOWUP_TOOL, SUGGEST_ROUTINE_TOOL } from "../proactive.js";
import { REPORT_ALERT_TOOL } from "../report-alert.js";
import { RESEARCH_NOTE_TOOL } from "../research-note.js";
import { RUN_CODE_TOOL } from "../run-code.js";
import { SET_AUTONOMY_TOOL } from "../set-autonomy.js";
import { SET_ENGINE_TOOL } from "../set-engine.js";
import { SET_REASONING_EFFORT_TOOL } from "../set-reasoning-effort.js";
import { SHOW_IMAGE_TOOL } from "../show-image.js";
import { SKILL_GROUP_TOOLS } from "../skills.js";
import { TRACK_ITEMS_TOOL } from "../track-items.js";
import { UPDATE_TASK_LIST_TOOL } from "../task-list.js";
import { getToolRegistration, listRegisteredToolNames, resolveToolEffect } from "./index.js";

/**
 * Retrato do catálogo nativo INTEIRO (PR5b do harness v3): nome, descrição, schema, grupo, readOnly e metadado de
 * cada tool. Foi tirado ANTES da migração para `defineTool`; cada commit da migração tem de bater com ele sem
 * atualizar o arquivo (v1/v2/v3 idênticos). Mudou de propósito? Rode `vitest -u` e explique no commit.
 * Definições que o registro ainda não carrega vêm das constantes dos módulos (`FALLBACK_DEFINITIONS`).
 */
const FALLBACK_DEFINITIONS: readonly ChatTool[] = [
	...COMPUTER_USE_TOOLS,
	MCP_TOOL_SEARCH_TOOL,
	...DEV_SESSION_TOOLS,
	...EMAIL_TOOLS,
	...PAGE_TOOLS,
	...SKILL_GROUP_TOOLS,
	API_CALL_TOOL, API_SEARCH_TOOL, PROPOSE_API_CONNECTION_TOOL,
	ATTACHMENT_LIST_TOOL, ATTACHMENT_READ_TOOL, ATTACHMENT_TO_COMPUTER_TOOL,
	CANCEL_FOLLOWUP_TOOL, CREATE_FILE_TOOL, DECIDE_BOT_PENDING_TOOL, DELEGATE_TASK_TOOL, DELEGATE_V2_TOOL,
	GENERATE_IMAGE_TOOL, INSPECT_PRESENTATION_TOOL, LIST_FOLLOWUPS_TOOL, NATIVE_COMPUTER_TOOL, NOTEBOOK_READ_TOOL,
	NOTEBOOK_WRITE_TOOL, NOTIFY_USER_TOOL, PROPOSE_BOT_TOOL, PROPOSE_PLAN_TOOL, REPORT_ALERT_TOOL, RESCHEDULE_FOLLOWUP_TOOL,
	RESEARCH_NOTE_TOOL, RUN_CODE_TOOL, SCHEDULE_FOLLOWUP_TOOL, SEND_TO_BOT_TOOL, SET_AUTONOMY_TOOL, SET_CONNECTOR_TOOL_MARKS_TOOL,
	SET_ENGINE_TOOL, SET_PRIMARY_BOT_TOOL, SET_REASONING_EFFORT_TOOL, SHOW_IMAGE_TOOL, SUGGEST_ROUTINE_TOOL, TRACK_ITEMS_TOOL,
	UPDATE_TASK_LIST_TOOL,
];

/** Args de amostra para as tools que refinam o efeito por chamada. */
const EFFECT_SAMPLES: Record<string, Array<Record<string, unknown>>> = {
	sandbox_download: [{}, { use_browser_session: false }, { use_browser_session: true }, { url: "https://x.test" }],
	api_call: [{}, { operationId: "list" }, { method: "GET" }, { method: " head " }, { method: "POST" }, { method: "delete" }, { method: 7 }],
};

function definitionOf(name: string): ChatTool | undefined {
	return getToolRegistration(name)?.definition ?? FALLBACK_DEFINITIONS.find((tool) => tool.function.name === name);
}

function describeTool(name: string, dev: boolean) {
	const registration = getToolRegistration(name);
	const meta = registration ?? undefined;
	const effectAt = (args: Record<string, unknown>) => resolveToolEffect(name, args) ?? null;
	return {
		name,
		group: dev ? "dev" : (registration?.group ?? null),
		source: dev ? "dev-session" : "registry",
		readOnly: dev ? isReadOnlyToolName(name, () => false) : (registration?.readOnly ?? null),
		definition: definitionOf(name) ?? null,
		effect: dev ? (resolveToolEffect(name, {}) ?? null) : (meta?.effect ?? null),
		catalogEffect: dev ? null : (meta?.catalogEffect ?? null),
		poll: dev ? null : (meta?.poll ?? null),
		endsTurn: dev ? null : (meta?.endsTurn ?? null),
		needsHuman: dev ? null : (meta?.needsHuman ?? null),
		ownCard: dev ? null : (meta?.ownCard ?? null),
		effectBySample: (EFFECT_SAMPLES[name] ?? []).map((args) => ({ args, effect: effectAt(args) })),
	};
}

describe("retrato do catálogo nativo", () => {
	it("cada tool nativa mantém nome, descrição, schema, grupo e metadado", async () => {
		const registryNames = [...listRegisteredToolNames()].sort();
		const devNames = [...DEV_SESSION_TOOL_NAMES].sort();
		const snapshot = {
			catalogOrder: COMPUTER_USE_TOOLS.map((tool) => tool.function.name),
			tools: [...registryNames.map((name) => describeTool(name, false)), ...devNames.map((name) => describeTool(name, true))],
		};
		await expect(JSON.stringify(snapshot, null, 1) + "\n").toMatchFileSnapshot("./__snapshots__/tool-catalog.snap.json");
		expect(snapshot.tools.length).toBe(registryNames.length + devNames.length);
	});
});
