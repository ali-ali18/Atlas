import type { BrowserContext, Route } from "@playwright/test"
import { resolveEffectiveConfig, splitReplySegments } from "@workspace/shared"

/**
 * API simulada no navegador para o E2E mobile: intercepta `/api/auth/*` e `/v1/*` e mantém um
 * "servidor" em memória (conversa, mensagens, runs). Cobre só o caminho dos fluxos testados; o que
 * não é conhecido responde `{}` e é registrado em `unhandled` para o teste poder auditar.
 *
 * Protocolo simulado (hoje): `POST /v1/runs` cria o run; `GET /v1/runs/:id/stream` devolve SSE
 * (`id: N` + `data: {evento}`, retomando por `after`); `POST /v1/runs/:id/inputs` junta uma fala do usuário
 * ao run em andamento; `GET /v1/conversations/:id/messages` devolve o histórico persistido (a resposta final
 * é gravada em uma linha por parágrafo, como o servidor).
 */

export const OWNER = { id: "u-e2e", name: "Dono E2E", email: "owner@example.com" }
const NOW = "2026-10-15T12:00:00.000Z"
const CONVERSATION_ID = "conv-e2e"

type StoredMessage = {
  id: string
  conversationId: string
  role: string
  content: string
  createdAt: string
  /** Marcador de origem acima do balão (rotina, reflexão…). */
  source?: { kind: string; label: string; at: string }
  reactions?: Array<{ actor: "user" | "bot"; emoji: string }>
}

type MemoryEntryRecord = { id: string; target: "user" | "memory"; content: string; source: string | null; createdAt: string; updatedAt: string }
type MemoryChangeRecord = {
  id: string
  botId: string | null
  entryId: string | null
  target: "user" | "memory"
  action: "add" | "replace" | "remove"
  before: string | null
  after: string | null
  source: "chat" | "review" | "reflection" | "user"
  undoOfId: string | null
  createdAt: string
  undoneAt: string | null
}

export type MemorySeed = {
  entries?: Array<{ id: string; target: "user" | "memory"; content: string; source?: string | null; updatedAt?: string }>
  changes?: Array<Partial<MemoryChangeRecord> & { id: string; target: "user" | "memory"; action: "add" | "replace" | "remove" }>
  /** Mudanças cujo desfazer o "servidor" recusa (entrada alterada depois). */
  staleChangeIds?: string[]
}

type RunRecord = { id: string; objective: string; reply: string; createdAt: number; streamed: boolean; streamRequests: number }

