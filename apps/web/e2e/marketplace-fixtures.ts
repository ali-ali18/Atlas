import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { MockHandler } from "./mock-api"

/** Dados simulados do catálogo (habilidades e agentes) para as capturas do Marketplace. */
const CATALOG_DIR = process.env.SKILLS_CATALOG_DIR
const SHA = "a".repeat(64)

function robloxBody(): string {
  if (CATALOG_DIR) {
    const text = readFileSync(join(CATALOG_DIR, "skills/roblox/SKILL.md"), "utf8").replace(/\r\n/g, "\n")
    return text.split("\n---\n").slice(1).join("\n---\n").trim()
  }
  return "# Roblox development with Rojo (Luau)\n\nYou build Roblox experiences as plain files inside the VM and compile them with Rojo.\n\n## 0. Ground rules\n\n- Never print an API key.\n- Publish only to the TEST place the user gave you."
}

const skillBase = { author: "ali-ali18", tags: [] as string[], path: "", sha256: SHA, manifestSha256: SHA }
const skills = (installs: unknown[], version = "1.0.0") => [
  {
    ...skillBase,
    slug: "roblox",
    name: "roblox",
    description: "Desenvolve jogos Roblox em Luau com Rojo dentro da VM e publica por Open Cloud em um lugar de TESTE informado pelo usuário.",
    version,
    category: "games",
    tools: ["shell", "secret_list", "secret_request", "propose_questionnaire"],
    path: "skills/roblox",
    installs,
  },
  {
    ...skillBase,
    slug: "relatorio-semanal",
    name: "relatorio-semanal",
    description: "Monta o relatório da semana a partir das tarefas concluídas e das reuniões.",
    version: "1.2.0",
    author: "ana-dev",
    category: "productivity",
    tools: ["calendar"],
    path: "skills/relatorio-semanal",
    installs: [],
  },
  {
    ...skillBase,
    slug: "revisao-de-pr",
    name: "revisao-de-pr",
    description: "Revisa um pull request com checklist de testes, segurança e legibilidade.",
    version: "0.3.1",
    author: "carlos-s",
    category: "dev",
    tools: ["github", "shell"],
    path: "skills/revisao-de-pr",
    installs: [],
  },
]

const bots = [
  { slug: "dev-roblox", name: "Dev Roblox", description: "Luau, Rojo e publicação em lugar de teste", version: "1.0.0", author: "ali-ali18", category: "games", tags: [], skills: ["roblox"], color: "red", shape: "squircle", path: "bots/dev-roblox", sha256: SHA },
  { slug: "pesquisador", name: "Pesquisador", description: "Pesquisa com fontes e resume em tópicos curtos", version: "1.1.0", author: "ana-dev", category: "research", tags: [], skills: [], color: "blue", shape: "bean", path: "bots/pesquisador", sha256: SHA },
]

const skillDetail = (installs: unknown[], version = "1.0.0") => ({
  entry: skills(installs, version)[0],
  changelog: [
    ...(version === "1.1.0" ? [{ version: "1.1.0", date: "2026-10-20", notes: "Passo de teste no Studio mais claro e aviso sobre tipos de instância não suportados." }] : []),
    { version: "1.0.0", date: "2026-10-17", notes: "Primeira versão: Rojo 7.7.1, layout de projeto, convenções Luau e publicação Open Cloud em lugar de teste." },
  ],
  body: robloxBody(),
  tools: ["shell", "secret_list", "secret_request", "propose_questionnaire"],
  findings: [],
  installs,
})

const botDetail = {
  entry: bots[0],
  bot: {
    slug: "dev-roblox",
    name: "Dev Roblox",
    description: "Você é um desenvolvedor Roblox sênior. Escreve Luau com Rojo dentro da VM, compila o lugar e publica sempre em um lugar de TESTE informado pelo usuário.",
    snippet: "Luau, Rojo e publicação em lugar de teste",
    color: "#FF263C",
    shape: "squircle",
    suggestedModel: "openai/gpt-4o",
    skills: ["roblox"],
    suggestedConnectors: [{ id: "github", reason: "Opcional: guardar o projeto em um repositório." }],
    setupNotes: ["Guarde sua chave de API do Roblox no cofre quando o agente pedir.", "Tenha em mãos o universeId e o placeId de um lugar de TESTE."],
    starterRoutines: [
      { name: "Resumo das mudanças da semana", prompt: "Resuma o que mudou no projeto esta semana.", cron: "0 9 * * 5" },
    ],
    firstMessage: "Oi! Sou o Dev Roblox.",
    version: "1.0.0",
    author: "ali-ali18",
    category: "games",
    tags: [],
    changelog: [{ version: "1.0.0", date: "2026-10-17", notes: "Primeira versão." }],
  },
  skills: [{ slug: "roblox", name: "roblox", description: "Desenvolve jogos Roblox em Luau com Rojo.", version: "1.0.0", tools: ["shell", "secret_list"], blocked: false }],
  connectors: [{ id: "github", reason: "Opcional: guardar o projeto em um repositório.", connected: false }],
  findings: [],
}

export function catalogHandler(options: { installs?: unknown[]; version?: string; conflict?: boolean } = {}): MockHandler {
  const installs = options.installs ?? []
  const version = options.version ?? "1.0.0"
  return ({ method, path }) => {
    if (method === "GET" && path === "/v1/catalog") return { body: { skills: skills(installs, version), bots } }
    if (method === "GET" && path === "/v1/catalog/skills/roblox") return { body: skillDetail(installs, version) }
    if (method === "GET" && path === "/v1/catalog/bots/dev-roblox") return { body: botDetail }
    if (method === "POST" && path === "/v1/catalog/skills/roblox/install") {
      return options.conflict
        ? {
            status: 409,
            body: {
              error: "Você editou esta skill.",
              code: "edited",
              installedVersion: "1.0.0",
              catalogVersion: version,
              diff: { added: 3, removed: 1, identical: false, preview: ["- Default `versionType` is `Saved`.", "+ Default `versionType` is `Saved` (never live).", "+ Always report the versionNumber.", "+ Ask for the place id before publishing."] },
            },
          }
        : { body: { action: "installed", id: "d1" } }
    }
    return undefined
  }
}

