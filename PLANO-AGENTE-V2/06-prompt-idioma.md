# F6 — Prompt em inglês + idioma configurável por bot

**Dono:** Bot D (GPT), branch `agente-v2/bot-d` · **Depende de:** ver a divisão abaixo · **Status:** F6a e F6a-web prontas para revisão; F6b pendente

## Divisão para começar já (revisor, 28/09)
A F6 foi dividida em duas para o GPT começar agora sem brigar com os Bots B e C no `computer-use.ts`:

| Parte | O que é | Quando |
|---|---|---|
| **F6a — encanamento do idioma** | migration `Bot.language`; `getBotProfile`, PATCH e tipos; `languageInstruction()` pura; o worker passa `language` para o `runComputerUse`, que **anexa** a instrução ao system prompt (uma linha nova, sem reescrever texto); rotinas, revisão de memória e resumos | **agora** |
| **F6a-web** | seletor "Idioma" em `agent-settings.tsx` | depois que o usuário commitar `template-4/*` |
| **F6b — tradução e enxugamento do prompt** | todo o resto desta fase (traduzir o `SYSTEM_PROMPT` e as injeções, meta abaixo de 9k chars, testes de string) | **só depois** que F3, F4 e F5 estiverem mergeadas (todas mexem no texto do prompt) |

Regras para o Bot D:
- **Worktree próprio**, criado a partir do `checkpoint/agentic-baseline`:
  ```
  git worktree add ../atlas-bot-d -b agente-v2/bot-d checkpoint/agentic-baseline
  cd ../atlas-bot-d
  pnpm install
  ```
  **Não trabalhar no diretório `atlas-agent`**: ele é compartilhado e está sujo com trabalho dos outros bots.
- Na F6a, em `computer-use.ts`: só o parâmetro `language` no `runComputerUse` e a linha que anexa `languageInstruction` ao prompt montado. Nenhum texto existente é alterado.
- Migration gerada no commit, depois de rebase (regra do README).
- Ao terminar a F6a: Status = "F6a pronta para revisão" e uma entrada em `REVIEW.md`.

## Decisão do usuário
Novo campo `Bot.language` com seletor nas configurações do bot, padrão `pt-BR`. **Todo o texto que vai para o modelo passa a ser em inglês.** A UI do app continua em pt-BR.

## Diagnóstico
- Não existe campo de idioma (`Bot`: `schema.prisma:167-192`; `UserSettings`: `:208`). O pt-BR está fixo no prompt ("Responda em português", `computer-use.ts:156`).
- `SYSTEM_PROMPT` (`computer-use.ts:154-352`) tem cerca de 197 linhas e 13,1k chars, todo em pt-BR.
- **Outras injeções de texto que vão para o modelo:**
  - `AGENTIC_RESEARCH_PROMPT` (`:441`), `connectorsPrompt` (`:400`), sufixo de rotina (`:3800`);
  - `BOT_CONFIG_EVENT_SYSTEM_INSTRUCTION` (`:505`, via `:547`/`:3810`), sonda do soft-eval (`:4014`), prompts de fechar card (`:4387-4388`);
  - descrições de todas as tools;
  - `packages/shared/src/questionnaire.ts:217-266` (instruções de resposta), `apps/api/src/chat/skill-intent.ts:959` (`mcpFollowUpContent`);
  - `packages/db/src/memory-context.ts:129,245-265` (memória, identidade do bot), `summaries.ts:252`, `memory-search.ts:183`;
  - `apps/worker/src/processors/routine.ts:138` (`buildUserTurn`), `memory-review.ts:210` (`SYSTEM_PROMPT` próprio), `apps/api/src/chat/memory.ts:29`;
  - `packages/shared/src/skills.ts:193-196` já está em inglês.
- **Texto que o usuário vê e fica em pt-BR:**
  - `friendlyProviderError` (`agent-run.ts:191-197`), `friendlySandboxError` (`computer-use.ts:1266+`);
  - mensagens de orçamento e trava (`:3640-3649`, `:4125`, `:4191`, `:4358`), fallback de limite de passos (`:3968`);
  - questionário de boas-vindas (`agent-run.ts:604-638`), status de orçamento (`agent-run.ts:554`).
- `getBotProfile`: `packages/db/src/bots.ts:71`. PATCH: `apps/api/src/routes/bots.ts`. UI: `apps/web/components/ui/templates/template-4/chat-context-panel/agent-settings.tsx` (seletor de modelo em `:84`).

## Tarefas
- [x] **Migration:** `Bot.language String @default("pt-BR")` (timestamp próprio, diferente do `parentRunId`).
- [x] `getBotProfile` devolve `language`. PATCH `/v1/bots/:id` valida `language ∈ {"pt-BR","en-US","es-ES"}`. Tipos em shared.
- [x] **Web:** seletor "Idioma" em `agent-settings.tsx`, no mesmo padrão do seletor de modelo. `propose_profile_update` **não** mexe em idioma.
- [ ] **Traduzir para inglês** todo o texto da lista acima que vai para o modelo, **sem perder nenhuma regra**. Aproveitar para **enxugar** o `SYSTEM_PROMPT` em seções curtas:
  - Identity
  - Language
  - Tools & honesty
  - Asking questions
  - Reminders & routines (once / cron / interval / github)
  - Connectors (usar o conector e não o navegador; erros por `code`, se a F7.4 estiver pronta)
  - GitHub
  - Delegation (texto da F5)
  - Memory vs profile
  - Research

  Meta: menos de 9k chars.
- [x] **Injeção do idioma** (função pura `languageInstruction(language)`): "Always reply to the user in {language name}. Anything the user will read — card titles, routine names and prompts, questionnaire text, reminders — must also be in {language name}." Aplicar em:
  - chat (`runComputerUse` recebe `language` do worker);
  - rotinas;
  - subagentes (o relatório pode ser em inglês; o pai responde no idioma);
  - revisão de memória e resumos (o resumo fica no idioma do bot).
- [ ] Os helpers de regex pt-BR (`looksLike*` em `packages/shared/src/skill-extract.ts`) **ficam como estão** (detectam o texto do usuário). Se `language != pt-BR`, eles só não disparam, e isso é aceitável.
- [ ] Os testes existentes que checam strings do prompt passam a checar as strings em inglês equivalentes.

## Testes obrigatórios
- [x] `languageInstruction` para os 3 idiomas; o `SYSTEM_PROMPT` final contém a instrução com o idioma do bot.
- [x] O PATCH do bot rejeita um idioma inválido.
- [ ] Todos os replays existentes continuam verdes em inglês (lembrete `once`, questionário de tarefa, gate de perfil, GitHub interval da F3, `delegate_task` da F5).
- [ ] Um snapshot ou teste de tamanho: `SYSTEM_PROMPT.length < 9000`.

## Commits
1. `feat(bots): idioma configurável por bot`
2. `refactor(agent): prompts do modelo em inglês com idioma injetado`

## Critérios de aceite
- No `/run`: mudar o idioma do bot Jujuba para en-US → a resposta e os cards de rotina saem em inglês. Voltar para pt-BR → tudo em pt-BR.
- A bateria manual das fases F1–F5 continua passando depois da tradução.

## Commits feitos
- F6a: `dc29e4f` feat(bots): idioma configurável por bot
- F6a-web: `e83ef22` feat(web): seletor de idioma nas configurações do bot
- Pendente: F6b (tradução dos prompts; commit 2)
