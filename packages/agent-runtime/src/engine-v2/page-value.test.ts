import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import type { ComputerUseEvent } from "@workspace/shared";
import { findPageValue } from "@workspace/search";
import { runEngineV2 } from "./run.js";
import type { PageValueFinder } from "../tools/find-page-value.js";

/** `find_page_value` no v2: o teto de 3 buscas por run vale como no v1 (o contador é do run, não da chamada). */

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		getBotProfile: vi.fn(async () => null),
		listBotSkills: vi.fn(async () => []),
		searchSkillVersions: vi.fn(async () => []),
		persistConversationCardFromEvent: vi.fn(async () => undefined),
		listRoutines: vi.fn(async () => []),
		listMcpConnections: vi.fn(async () => []),
	};
});

const STORE = `<!doctype html><html><head><title>Galaxy X</title></head><body><ul>
<li class="variant"><h3>Galaxy X 128 GB</h3><span class="price">R$ 2.799,00</span></li>
<li class="variant"><h3>Galaxy X 256 GB</h3><span class="price">R$ 3.299,00</span></li>
</ul></body></html>`;
const siteFetch = (html: string) =>
	(async (input: string | URL | Request) =>
		String(input).endsWith("/robots.txt") ? new Response("", { status: 404 }) : new Response(html, { headers: { "content-type": "text/html" } })) as never;
const call = (id: string): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "find_page_value", arguments: JSON.stringify({ url: "https://loja.example.com/x", value: "3.299,00", near: `variante ${id}` }) } }] },
	finishReason: "tool_calls",
});
const closing: CompleteChatWithToolsResult = { model: "m", message: { role: "assistant", content: "Pronto." }, finishReason: "stop" };

beforeEach(() => vi.clearAllMocks());

describe("v2: teto de find_page_value por run", () => {
	it("a 4ª busca falha honesta com a saída e o buscador roda só 3 vezes", async () => {
		const finder = vi.fn<PageValueFinder>(({ url, value, near }) => findPageValue(url, { value, ...(near ? { near } : {}) }, { fetchFn: siteFetch(STORE), lookupFn: async () => ["93.184.216.34"] }));
		const results: Array<{ ok: boolean; summary: string }> = [];
		const queue = [call("c1"), call("c2"), call("c3"), call("c4"), closing];
		await runEngineV2(
			{
				manager: {} as unknown as SandboxManager,
				getSessionId: async () => "s",
				sandboxEnabled: false,
				model: "m",
				apiKey: "test",
				messages: [{ role: "user", content: "me avisa quando o Galaxy X de 256 GB baixar de R$ 3.000" }],
				runId: "run-pv", conversationId: "conv-pv", botId: "bot-1", userId: "user-1", maxSteps: 12,
				origin: "chat",
				pageValueFinder: finder,
				onEvent: (event: ComputerUseEvent) => {
					if (event.type === "tool_result") results.push(event as never);
				},
				streamChat: async () => {
					const next = queue.shift();
					if (!next) throw new Error("LLM extra");
					return next;
				},
			},
			{ profile: "chat" },
		);
expect(results.map((result) => result.ok)).toEqual([true, true, true, false]);
		expect(results[3]!.summary).toMatch(/limit reached \(3 per run\).*plain condition/);
		expect(finder).toHaveBeenCalledTimes(3);
	});
});
