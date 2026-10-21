import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { createChatgptStreamChat } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { runComputerUse } from "./computer-use.js";
import { buildMcpToolset } from "./mcp/registry.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []), getBotProfile: vi.fn(async () => null),
	listBotSkills: vi.fn(async () => []), searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []), persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

it("loop agnóstico reinjeta reasoning e resultados de duas tools com os ids originais", async () => {
	const fixture = (name: string) => readFileSync(new URL(`../../llm/src/responses/__fixtures__/${name}.sse`, import.meta.url), "utf8");
	const requestBodies: Array<Record<string, unknown>> = [];
	const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
		requestBodies.push(JSON.parse(String(init?.body)));
		return new Response(fixture(requestBodies.length === 1 ? "tools" : "text").replaceAll('"lookup"', '"mcp__data__lookup"'));
	});
	const autonomy = { level: "autonomous" as const, exceptions: [] };
	const toolset = buildMcpToolset([{ id: "conn_fixture", slug: "data", name: "Data", disabledTools: [], tools: [{ name: "lookup", inputSchema: { type: "object", properties: { id: { type: "number" } } }, annotations: { readOnlyHint: true } }] }], { autonomy });
	const connector = vi.fn(async () => ({ ok: true, text: "fixture result", truncated: false }));
	const result = await runComputerUse({
		manager: {} as SandboxManager, getSessionId: async () => "unused", sandboxEnabled: false,
		model: "chatgpt/luna", apiKey: "unused", runId: "run_fixture", userId: "owner_fixture",
		origin: "chat", autonomy, language: "en-US", maxSteps: 4,
		messages: [{ role: "user", content: "Read both values." }], onEvent: () => undefined,
		mcp: { toolset, call: connector }, streamChat: createChatgptStreamChat({ getAccessToken: async () => "fixture-access", fetch: fetchFn }),
	});
	expect(result.text).toBe("Hello");
	expect(connector).toHaveBeenCalledTimes(2);
	const input = requestBodies[1]!.input as Array<Record<string, unknown>>;
	expect(input.filter((item) => item.type === "reasoning")).toHaveLength(1);
	expect(input.filter((item) => item.type === "function_call").map((item) => item.call_id)).toEqual(["rixture_call_fixture_a", "rixture_call_fixture_b"]);
	expect(input.filter((item) => item.type === "function_call_output").map((item) => item.call_id)).toEqual(["rixture_call_fixture_a", "rixture_call_fixture_b"]);
});

it("plano sem teto de saída para antes das tools após usage ultrapassar saldo",async()=>{
 const bodies:Array<Record<string,unknown>>=[];
 const fetchFn=vi.fn<typeof fetch>(async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));return new Response(readFileSync(new URL(`../../llm/src/responses/__fixtures__/${bodies.length===1?"tools":"text"}.sse`,import.meta.url),"utf8").replaceAll('"lookup"','"mcp__data__lookup"'));});
 const connector=vi.fn(async()=>({ok:true,text:"fixture",truncated:false}));
 const autonomy={level:"autonomous" as const,exceptions:[]};
 const toolset=buildMcpToolset([{id:"conn_fixture",slug:"data",name:"Data",disabledTools:[],tools:[{name:"lookup",inputSchema:{type:"object"},annotations:{readOnlyHint:true}}]}],{autonomy});
 const result=runComputerUse({manager:{} as SandboxManager,getSessionId:async()=>"unused",sandboxEnabled:false,model:"chatgpt/luna",apiKey:"unused",runId:"run_fixture",userId:"owner_fixture",origin:"chat",autonomy,language:"en-US",maxSteps:4,budget:{maxTokens:1},messages:[{role:"user",content:"Read values"}],onEvent:()=>{},mcp:{toolset,call:connector},streamChat:createChatgptStreamChat({getAccessToken:async()=>"fixture-access",fetch:fetchFn})});
 await expect(result).rejects.toMatchObject({name:"BudgetExhaustedError",usage:{planCalls:1}});
 expect(connector).not.toHaveBeenCalled();
 expect(bodies).toHaveLength(1);
 expect(bodies.every(body=>!('max_output_tokens' in body)&&!('max_tokens' in body))).toBe(true);
});

it("última resposta acima do saldo preserva usage e telemetria sem chamada de resumo",async()=>{
 const body=readFileSync(new URL("../../llm/src/responses/__fixtures__/text.sse",import.meta.url),"utf8");
 const fetchFn=vi.fn<typeof fetch>(async()=>new Response(body));
 const records:Array<Record<string,unknown>>=[];
 const result=runComputerUse({manager:{} as SandboxManager,getSessionId:async()=>"unused",sandboxEnabled:false,model:"chatgpt/luna",apiKey:"unused",runId:"run_fixture",userId:"owner_fixture",origin:"chat",language:"en-US",maxSteps:4,budget:{maxTokens:1},messages:[{role:"user",content:"Say hello"}],onEvent:()=>{},onStep:async step=>{records.push(step as unknown as Record<string,unknown>);},streamChat:createChatgptStreamChat({getAccessToken:async()=>"fixture-access",fetch:fetchFn})});
 await expect(result).rejects.toMatchObject({name:"BudgetExhaustedError",usage:{planCalls:1}});
 expect(fetchFn).toHaveBeenCalledTimes(1);
 expect(records.find(record=>record.type==="model")).toMatchObject({telemetry:{provider:"chatgpt",costKind:"plan"}});
});
