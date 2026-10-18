import { describe, expect, it } from "vitest";
import { toAnthropicMessages } from "./anthropic/convert.js";
import { chatRequestBody, type LlmMessage } from "./chat-tools.js";
import { toResponses } from "./responses/to-responses.js";
import { withoutImages } from "./opencode/stream.js";

const PDF = "data:application/pdf;base64,JVBERi0xLjQ=";
const messages: LlmMessage[] = [
	{ role: "user", content: [{ type: "text", text: "Resuma" }, { type: "file", file: { filename: "contrato.pdf", file_data: PDF } }] },
];

describe("PDF nativo por provedor", () => {
	it("OpenRouter: parte `file` segue no corpo de chat/completions e desliga os fallbacks de texto", () => {
		const body = chatRequestBody({ apiKey: "k", model: "anthropic/claude-sonnet-4.5", messages, tools: [], fallbackModels: ["a/b"] } as never, false) as { messages: LlmMessage[]; models?: string[] };
		expect(JSON.stringify(body.messages)).toContain('"type":"file"');
		expect(JSON.stringify(body.messages)).toContain(PDF);
		expect(body.models ?? []).toEqual([]);
	});

	it("Anthropic: vira bloco `document` base64 com título", () => {
		const { messages: converted } = toAnthropicMessages(messages);
		const blocks = converted[0]!.content;
		expect(blocks[1]).toEqual({ type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQ=" }, title: "contrato.pdf" });
	});

	it("Anthropic ignora file que não é PDF em Data URL", () => {
		const bad: LlmMessage[] = [{ role: "user", content: [{ type: "text", text: "x" }, { type: "file", file: { filename: "a.txt", file_data: "data:text/plain;base64,YQ==" } }] }];
		expect(toAnthropicMessages(bad).messages[0]!.content).toHaveLength(1);
	});

	it("ChatGPT (Responses): vira input_file", () => {
		const { input } = toResponses(messages, "gpt-5");
		const content = (input[0] as { content: Array<Record<string, unknown>> }).content;
		expect(content[1]).toEqual({ type: "input_file", filename: "contrato.pdf", file_data: PDF });
	});

	it("OpenCode Go: documento vira aviso de texto se o modelo recusar", () => {
		const out = withoutImages(messages);
		expect(JSON.stringify(out)).toContain("document omitted");
		expect(JSON.stringify(out)).not.toContain(PDF);
	});
});
