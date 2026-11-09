// Protocolo da capacidade `code` (F8.2) sobre a porta `Sandbox`: os `kind`s das ações e o formato do que volta em `data`.
// A porta é opaca de propósito; ESTE arquivo é o contrato entre a capacidade e o adaptador do worker
// (`apps/worker/src/v4-adapters/code-actions.ts`). Mudou aqui, muda lá, e o teste de contrato dos dois usa estes schemas.
//
// Toda ação leva `sessionId` (menos `code.session` ao criar). O escopo é usuário + sessão: o adaptador procura a sessão
// por `{ id, userId }` e responde "not found" para a de outro dono (nunca "forbidden"), igual às rotas da API.
import { z } from "zod";

export const CODE_KINDS = {
	/** Abre (ou retoma) a sessão de código: container com o repositório clonado. */
	session: "code.session",
	/** Lista arquivos e pastas. */
	list: "code.list",
	/** Lê um arquivo em partes (`offset`/`limit`; devolve `nextOffset`). */
	read: "code.read",
	/** Troca um trecho. O casamento é tolerante a espaço, indentação e CRLF; ambíguo é recusado salvo `replaceAll`. */
	edit: "code.edit",
	/** Cria ou sobrescreve um arquivo inteiro. */
	write: "code.write",
	/** Roda um comando no workspace. O portão (allowlist, bloqueio fixo) já passou na capacidade. */
	shell: "code.shell",
	/** Roda um teste. Mesmo canal do shell; o kind separado deixa a política e o eval distinguirem teste de comando solto. */
	test: "code.test",
	/** `git status` estruturado. */
	gitStatus: "code.git_status",
	/** `git diff` do workspace (ou de um arquivo). */
	diff: "code.diff",
} as const;
export type CodeKind = (typeof CODE_KINDS)[keyof typeof CODE_KINDS];
export const CODE_KIND_LIST: readonly CodeKind[] = Object.values(CODE_KINDS);

export function isCodeKind(value: unknown): value is CodeKind {
	return typeof value === "string" && (CODE_KIND_LIST as readonly string[]).includes(value);
}

const sessionId = z.string().min(1).max(100);

/** Parâmetros por kind (a capacidade monta, o adaptador valida de novo: a fronteira não confia em quem chama). */
const runParams = z.object({ sessionId, cmd: z.string().min(1).max(100_000), cwd: z.string().max(500).optional(), timeoutMs: z.number().int().min(1_000).max(600_000).optional() });
const runResult = z.object({ exitCode: z.number().nullable(), output: z.string(), timedOut: z.boolean().optional(), durationMs: z.number().optional(), spillPath: z.string().optional(), cwd: z.string().optional() });

export const codeParams = {
	session: z.object({ repo: z.string().max(200).optional(), branch: z.string().max(200).optional(), sessionId: sessionId.optional() }),
	list: z.object({ sessionId, path: z.string().max(500).optional(), depth: z.number().int().min(1).max(6).optional() }),
	read: z.object({ sessionId, path: z.string().min(1).max(500), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(5000).optional() }),
	edit: z.object({ sessionId, path: z.string().min(1).max(500), old: z.string().min(1).max(200_000), new: z.string().max(200_000), replaceAll: z.boolean().optional() }),
	write: z.object({ sessionId, path: z.string().min(1).max(500), content: z.string().max(2_000_000) }),
	shell: runParams,
	/** `fullSuite` = o modelo declarou que o dono pediu a suíte inteira; o adaptador confere a raiz do workspace (`pnpm test` na raiz de monorepo). */
	test: runParams.extend({ fullSuite: z.boolean().optional() }),
	gitStatus: z.object({ sessionId }),
	diff: z.object({ sessionId, path: z.string().max(500).optional(), staged: z.boolean().optional() }),
} as const;

const excerpt = z.object({ firstLine: z.number().int(), text: z.string() });

/** O que volta em `SandboxResult.data` por kind. */
export const codeResults = {
	session: z.object({ sessionId, repo: z.string().optional(), branch: z.string().optional(), status: z.string().optional(), /** Comando de teste rápido detectado (ex.: `pnpm test`). */ testCommand: z.string().optional(), note: z.string().optional() }),
	list: z.object({ path: z.string(), entries: z.array(z.object({ path: z.string(), type: z.enum(["file", "dir", "link"]), size: z.number() })), total: z.number(), truncated: z.boolean() }),
	read: z.object({ path: z.string(), content: z.string(), totalLines: z.number(), startLine: z.number().optional(), endLine: z.number().optional(), nextOffset: z.number().nullable(), kind: z.enum(["text", "binary"]).optional(), note: z.string().optional() }),
	edit: z.object({ path: z.string(), diff: z.string(), added: z.number(), removed: z.number(), note: z.string().optional(), excerpt: excerpt.optional(), syntaxError: z.string().optional() }),
	write: z.object({ path: z.string(), created: z.boolean(), bytes: z.number(), diff: z.string(), added: z.number(), removed: z.number(), excerpt: excerpt.optional(), syntaxError: z.string().optional() }),
	/** `spillPath`: a saída passou do limite inline e o resto está num arquivo do workspace (leia com `code.read`). */
	shell: runResult,
	test: runResult,
	gitStatus: z.object({ branch: z.string().nullable(), files: z.array(z.object({ status: z.string(), path: z.string() })), clean: z.boolean() }),
	diff: z.object({ diff: z.string(), empty: z.boolean(), spillPath: z.string().optional() }),
} as const;
export type CodeResultOf<K extends keyof typeof codeResults> = z.infer<(typeof codeResults)[K]>;
