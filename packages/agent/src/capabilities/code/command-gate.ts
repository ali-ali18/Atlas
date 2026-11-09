// Portão de comando da capacidade `code`: a lógica PURA do v2 (`shared/dev-command-approval`: parser, bloqueio fixo,
// allowlist, leitura de .env) vira uma classe de efeito do v4. Nada de regex sobre texto do usuário ou do modelo: o
// parser de shell é determinístico e o resultado é um enum.
//
// Mapa (decisão F8.2, documentada em docs/features/codigo-v4.md):
//  - bloqueio fixo (`hardDenyReason`): o executor RECUSA, mesmo com aprovação. O v2 perguntava; no v4 o que é irreversível
//    ou sai do ambiente não tem cartão, porque o cartão seria um atalho para o que a política quer impedir.
//  - só leitura (ls, cat, git log…): `read`. Roda em `plan`.
//  - na allowlist: `write_internal` (o workspace é do dono e o git desfaz).
//  - fora da allowlist / não analisável: `destructive` (cartão em toda autonomia; sem dono, a tool some).
//  - ler .env e parentes: `credential` (cartão em toda autonomia; sem dono, some).
import { DEFAULT_COMMAND_ALLOWLIST, type CommandSegment, decideCommand, hardDenyReason, isFullSuiteTestCommand, isReadOnlySegment, parseCommand, type FullSuiteMatch } from "@workspace/shared";
import type { Effect } from "../../contract/effects.js";

/** Executores de teste aceitos por `code_test` além dos scripts de teste da allowlist padrão. Leem e rodam código do repositório. */
export const TEST_RUNNER_PREFIXES: readonly string[] = [
	"pnpm test", "pnpm run test", "pnpm exec vitest", "pnpm exec jest", "pnpm vitest", "pnpm jest", "npm test", "npm run test", "yarn test",
	"npx vitest", "npx jest", "node --test", "pytest", "python -m pytest", "python3 -m pytest", "go test", "cargo test", "mvn test", "gradle test", "bundle exec rspec", "mix test",
];

/** Allowlist do v4: a do v2 mais os executores de teste (rodar um teste focado não pode virar cartão toda vez). */
export const CODE_COMMAND_ALLOWLIST: readonly string[] = [...DEFAULT_COMMAND_ALLOWLIST, ...TEST_RUNNER_PREFIXES];

export type ShellClass =
	| { kind: "deny"; reason: string }
	| { kind: "read" }
	| { kind: "run" }
	| { kind: "ask"; reason: "sensitive-read" | "not-allowed" | "unparseable" | "risky" | "mode" | "hard-deny"; detail?: string };

export function classifyShell(cmd: string, allowlist: readonly string[] = CODE_COMMAND_ALLOWLIST): ShellClass {
	const parsed = parseCommand(cmd);
	const denied = hardDenyReason(cmd, parsed);
	if (denied) return { kind: "deny", reason: denied };
	const decision = decideCommand({ cmd, mode: "allowlist", allowlist });
	if (decision.action === "ask") return { kind: "ask", reason: decision.reason, ...(decision.detail && { detail: decision.detail }) };
	if (parsed.ok && parsed.segments.every(isReadOnlySegment)) return { kind: "read" };
	return { kind: "run" };
}

export function shellEffect(cls: ShellClass): Effect {
	switch (cls.kind) {
		case "read":
			return "read";
		case "ask":
			return cls.reason === "sensitive-read" ? "credential" : "destructive";
		default:
			// `deny` fica em write_internal: o executor recusa antes de tocar a VM; a classe só precisa ser a mais branda para o cartão não ser pedido à toa.
			return "write_internal";
	}
}

function matches(words: readonly string[], prefix: string): boolean {
	const tokens = prefix.split(" ");
	return tokens.length <= words.length && tokens.every((token, index) => words[index] === token);
}

/** O comando é uma execução de teste? Todo trecho que não é só leitura precisa casar com um executor conhecido. */
export function isTestCommand(cmd: string): boolean {
	const parsed = parseCommand(cmd);
	if (!parsed.ok) return false;
	const acting = parsed.segments.filter((segment: CommandSegment) => segment.words.length > 0 && !isReadOnlySegment(segment));
	return acting.length > 0 && acting.every((segment: CommandSegment) => TEST_RUNNER_PREFIXES.some((prefix) => matches(segment.words, prefix)));
}

/** Suíte completa do monorepo: só roda quando o modelo declara `fullSuite: true` (o dono pediu); sem isso, volta o conselho. */
export function fullSuiteOf(cmd: string): FullSuiteMatch | null {
	return isFullSuiteTestCommand(cmd, { rootIsWorkspace: false });
}