export type MockOptions = {
  /** Falas já gravadas no histórico (com reações, se houver). */
  history?: Array<{ role: "user" | "assistant"; content: string; reactions?: Array<{ actor: "user" | "bot"; emoji: string }> }>
  /** "Responder só com reação": mensagens de agradecimento/aceno viram só a reação do bot, sem run. */
  reactionOnly?: boolean
  /** As chamadas de reação do usuário falham (503): exercita o revert + aviso. */
  failReactions?: boolean
  /** Atraso (ms) para a resposta do run ficar pronta no "servidor". */
  replyDelayMs?: number
  /** Resposta do assistente para qualquer mensagem. */
  reply?: string
  /** Cartão de confirmação já presente no histórico. */
  confirmCard?: { confirmId: string; title: string; description?: string }
  /** Atraso (ms) da resposta de `POST /v1/runs` (janela em que o run ainda não existe para o cliente). */
  createRunDelayMs?: number
  /** A primeira conexão do stream cai no meio da resposta (sem `done`); a reconexão pelo cursor entrega o resto. */
  dropFirstStream?: boolean
  /** O stream do run congela (conexão aberta, sem bytes): só o ressincronizar pelo servidor traz a resposta. */
  freezeStream?: boolean
  /** Memória do bot e do perfil já gravada (aba Memória). */
  memory?: MemorySeed
  /** O run grava na memória (tool `memory`) antes de responder: o chat mostra "Memória atualizada · ver". */
  memoryToolInRun?: boolean
  /** Mensagem da reflexão diária já presente no histórico. */
  reflectionMessage?: string
  /** Outros bots do usuário (o `@` do composer os oferece). */
  extraBots?: Array<{ id: string; name: string; description?: string }>
  /** Skills da conta (`/` no composer) e de fábrica. */
  skills?: Array<{ name: string; description: string }>
  builtinSkills?: Array<{ slug: string; name: string; description: string }>
  /** Conectores do usuário (o `@` do composer os oferece como apps): catálogo nativo e MCP próprio. */
  connectors?: {
    catalog: Array<{ id: string; name: string; description?: string; icon?: string; status: string | null }>
    custom?: Array<{ id: string; name: string; url: string; status: string; catalogId?: string; slug?: string; accountLabel?: string | null; authType?: string; tools?: unknown[] }>
  }
  /** APIs conectadas por OpenAPI (lista de Conectores). */
  apiConnections?: Array<Record<string, unknown>>
  /** Resposta de `POST /v1/api-connections/discover` (link com "erro" devolve 422). */
  apiProposal?: Record<string, unknown>
  /** Card de login já presente no histórico (ex.: "Conectar API"): corpo do cartão persistido. */
  loginCard?: Record<string, unknown>
  /** O run executa `run_code` (código + saída + gráfico gerado) antes de responder: o chat mostra o cartão "Executou código". */
  runCodeInRun?: {
    code: string
    summary: string
    ok?: boolean
    imageId?: string
    /** Gráfico nativo (spec já normalizado) emitido pelo run_code. */
    chart?: Record<string, unknown>
    /** Grava os cartões code-run/chart no histórico (o que o servidor faz), para a pré-visualização "após recarregar". */
    persistCards?: boolean
    output?: string
    durationMs?: number
  }
  /** O run chama `generate_image`: `hold` deixa o stream parado após o tool_call (skeleton), `error` falha, `imageIds` entrega as imagens. */
  imageGenInRun?: { count?: 1 | 2; aspectRatio?: string; imageIds?: string[]; hold?: boolean; error?: string }
  /** O run publica uma lista de tarefas (`update_task_list`); `hold` deixa o run ativo (sem resposta final) para a doca do composer. */
  taskListInRun?: { items: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>; hold?: boolean }
  /** Nome do bot principal (padrão "Atlas"). */
  botName?: string
  /** Forma e cor do avatar do bot principal (padrão "rond" e roxo). */
  botShape?: string
  botColor?: string
}

export type MockHandler = (request: { method: string; path: string; body: unknown }) => { status?: number; body: unknown } | undefined

export class MockAtlas {
  /** Respostas extras de um teste/preview (marketplace…); devolver `undefined` segue o fluxo normal. */
  handler: MockHandler | null = null
  readonly requests: Array<{ method: string; path: string; body: unknown }> = []
  readonly unhandled: string[] = []
  readonly messages: StoredMessage[] = []
  private runs = new Map<string, RunRecord>()
  private seq = 0
  private readonly options: Required<Omit<MockOptions, "confirmCard" | "memory" | "memoryToolInRun" | "reflectionMessage" | "history" | "reactionOnly" | "failReactions" | "extraBots" | "skills" | "builtinSkills" | "connectors" | "apiConnections" | "apiProposal" | "loginCard" | "botName" | "botShape" | "botColor" | "runCodeInRun" | "imageGenInRun" | "taskListInRun">> & Pick<MockOptions, "confirmCard" | "memory" | "memoryToolInRun" | "reflectionMessage" | "history" | "reactionOnly" | "failReactions" | "extraBots" | "skills" | "builtinSkills" | "connectors" | "apiConnections" | "apiProposal" | "loginCard" | "botName" | "botShape" | "botColor" | "runCodeInRun" | "imageGenInRun" | "taskListInRun">
  /** Requisições `POST /v1/runs/:id/inputs` aceitas (fala do usuário entregue a um run em andamento). */
  readonly inputs: Array<{ runId: string; content: string }> = []
  readonly memoryEntries: MemoryEntryRecord[] = []
  readonly memoryChanges: MemoryChangeRecord[] = []
  private memorySeq = 0

  constructor(options: MockOptions = {}) {
    this.options = { replyDelayMs: 0, reply: "Olá! Aqui está a resposta do bot.", createRunDelayMs: 0, dropFirstStream: false, freezeStream: false, ...options }
    for (const entry of options.memory?.entries ?? []) {
      this.memoryEntries.push({ source: null, updatedAt: NOW, createdAt: NOW, ...entry })
    }
    for (const change of options.memory?.changes ?? []) {
      this.memoryChanges.push({ botId: "bot-e2e", entryId: null, before: null, after: null, source: "chat", undoOfId: null, createdAt: NOW, undoneAt: null, ...change })
    }
    for (const item of options.history ?? []) {
      const message = this.pushMessage(item.role, item.content)
      if (item.reactions) message.reactions = item.reactions
    }
    if (options.reflectionMessage) {
      const message = this.pushMessage("assistant", options.reflectionMessage)
      message.source = { kind: "reflection", label: "diária", at: NOW }
    }
    if (options.loginCard) this.pushMessage("login", JSON.stringify({ v: 1, kind: "login", status: "pending", ...options.loginCard }))
    if (options.confirmCard) {
      const { confirmId, title, description } = options.confirmCard
      this.pushMessage("confirm", JSON.stringify({ v: 1, kind: "confirm", confirmId, title, description, status: "pending", confirmLabel: "Executar", cancelLabel: "Cancelar" }))
    }
  }

  /** `live`: mensagem criada agora (relógio real); o resto usa a data fixa do fixture. */
  private pushMessage(role: string, content: string, live = false): StoredMessage {
    const message: StoredMessage = {
      id: `m-${++this.seq}`,
      conversationId: CONVERSATION_ID,
      role,
      content,
      createdAt: live ? new Date().toISOString() : new Date(Date.parse(NOW) + this.seq * 1000).toISOString(),
    }
    this.messages.push(message)
    return message
  }

  /** Mensagens do usuário que chegaram à API (para o teste conferir o que foi enviado). */
  postedObjectives(): string[] {
    return this.requests.filter((r) => r.method === "POST" && r.path === "/v1/runs").map((r) => {
      const body = r.body as { objective?: string; messages?: Array<{ role: string; content: string }> }
      return String([...(body?.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? body?.objective ?? "")
    })
  }

  async install(context: BrowserContext): Promise<void> {
    // Login stub: o proxy do Next só olha o cookie de sessão; a sessão de verdade vem do get-session simulado.
    const base = new URL(String(context.pages()[0]?.url() || "http://127.0.0.1")).hostname || "127.0.0.1"
    await context.addCookies([{ name: "better-auth.session_token", value: "e2e-stub", domain: base === "" ? "127.0.0.1" : "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }])
    await context.route(/\/api\/auth\//, (route) => this.auth(route))
    await context.route(/\/v1\//, (route) => this.api(route))
  }

  private json(route: Route, body: unknown, status = 200) {
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
  }

  private async auth(route: Route) {
    const path = new URL(route.request().url()).pathname
    this.requests.push({ method: route.request().method(), path, body: undefined })
    if (path.endsWith("/get-session")) {
      return this.json(route, {
        session: { id: "s-e2e", userId: OWNER.id, token: "e2e-stub", expiresAt: "2099-01-01T00:00:00.000Z", createdAt: NOW, updatedAt: NOW },
        user: { ...OWNER, emailVerified: true, image: null, createdAt: NOW, updatedAt: NOW },
      })
    }
    if (path.endsWith("/providers")) return this.json(route, { github: false, google: false })
    if (path.endsWith("/sign-out")) return this.json(route, { success: true })
    return this.json(route, {})
  }

  private bot() {
    return {
      id: "bot-e2e", name: this.options.botName ?? "Atlas", snippet: "Bot de teste", color: this.options.botColor ?? "#6d5efc", shape: this.options.botShape ?? "rond", description: null, openRouterModel: null,
      language: "pt-BR", pinned: true, pinOrder: 0, notify: true, sectionId: null, memberIds: [], conversationId: CONVERSATION_ID,
      lastMessage: null, unreadResults: 0, unreadCount: 0, firstUnreadMessageId: null, manualUnread: false, isPrimary: true,
      createdAt: NOW, updatedAt: NOW,
    }
  }

  private async api(route: Route) {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()
    let body: unknown = undefined
    try {
      body = request.postData() ? JSON.parse(request.postData() as string) : undefined
    } catch {
      body = request.postData()
    }
    this.requests.push({ method, path, body })

    const custom = this.handler?.({ method, path, body })
    if (custom) return this.json(route, custom.body, custom.status ?? 200)

    if (method === "GET" && path === "/v1/bots") {
      const extras = (this.options.extraBots ?? []).map((extra, index) => ({
        ...this.bot(), id: extra.id, name: extra.name, description: extra.description ?? null, snippet: extra.description ?? "", isPrimary: false, pinned: false, pinOrder: index + 1,
        color: ["#e91e63", "#009688", "#fdd835"][index % 3], conversationId: `conv-${extra.id}`,
      }))
      return this.json(route, { bots: [this.bot(), ...extras] })
    }
    if (method === "GET" && path === "/v1/skills") {
      const skills = (this.options.skills ?? []).map((skill, index) => ({
        id: `sk-${index}`, botId: null, tools: [], enabled: true, createdBy: "user", status: "active", revision: 1, createdAt: NOW, updatedAt: NOW, ...skill,
      }))
      return this.json(route, { skills })
    }
    if (method === "GET" && path === "/v1/mcp/catalog") {
      const entries = (this.options.connectors?.catalog ?? []).map((entry) => ({
        description: "", longDescription: "", category: "productivity", icon: "", developer: "", website: "", sourceUrl: "", authType: "oauth",
        availability: "available", docsUrl: "", skills: [], oauthReady: true, oauthMissingEnv: [], connectionId: null, ...entry,
      }))
      return this.json(route, { entries, secretBoxReady: true })
    }
    if (method === "GET" && path === "/v1/mcp/connections") {
      const connections = (this.options.connectors?.custom ?? []).map((item) => ({
        catalogId: null, slug: item.name.toLowerCase().replace(/W+/g, "_"), authType: "none", tools: [], disabledTools: [], confirmWrites: true,
        lastError: null, accountLabel: null, createdAt: NOW, updatedAt: NOW, ...item,
      }))
      return this.json(route, { connections })
    }
    const mcpItem = path.match(/^\/v1\/mcp\/connections\/([^/]+)$/)
    if (mcpItem && (method === "PATCH" || method === "DELETE")) {
      const list = this.options.connectors?.custom ?? []
      const index = list.findIndex((entry) => entry.id === decodeURIComponent(mcpItem[1]!))
      if (index < 0) return this.json(route, { error: "Conexão não encontrada." }, 404)
      if (method === "DELETE") {
        list.splice(index, 1)
        return route.fulfill({ status: 204 })
      }
      list[index] = { ...list[index]!, ...(body as Record<string, unknown>) } as (typeof list)[number]
      return this.json(route, { connection: { catalogId: null, slug: list[index]!.name.toLowerCase(), authType: "none", tools: [], disabledTools: [], confirmWrites: true, lastError: null, accountLabel: null, createdAt: NOW, updatedAt: NOW, ...list[index] } })
    }
    const apiProposalFor = path.match(/^\/v1\/api-connections\/([^/]+)\/proposal$/)
    if (apiProposalFor && method === "POST") return this.json(route, { proposal: this.options.apiProposal })
    if (method === "POST" && path === "/v1/api-connections/discover") {
      const url = String((body as { url?: string } | undefined)?.url ?? "")
      if (url.includes("erro")) return this.json(route, { error: "Não encontrei a especificação da API nesse link. Tente o link do arquivo OpenAPI (.json ou .yaml)." }, 422)
      return this.json(route, { proposal: this.options.apiProposal })
    }
    if (method === "GET" && path === "/v1/api-connections") return this.json(route, { connections: this.options.apiConnections ?? [] })
    const icon = path.match(/^\/v1\/mcp\/icon\/([^/]+)$/)
    if (icon && method === "GET") {
      // Logo simulada do serviço: cor e inicial derivadas do domínio.
      const host = decodeURIComponent(icon[1]!)
      const hue = [...host].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 360
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="hsl(${hue} 65% 45%)"/><text x="16" y="22" text-anchor="middle" font-family="sans-serif" font-size="18" font-weight="700" fill="#fff">${host.replace(/^(mcp|api)\./, "").charAt(0).toUpperCase()}</text></svg>`
      return route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg })
    }
    const apiOps = path.match(/^\/v1\/api-connections\/([^/]+)\/operations$/)
    if (apiOps && method === "GET") {
      const connection = (this.options.apiConnections ?? []).find((entry) => entry.id === decodeURIComponent(apiOps[1]!))
      const groups = (connection?.groups ?? []) as Array<{ tag: string; read: number; write: number }>
      const slug = (tag: string) => `/${tag.toLowerCase().replace(/\s+/g, "-")}`
      const operations = groups.flatMap((group) => [
        ...Array.from({ length: group.read }, (_, i) => ({
          id: `get-${group.tag}-${i}`, method: "GET", path: i === 0 ? slug(group.tag) : `${slug(group.tag)}/{id${i > 1 ? i : ""}}`,
          summary: i === 0 ? `Lista ${group.tag.toLowerCase()}` : `Obtém um item de ${group.tag.toLowerCase()}`, tag: group.tag, body: false,
          params: i === 0
            ? [{ name: "pagina", in: "query", required: false, type: "integer", description: "Página do resultado, começando em 1." }, { name: "limite", in: "query", required: false, type: "integer", description: "Itens por página (máximo 100)." }, { name: "situacao", in: "query", required: false, type: "string", enum: ["aberto", "fechado", "cancelado"] }]
            : [{ name: i > 1 ? `id${i}` : "id", in: "path", required: true, type: "integer", description: "Identificador do registro." }],
        })),
        ...Array.from({ length: group.write }, (_, i) => ({ id: `post-${group.tag}-${i}`, method: i === 0 ? "POST" : "DELETE", path: slug(group.tag), summary: `${i === 0 ? "Cria" : "Remove"} em ${group.tag.toLowerCase()}`, tag: group.tag, body: i === 0, params: [] })),
      ])
      return this.json(route, { operations })
    }
    const apiItem = path.match(/^\/v1\/api-connections\/([^/]+)$/)
    if (apiItem && (method === "PATCH" || method === "DELETE")) {
      const list = this.options.apiConnections ?? []
      const index = list.findIndex((entry) => entry.id === decodeURIComponent(apiItem[1]!))
      if (index < 0) return this.json(route, { error: "Conexão não encontrada." }, 404)
      if (method === "DELETE") {
        list.splice(index, 1)
        return this.json(route, { ok: true })
      }
      list[index] = { ...list[index], ...(body as Record<string, unknown>) }
      return this.json(route, { connection: list[index] })
    }
    if (method === "GET" && path === "/v1/composio/status") return this.json(route, { configured: false, keyHint: null, secretBoxReady: true, toolCount: 0 })
    if (method === "GET" && path === "/v1/skills/builtin") {
      return this.json(route, { skills: (this.options.builtinSkills ?? []).map((skill) => ({ groups: [], version: 1, body: "", ...skill })) })
    }
    if (method === "GET" && path === "/v1/sections") return this.json(route, { sections: [] })
    if (method === "GET" && path === "/v1/models") return this.json(route, { models: [], defaultModel: "openai/gpt-4o-mini" })
    if (method === "GET" && path === "/v1/push/config") return this.json(route, { enabled: false })
    if (method === "GET" && path === "/v1/push/subscriptions") return this.json(route, { devices: [] })

    // Hub de eventos: o mock não empurra nada (o Playwright não faz streaming), só mantém o canal vivo para
    // exercitar o caminho novo; as respostas dos runs continuam vindo do stream do run.
    if (method === "GET" && path === "/v1/events") {
      return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }, body: ": mock" + String.fromCharCode(10, 10) })
    }
    const messages = path.match(/^\/v1\/conversations\/([^/]+)\/messages$/)
    if (messages && method === "GET") return this.json(route, { messages: this.messages, hasMore: false })
    if (/^\/v1\/conversations\/[^/]+\/runs$/.test(path)) return this.json(route, { runs: [] })
    if (/^\/v1\/conversations\/[^/]+\/runs\/latest-completed$/.test(path)) return this.json(route, { run: null })
    if (/^\/v1\/conversations\/[^/]+\/(read|unread|viewing|results\/seen)$/.test(path)) return this.json(route, { ok: true, unreadCount: 0, manualUnread: false })
    if (path === "/v1/dev-sessions/active") return this.json(route, { items: [] })
    if (path === "/v1/dev-sessions") return this.json(route, { sessions: [] })
    if (/^\/v1\/bots\/[^/]+\/(routines|routine-runs)$/.test(path)) return this.json(route, { routines: [], runs: [] })

    if (method === "GET" && path === "/v1/settings") {
      return this.json(route, {
        settings: { sandboxAutoStart: true },
        config: { v: 1 },
        effective: resolveEffectiveConfig({ user: { config: null }, env: {} }),
        capabilities: { openrouterKey: true, isOwner: true },
      })
    }
    if (method === "GET" && path === "/v1/diagnostics") {
      const check = { ok: true, latencyMs: 3 }
      return this.json(route, {
        generatedAt: NOW,
        api: { version: "0.0.1", commit: "abc1234", commitShort: "abc1234", builtAt: NOW, uptimeSec: 100, node: "v22" },
        worker: { up: true, version: "0.0.1", commit: "abc1234", commitShort: "abc1234", startedAt: NOW, lastBeatAt: NOW },
        services: { postgres: check, redis: check, queues: [] },
        push: { enabled: false, problems: [], subscriptions: 0 },
        sentry: { enabled: false },
        providers: [],
        env: [],
        failures: [],
      })
    }
    const reaction = path.match(/^\/v1\/messages\/([^/]+)\/reactions?$/)
    if (reaction) return this.reactionApi(route, method, reaction[1] as string, body)
    if (method === "POST" && path === "/v1/runs") return this.createRun(route, body as { objective?: string })
    const input = path.match(/^\/v1\/runs\/([^/]+)\/inputs$/)
    if (input && method === "POST") return this.addInput(route, input[1] as string, body as { content?: string })
    const stream = path.match(/^\/v1\/runs\/([^/]+)\/stream$/)
    if (stream && method === "GET") return this.streamRun(route, stream[1] as string)
    const snapshot = path.match(/^\/v1\/runs\/([^/]+)$/)
    if (snapshot && method === "GET") return this.snapshot(route, snapshot[1] as string)
    if (/^\/v1\/runs\/[^/]+\/events$/.test(path)) return this.json(route, { events: [] })

    // Configurações do bot: a autonomia (padrão da conta e do bot) precisa de um corpo válido.
    if (method === "GET" && (path === "/v1/autonomy" || path.endsWith("/autonomy"))) {
      return this.json(route, { stored: null, effective: { level: "balanced", exceptions: [] }, source: "default" })
    }
    const memory = this.memoryApi(route, method, path, body)
    if (memory) return memory

    this.unhandled.push(`${method} ${path}`)
    return this.json(route, {})
  }

  private reactionApi(route: Route, method: string, id: string, body: unknown) {
    const message = this.messages.find((item) => item.id === id)
    if (!message) return this.json(route, { error: "Message not found" }, 404)
    if (method !== "GET" && this.options.failReactions) return this.json(route, { error: "Failed to save reaction" }, 503)
    const others = (message.reactions ?? []).filter((item) => item.actor !== "user")
    if (method === "PUT") message.reactions = [...others, { actor: "user", emoji: String((body as { emoji?: string }).emoji) }]
    if (method === "DELETE") message.reactions = others
    return this.json(route, { reactions: message.reactions ?? [] })
  }

  private addInput(route: Route, runId: string, body: { content?: string }) {
    const content = String(body?.content ?? "")
    this.inputs.push({ runId, content })
    this.pushMessage("user", content)
    return this.json(route, { input: { id: `in-${this.inputs.length}`, seq: this.inputs.length, mode: "join", status: "queued", content } })
  }

  private addMemoryChange(change: Omit<MemoryChangeRecord, "id" | "createdAt" | "undoneAt" | "undoOfId" | "botId"> & { undoOfId?: string | null }) {
    const record: MemoryChangeRecord = { id: `mc-${++this.memorySeq}`, botId: "bot-e2e", undoOfId: null, createdAt: new Date().toISOString(), undoneAt: null, ...change }
    this.memoryChanges.unshift(record)
    return record
  }

  /** Aba Memória: lista, grava, edita, apaga, histórico e desfazer em cima do estado em memória. */
  private memoryApi(route: Route, method: string, path: string, body: unknown): Promise<void> | null {
    const view = (target: "user" | "memory") => ({ entries: this.memoryEntries.filter((entry) => entry.target === target), usage: { used: 0, limit: target === "user" ? 1375 : 2200 } })
    if (method === "GET" && path === "/v1/memory") return this.json(route, { snapshot: { user: view("user"), memory: view("memory") } })
    if (method === "GET" && path === "/v1/memory/changes") return this.json(route, { changes: this.memoryChanges, nextCursor: null })
    if (method === "POST" && path === "/v1/memory") {
      const input = body as { target: "user" | "memory"; content: string }
      const entry: MemoryEntryRecord = { id: `me-${++this.memorySeq}`, target: input.target, content: input.content, source: "user", createdAt: NOW, updatedAt: new Date().toISOString() }
      this.memoryEntries.push(entry)
      this.addMemoryChange({ entryId: entry.id, target: entry.target, action: "add", before: null, after: entry.content, source: "user" })
      return this.json(route, { entry })
    }
    const entryMatch = path.match(/^\/v1\/memory\/entries\/([^/]+)$/)
    if (entryMatch) {
      const entry = this.memoryEntries.find((item) => item.id === entryMatch[1])
      if (!entry) return this.json(route, { error: "Memória não encontrada" }, 404)
      if (method === "PATCH") {
        const content = (body as { content: string }).content
        this.addMemoryChange({ entryId: entry.id, target: entry.target, action: "replace", before: entry.content, after: content, source: "user" })
        entry.content = content
        entry.source = "user"
        entry.updatedAt = new Date().toISOString()
        return this.json(route, { entry })
      }
      if (method === "DELETE") {
        this.memoryEntries.splice(this.memoryEntries.indexOf(entry), 1)
        this.addMemoryChange({ entryId: entry.id, target: entry.target, action: "remove", before: entry.content, after: null, source: "user" })
        return this.json(route, { entry })
      }
    }
    const undoMatch = path.match(/^\/v1\/memory\/changes\/([^/]+)\/undo$/)
    if (undoMatch && method === "POST") {
      const change = this.memoryChanges.find((item) => item.id === undoMatch[1])
      if (!change) return this.json(route, { error: "Mudança não encontrada" }, 404)
      if (this.options.memory?.staleChangeIds?.includes(change.id)) {
        const message = "Não deu para desfazer: essa memória foi alterada depois. Edite ou apague direto na lista."
        return this.json(route, { error: message, code: "stale", message }, 409)
      }
      change.undoneAt = new Date().toISOString()
      const entry = this.memoryEntries.find((item) => item.id === change.entryId)
      if (change.action === "add" && entry) this.memoryEntries.splice(this.memoryEntries.indexOf(entry), 1)
      if (change.action === "replace" && entry && change.before) entry.content = change.before
      if (change.action === "remove" && change.before) this.memoryEntries.push({ id: change.entryId ?? `me-${++this.memorySeq}`, target: change.target, content: change.before, source: null, createdAt: NOW, updatedAt: NOW })
      const undo = this.addMemoryChange({ entryId: change.entryId, target: change.target, action: change.action === "add" ? "remove" : change.action === "remove" ? "add" : "replace", before: change.after, after: change.before, source: "user", undoOfId: change.id })
      return this.json(route, { change: undo })
    }
    return null
  }

  private async createRun(route: Route, body: { objective?: string; messages?: Array<{ role: string; content: string }> }) {
    if (this.options.createRunDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.options.createRunDelayMs))
    const lastUser = [...(body?.messages ?? [])].reverse().find((m) => m.role === "user")
    const objective = String(lastUser?.content ?? body?.objective ?? "")
    if (this.options.reactionOnly && /^(valeu|vlw|obrigad[oa]|ok|blz)[!. ]*$/i.test(objective.trim())) {
      const saved = this.pushMessage("user", objective, true)
      saved.reactions = [{ actor: "bot", emoji: "❤️" }]
      return this.json(route, { runId: null, status: "reacted", enqueued: true, messageId: saved.id, reaction: "❤️" })
    }
    const id = `run-${this.runs.size + 1}`
    this.pushMessage("user", objective, true)
    const confirmMatch = objective.match(/^confirmado(?: sempre)?: (.+)$/)
    const record: RunRecord = { id, objective, reply: confirmMatch ? "Feito: comando executado." : this.options.reply, createdAt: Date.now(), streamed: false, streamRequests: 0 }
    this.runs.set(id, record)
    if (confirmMatch) {
      const card = this.messages.find((m) => m.role === "confirm")
      if (card) card.content = JSON.stringify({ ...JSON.parse(card.content), status: "approved" })
    }
    // A resposta fica gravada no histórico quando o run "termina" no servidor (mesmo que ninguém esteja ouvindo o stream).
    setTimeout(() => {
      const rc = this.options.runCodeInRun
      if (rc?.persistCards) {
        this.pushMessage("code-run", JSON.stringify({ v: 1, kind: "code-run", callId: `rc-${id}`, code: rc.code, status: rc.ok === false ? "error" : "ok", durationMs: rc.durationMs ?? 1200, output: rc.output ?? "" }), true)
        if (rc.chart) this.pushMessage("chart", JSON.stringify({ v: 1, kind: "chart", chartId: `rc-${id}:grafico.chart.json`, spec: rc.chart, filename: "grafico.chart.json" }), true)
      }
      for (const paragraph of splitReplySegments(record.reply)) this.pushMessage("assistant", paragraph, true)
    }, this.options.replyDelayMs)
    return this.json(route, { runId: id, status: "queued", enqueued: true })
  }

  private runReady(record: RunRecord): boolean {
    return Date.now() - record.createdAt >= this.options.replyDelayMs
  }

  private snapshot(route: Route, id: string) {
    const record = this.runs.get(id)
    // Com a conexão derrubada de propósito o run só conta como terminado depois que o cliente reconectou.
    const dropPending = this.options.dropFirstStream && (record?.streamRequests ?? 0) < 2
    const status = record && this.runReady(record) && !dropPending ? "completed" : "running"
    return this.json(route, { run: { id, status, objective: record?.objective ?? "", conversationId: CONVERSATION_ID }, events: [] })
  }

  private async streamRun(route: Route, id: string) {
    const record = this.runs.get(id)
    if (!record) return this.json(route, { error: "run não encontrado" }, 404)
    record.streamRequests += 1
    // Conexão congelada (PWA em segundo plano): aberta, sem nenhum byte, até o teste terminar.
    if (this.options.freezeStream) await new Promise(() => undefined)
    // Espera o "servidor" terminar o run e então entrega os eventos de uma vez (SSE completo).
    const ig = this.options.imageGenInRun
    const waitMs = ig?.hold || this.options.taskListInRun?.hold ? 0 : Math.max(0, record.createdAt + this.options.replyDelayMs - Date.now())
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    record.streamed = true
    const memoryEvents = this.options.memoryToolInRun
      ? [
          { type: "tool_call", id: `t-${id}`, name: "memory", args: JSON.stringify({ action: "add", target: "memory", content: "Prefere respostas curtas" }) },
          { type: "tool_result", id: `t-${id}`, name: "memory", ok: true, summary: "Memória atualizada (add em memory)." },
        ]
      : []
    const rc = this.options.runCodeInRun
    const codeEvents = rc
      ? [
          { type: "tool_call", id: `rc-${id}`, name: "run_code", args: JSON.stringify({ code: rc.code }) },
          ...(rc.chart ? [{ type: "chart", chartId: `rc-${id}:grafico.chart.json`, spec: rc.chart, filename: "grafico.chart.json" }] : []),
          ...(rc.imageId ? [{ type: "images", origin: "assistant", items: [{ artifactId: rc.imageId, mime: "image/png", width: 960, height: 540, alt: "grafico.png" }] }] : []),
          { type: "tool_result", id: `rc-${id}`, name: "run_code", ok: rc.ok ?? true, summary: rc.summary },
        ]
      : []
    const imageEvents = ig
      ? [
          { type: "tool_call", id: `ig-${id}`, name: "generate_image", args: JSON.stringify({ prompt: "gato astronauta", n: ig.count ?? 1, aspect_ratio: ig.aspectRatio ?? "1:1" }) },
          ...(ig.hold ? [] : ig.error
            ? [{ type: "tool_result", id: `ig-${id}`, name: "generate_image", ok: false, summary: ig.error }]
            : [
                { type: "images", origin: "assistant", items: (ig.imageIds ?? ["img-1"]).map((artifactId) => ({ artifactId, mime: "image/png", width: 1024, height: 1024, alt: "Imagem gerada" })) },
                { type: "tool_result", id: `ig-${id}`, name: "generate_image", ok: true, summary: "Imagem gerada." },
              ]),
        ]
      : []
    const tl = this.options.taskListInRun
    const taskEvents = tl ? [{ type: "task_list", runId: id, items: tl.items }] : []
    const half = Math.ceil(record.reply.length / 2)
    const events = tl?.hold ? [{ type: "run", runId: id, status: "running" }, ...taskEvents] : ig?.hold ? [{ type: "run", runId: id, status: "running" }, ...imageEvents] : [
      { type: "run", runId: id, status: "running" },
      ...memoryEvents,
      ...taskEvents,
      ...codeEvents,
      ...imageEvents,
      { type: "assistant_delta", id: `a-${id}`, delta: record.reply.slice(0, half) },
      { type: "assistant_delta", id: `a-${id}`, delta: record.reply.slice(half) },
      { type: "done", message: { role: "assistant", content: record.reply }, model: "mock/e2e" },
    ]
    const after = Number.parseInt(new URL(route.request().url()).searchParams.get("after") ?? "0", 10) || 0
    // Queda no meio: a primeira conexão entrega só o começo e fecha; a reconexão (`after`) entrega o resto.
    const cut = this.options.dropFirstStream && record.streamRequests === 1 ? 2 : events.length
    const body = events
      .map((event, index) => ({ event, id: index + 1 }))
      .filter((item) => item.id > after && item.id <= cut)
      .map((item) => `id: ${item.id}\ndata: ${JSON.stringify(item.event)}\n\n`)
      .join("")
    return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }, body })
  }
}
