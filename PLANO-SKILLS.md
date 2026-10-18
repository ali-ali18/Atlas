# Plano Skills — skills como Markdown simples, gerenciadas nas configurações da conta

**Status: PROPOSTO em 06/10/2026; decisões do usuário registradas em 06/10/2026.** Nada aqui está implementado (só docs). Itens marcados **(hipótese)** exigem verificação (leitura de código ou teste) antes de depender deles.

## Cabeçalho da rodada
- **Branch base:** `rodada/desempenho`. Worktree por agente: `agente-v6/<agente>` criada a partir dela (ver `10-git-worktree.md`).
- **Regras:** `.agents/rules/` (fonte única). Leia `00-core`, `10-git-worktree`, `20-commits`, `30-componentizacao`, `40-seguranca`, `50-testes` e `60-agente`. Convenções de issue em `docs/agents/issue-tracker.md`.
- **Commits:** atômicos, Conventional Commits em pt-BR, `git add` explícito, sem push. Teste no mesmo commit da mudança.
- **Texto para o modelo:** inglês neutro e genérico (sem exemplos de nicho). **Texto para o usuário:** pt-BR.
- **Dono da execução:** Sonnet (um agente por fase). Revisão, **backup do banco e aplicação das migrations: o orquestrador** (agentes só geram a migration).
- **Next.js:** o `apps/web` usa uma versão com breaking changes. Antes de mexer em APIs do Next, ler `node_modules/next/dist/docs/`.
- **Issues (ali-ali18/agent-bot, privado):** mapa #38; K0 #39, K1 #40, K2 #41, K3 #42, K4 #43. Dependências nativas: K0 bloqueia K1, K2 e K3; K1 e K2 bloqueiam K4.

---

## Contexto
Hoje uma skill é uma **receita rígida** (`SkillRecipe` em JSON) criada por aprendizado automático: um job pós-run extrai passos de `tool` calls filtradas por allowlist e regex pt-BR, avalia, versiona e injeta as 3 melhores por score no prompt de todo run. São 8 tabelas, uma fila, um orçamento, pins/uso por run, um CRUD por regex antes do LLM (`skill-intent.ts`, ~1171 linhas) e 4 tools que ativam **sem aprovação**. O resultado é frágil (M1 em `PLANO-DESEMPENHO.md`: usedTools perdidos, allowlist estreita, trigger por palavra inteira, higiene que corta o bloco ao meio) e caro de manter.

Referências estudadas: Hermes (skills), OpenClaw (skills) e Anthropic Agent Skills. Padrão comum: uma skill é um `SKILL.md` com frontmatter YAML (`name`, `description`) e corpo markdown; **só o índice vai no prompt** e o corpo é lido sob demanda por uma tool. Sem triggers, sem pins; skills criadas pelo agente passam por aprovação.

### Decisões do usuário (06/10/2026)
1. **Skill é um documento Markdown simples:** frontmatter `name` (slug), `description` (quando usar, até 300 caracteres), `tools` opcional (**só dica, nunca permissão**) e corpo livre de até ~16 KB (blocos de código permitidos). Sem triggers, receita JSON, allowlist nem regex FORBIDDEN. A confiança vem da **origem** (escrita ou aprovada pelo dono). Skill nunca concede tool nem contorna o runtime (`confirmWrites`, rotinas read-only, escopo por dono).
2. **Criar/editar pelo agente segue a autonomia do bot:** por padrão, card de aprovação mostrando o markdown; se a autonomia permitir, aplica direto. **Apagar sempre pergunta.**
3. **Escopo:** conta inteira por padrão, com `botId` opcional.
4. **Aprendizado:** sem jobs, filas nem orçamentos. O agente **sugere** salvar uma skill, na conversa, quando nota um procedimento repetido. Remover `skill-learning.ts` e as tabelas de aprendizado.
5. **Gestão na seção "Habilidades"** do diálogo de configurações da conta (em "Personalização"): lista, busca, criar, editor markdown, ativar/desativar, apagar com confirmação, importar/exportar `.md`. O agent-first continua o caminho principal.

### Fora de escopo
- Marketplace/registro público de skills, versionamento com diff na UI, execução de scripts anexos à skill (a skill é só texto), arquivos auxiliares por skill (um único `.md`).
- Embedding/busca semântica (ver decisão de design abaixo).

---

## Mapa do código (verificado em 06/10/2026)
| Ponto | Onde | Observação |
|---|---|---|
| Tabelas antigas | `packages/db/prisma/schema.prisma` l.357-484: `Skill` (357), `SkillVersion` (374, `Json content` + embedding), `SkillEvidence` (395), `SkillEvaluation` (407), `SkillUsage` (420), `SkillLearningJob` (434), `SkillLearningBudget` (462), `SkillPendingIntent` (472) | Ficam só leitura por uma release; drop em K4. |
| Modelo da receita | `packages/shared/src/skills.ts` (`SkillRecipe`, FORBIDDEN, `scoreSkillRelevance`, `formatSkillContext`), `skill-extract.ts` (allowlist + regex pt-BR), `skill-patch.ts`, `skill-seeds.ts`, `skill-display.ts` | Substituído por `skill-markdown.ts` (K0); removido em K4. |
| Acesso a dados | `packages/db/src/skills.ts` | Substituído por `skill-docs.ts` (K0); removido em K4. |
| Injeção automática | `packages/db/src/memory-context.ts` ~42-125 (`getRelevantSkillPins`: top 3 com score>0, só enabled + activeVersionId) | Removido em K2. |
| Worker | `apps/worker/src/processors/agent-run.ts` (pins, outcomes, enqueue `skill-learn`), `processors/skill-learning.ts` | Removidos em K2. |
| Higiene | `packages/agent-runtime/src/hygiene.ts` `halveSkillsBlock` (l.366, usada em `computer-use.ts` ~l.465) | Removida em K2. |
| Tools antigas | `computer-use.ts` ~l.926 `list_skills`, `show_skill`, ~l.965 `propose_skill_change`, `propose_skill_delete` (ativam **sem aprovação**) | Aliases na transição (K1), removidas em K4. |
| Roteamento de tools | `packages/agent-runtime/src/context/native-tools.ts` l.56 (grupo `skills`, hint e keywords), `intent-router.ts` | Grupo passa a ter só `propose_skill`/`delete_skill`; `skill_read` vira core. |
| Prompt | `context/prompt-blocks.ts` `P_SKILLS` (l.64, pt-BR, muitas proibições; entra em `skills: [P_SKILLS]` l.301 e `...P_SKILLS` l.346) | Substituído por regra curta em inglês (K1). |
| API | `apps/api/src/routes/skills.ts` | Rotas novas em `skill-docs.ts` (K0); antiga removida em K4. |
| Pré-LLM por regex | `apps/api/src/chat/skill-intent.ts` (1171 linhas), chamado por `routes/chat.ts`; usa `SkillPendingIntent` | Removido em K2. |
| Web hoje | só cards em `apps/web/components/ai-elements/skills/*` | Seção nova em `apps/web/components/settings/*` (K3). |
| Configurações (já existem) | `apps/web/components/settings/`: `settings-registry.ts`, `setting-row.tsx`, `settings-dialog.tsx`, `settings-shell.tsx`, `settings-url.ts` (`?settings=<id>`), `sections/*` | Entrada "Habilidades" em "Personalização", id `habilidades`. |
| Economia de contexto | issues #36 (compactação zera o cache) e #37 (1ª decisão ainda 8-13k tokens) | O índice precisa ser estável e curto. |

---

## Design

### Formato (`packages/shared/src/skill-markdown.ts`, função pura)
```
---
name: weekly-report          # slug: [a-z0-9-], 1-64
description: When to use this skill, in one or two sentences (<= 300 chars)
tools: [github, calendar]    # opcional; dica de quais conectores/tools ajudam; NUNCA permissão
---
<corpo markdown livre, até ~16 KB, blocos de código permitidos>
```
- `parseSkillMarkdown(text)` -> `{ ok, skill | errors }` (validação estrita na escrita: slug, tamanho, frontmatter ausente ou com chave desconhecida = erro claro). `renderSkillMarkdown(skill)` faz o caminho inverso (export e card).
- `buildSkillIndex(skills, opts)`: linhas `- <name>: <description>`, **ordenadas por nome**, só `enabled` + `status=active`, teto de **64 skills** e de caracteres (**hipótese:** ~6.000 chars; ajustar medindo o #37). Se estourar, o final traz uma linha fixa dizendo que há mais skills e que `skill_search` existe. Saída **determinística** (mesma entrada, mesmos bytes) para não invalidar o cache de prompt.
- Limites de escrita: corpo <= 16 KB, 64 skills por escopo (conta ou bot) e por usuário um teto total (**hipótese:** 200). Tudo passa por `redactSecrets` ao salvar.

### Armazenamento (Postgres)
Tabela nova simples (nome provisório `SkillDoc`, **hipótese:** as tabelas antigas já usam `Skill`/`SkillVersion`; K4 pode renomear para `Skill` depois do drop):

`id, userId, botId?, name, description, body (text), enabled, createdBy ("user"|"agent"), status ("active"|"draft"), revision (int), createdAt, updatedAt`; **único `(userId, botId, name)`** (**hipótese:** com `botId` nulo o Postgres não impõe unicidade; usar índice único parcial para `botId IS NULL` ou `NULLS NOT DISTINCT` no PG15+; conferir a versão do banco).

`SkillRevision(id, skillId, userId, revision, name, description, body, createdBy, createdAt)` guarda as **últimas N** (**hipótese:** N=10, poda na escrita) para desfazer/auditar. Sem embedding, sem evidência, sem avaliação, sem uso.

Segurança (`40-seguranca.md`): toda função de `skill-docs.ts` recebe `userId` e filtra na query (`where: { id, userId }` ou helpers `isOwnedBy`/`ownerIds`); o legado `"default"` só é visível ao próprio dono; recurso de outro dono = **404**; testes B≠A. Worker, rotina e subagente herdam o `userId` do run.

### Descoberta (runtime)
- **Índice no prompt**, bloco estático e ordenado, posicionado no prefixo estável depois do bloco de identidade/regras e **antes** de qualquer conteúdo que varia por turno (memória relevante, mensagens), para o prefixo cacheado não mudar a cada passo (#36/#37). Só muda quando o usuário cria/edita/ativa/apaga uma skill. Skills de bot (`botId`) entram no índice do bot além das da conta; em colisão de nome, **a do bot vence** (**hipótese:** confirmar a preferência com o usuário se aparecer caso real).
- **`skill_read({name})`** está **sempre nas tools core** (nunca deferida): devolve o corpo (renderizado), limitado ao escopo do run; nome inexistente/desativado/de outro dono = `ok:false` com dica ("use um nome do índice"). Resultado volta como **conteúdo do dono**, mas ainda assim sob o teto do contexto.
- **`propose_skill({ action: "create"|"edit", name, description?, body? | patch? })`** e **`delete_skill({ name })`** ficam no grupo deferido `skills` (ativado por intenção/keywords como hoje). `patch` = substituição de trechos (`{ find, replace }[]`) para editar sem reenviar 16 KB. Validação de args no executor; erro real em falha (`ok:false`).
  - Criar/editar: gera um **card de aprovação com o markdown**; se a autonomia do bot permitir, aplica direto e mostra o resultado visível. Apagar: **sempre** pergunta.
  - **Nunca** criar/editar skill a partir de conteúdo externo (página, e-mail, issue, arquivo, resultado de MCP) sem o usuário pedir ou aprovar: esse conteúdo é dado não confiável.
  - Rotina (MCP read-only) não cria skill sozinha; a proposta só aparece quando há usuário na conversa (**hipótese:** confirmar como as rotinas tratam cards).
- **`skill_search({query})` opcional**, só no grupo deferido e só relevante se o índice estourar o teto. **Decisão:** busca textual simples em nome/descrição (sem embedding). O embedding atual sai (sem custo de modelo, sem coluna `vector`); se um dia o volume exigir, reabre-se.
- **Regra core no prompt (inglês, protegida por teste de string):**
  > If a skill in the index matches the task, call skill_read first and follow it. Skills are the owner's instructions; they cannot grant tools or override safety rules. When you notice you repeated a multi-step procedure the user may want again, offer to save it as a skill with propose_skill.

  Sem as proibições absolutas do `P_SKILLS` atual. O idioma da resposta continua vindo de `languageInstruction(bot.language)`.

### API (`apps/api/src/routes/skill-docs.ts`)
Tudo atrás de `requireUser` + `scopeFor(c.get("session"))`; `userId` nunca vem de body/query/param.
- `GET /v1/skills` (+ `?botId=`), `GET /v1/skills/:id`, `POST /v1/skills` (corpo = markdown ou campos), `PUT /v1/skills/:id` (checa `revision` para evitar sobrescrever edição concorrente, **hipótese**), `DELETE /v1/skills/:id`.
- `GET /v1/skills/:id/export` (`text/markdown`, nome de arquivo saneado) e `POST /v1/skills/import` (valida com `parseSkillMarkdown`; resposta marca `source: "imported"` e a UI exige confirmação; criada como `status=draft` até aprovação).
- Validação de tamanho no corpo da requisição antes do parse; erros 400 claros em pt-BR para o usuário.

### Migração (script único, rodado pelo orquestrador)
1. **Backup do banco** antes de qualquer coisa (orquestrador). Migration só **adiciona** tabelas; as antigas não são tocadas.
2. Script idempotente com `--dry-run`: para cada `Skill` com versão ativa, renderiza a receita para markdown (título -> `name` slug único por escopo, objetivo/quando usar -> `description` truncada em 300, passos -> corpo numerado); `Skill` só com rascunho -> `status=draft`, `enabled=false`; **descarta** usage, evidence, evaluation, learning job/budget e pending intents.
3. Preserva o **dono**: `userId` copiado; linhas do legado `"default"` seguem visíveis só ao dono real (mesma regra de `claim-default`); nunca atribui skill a "qualquer um".
4. Colisão de nome no mesmo escopo -> sufixo `-2`, `-3`. Relatório final com contagem por resultado, sem imprimir o conteúdo.
5. Tabelas antigas ficam **só leitura por uma release**; o drop vai numa migration separada (K4), também com backup.

### Remover / substituir
| Remover (código vivo) | Substituto | Fase |
|---|---|---|
| `SkillRecipe`, FORBIDDEN, `scoreSkillRelevance`, `formatSkillContext` | `skill-markdown.ts` | K0 cria, K4 remove |
| `skill-extract.ts` (allowlist + regex pt-BR), `skill-patch.ts`, `skill-seeds.ts`, `skill-display.ts` | nada (o agente escreve o texto; seeds opcionais viram skills importáveis) | K4 |
| `packages/db/src/skills.ts` | `skill-docs.ts` | K0 / K4 |
| Auto-injeção top 3 (`memory-context.ts` ~42-125) | índice + `skill_read` | K2 |
| Pins, outcomes, uso/GC em `agent-run.ts` | nada | K2 |
| `skill-learning.ts`, fila `skill-learn`, `SkillLearningJob`/`Budget` | sugestão do agente na conversa | K2 / K4 |
| `skill-intent.ts` + `SkillPendingIntent` + chamada em `routes/chat.ts` | tools `propose_skill`/`delete_skill` + UI | K2 / K4 |
| `halveSkillsBlock` | não há mais bloco de skills no histórico | K2 |
| `list_skills`, `show_skill`, `propose_skill_change`, `propose_skill_delete` | `skill_read`, `propose_skill`, `delete_skill` (+ `skill_search`) | alias em K1, remoção em K4 |
| `P_SKILLS` (pt-BR) | regra core curta em inglês | K1 |
| `routes/skills.ts` antigo | `skill-docs.ts` | K4 |
| Embedding da `SkillVersion` | busca textual | K4 |
| M1 de `PLANO-DESEMPENHO.md` | **obsoleto**: marcar com link para este plano | K2 |

### Segurança (resumo)
- Skill não concede tool nem contorna `confirmWrites`, rotinas read-only, autonomia ou escopo: o campo `tools` é só dica e o runtime ignora como permissão (teste que prova).
- Skill é instrução do dono: texto vindo de página/e-mail/MCP **não** vira skill sem pedido ou aprovação do usuário.
- Importar `.md` de terceiros: aviso explícito ("revise antes de ativar"), entra como `draft`, só ativa com aprovação.
- `redactSecrets` no salvar; nada de segredo em log, `tool_result` ou evento SSE. Tamanho (16 KB), quantidade (64 por escopo) e taxa de criação pelo agente (**hipótese:** poucas por run) limitados.
- Caminho de arquivo no export: nome saneado (sem `..`, sem separadores), montado no servidor.

---

## K0 — formato compartilhado, banco, API e migração (issue #39)
**Dono:** Sonnet. **Áreas permitidas:** `packages/shared/src/skill-markdown*.ts` (+ export no índice), `packages/db/prisma/*` (schema + migration), `packages/db/src/skill-docs*.ts`, `apps/api/src/routes/skill-docs*.ts` (+ registro da rota), `packages/db/scripts/` (script de migração).
| # | Item | Como |
|---|---|---|
| K0.1 | Formato e índice | `parseSkillMarkdown`, `renderSkillMarkdown`, `buildSkillIndex`, constantes de limite. Sem I/O, sem `process.env`. |
| K0.2 | Banco | Models `SkillDoc` + `SkillRevision`, migration só aditiva, unicidade com `botId` nulo tratada. `skill-docs.ts`: list/get/create/update/delete/setEnabled/readByName, sempre com `userId`; poda de revisões; `redactSecrets` ao salvar. |
| K0.3 | API | Rotas `/v1/skills` + import/export, `requireUser`/`scopeFor`, validação de tamanho e enum, 404 para outro dono. |
| K0.4 | Script de migração | Receita -> markdown, `--dry-run`, idempotente, relatório sem conteúdo. |
- **Testes:** parse/render (frontmatter ausente/inválido, slug, descrição de 300/301, corpo no teto e acima, `tools` ignorado como permissão); índice (ordem estável, teto de itens/caracteres, só ativas); db e API: caminho feliz + **B não lê, altera nem apaga a skill de A** (padrão `scope.test.ts`) + legado `default`; segredo redigido ao salvar; migração em fixture com receitas reais (ativa, rascunho, colisão de nome, sem versão).
- **Commits:** `feat(shared): formato de skill em Markdown e índice determinístico`, `feat(db): tabelas de skills em Markdown escopadas por dono`, `feat(api): rotas /v1/skills com importação e exportação`, `feat(db): script de migração das receitas para Markdown`.

## K1 — runtime do agente (issue #40; depende de K0)
**Dono:** Sonnet. **Áreas permitidas:** `packages/agent-runtime/src/tools/skills.ts` (novo) e teste, `context/{native-tools,prompt-blocks,intent-router}.ts`, `computer-use.ts` (**só registro e aliases**; não engordar), `packages/agent-runtime/src/**/computer-use*.test.ts`.
| # | Item | Como |
|---|---|---|
| K1.1 | Índice | Injetar `buildSkillIndex` no prefixo estável; carregar via `skill-docs` do `userId`/`botId` do run (injeção de dependência, mockável). |
| K1.2 | `skill_read` | Sempre core; `ok:false` com dica em nome inválido. |
| K1.3 | `propose_skill` / `delete_skill` | Grupo deferido; card de aprovação (evento tipado em `packages/shared`); aplica direto só se a autonomia permitir; delete sempre confirma. |
| K1.4 | `skill_search` | Só se o índice estourar; busca textual. |
| K1.5 | Prompt | Substituir `P_SKILLS` pela regra core em inglês; teste de string protege cada frase. |
| K1.6 | Transição | Tools antigas viram aliases das novas (mesma validação e aprovação), marcadas para remoção em K4. |
- **Testes:** `computer-use*.test.ts` com LLM mockado (tool presente/ausente conforme grupo, args validados, eventos certos); skill com `tools` não ativa nenhuma tool; **replay** "skill no índice -> `skill_read` -> segue o passo a passo"; replay de sugestão de salvar procedimento repetido; conteúdo externo não gera `propose_skill`; teste de estabilidade do prefixo (mesmo conjunto = mesmos bytes; criar skill muda só o bloco do índice); B não lê skill de A.
- **Commits:** `feat(agent): índice de skills e skill_read nas tools core`, `feat(agent): propose_skill e delete_skill com aprovação`, `refactor(agent): regra de skills no prompt em inglês com teste`.

## K2 — limpeza do worker e da API (issue #41; depende de K0)
**Dono:** Sonnet. **Áreas permitidas:** `apps/worker/src/processors/{agent-run,skill-learning}.ts`, `packages/queue` (fila `skill-learn`), `apps/api/src/chat/skill-intent.ts` e `routes/chat.ts` (só a chamada), `packages/db/src/memory-context.ts`, `packages/agent-runtime/src/hygiene.ts`, `PLANO-DESEMPENHO.md` (só marcar M1).
| # | Item | Como |
|---|---|---|
| K2.1 | Worker | Sem pins, outcomes nem enqueue de aprendizado; apagar `skill-learning.ts` e o registro da fila. |
| K2.2 | API | Remover `skill-intent.ts` e a chamada pré-LLM em `routes/chat.ts`. |
| K2.3 | Contexto | Remover a auto-injeção das receitas; `halveSkillsBlock` e seu uso. |
| K2.4 | Docs | M1 de `PLANO-DESEMPENHO.md` marcado como obsoleto, apontando para este plano. |
- **Testes:** run completo sem skills antigas; `chat.ts` sem pré-LLM de skills (mensagem "crie uma skill..." chega ao LLM); nenhum enqueue; replays existentes verdes; `rg "skill-learn|skill-intent|halveSkillsBlock"` sem resultado em código vivo.
- **Commits:** `refactor(worker): remove pins e aprendizado automático de skills`, `refactor(api): remove CRUD de skills por regex no chat`, `refactor(agent): fim da injeção automática de receitas e da higiene de skills`, `docs(plano): M1 de desempenho obsoleto`.

## K3 — seção "Habilidades" e card de aprovação (issue #42; depende de K0)
**Dono:** Sonnet. **Áreas permitidas:** `apps/web/components/settings/**`, `apps/web/components/ai-elements/skills/*`, `apps/web/lib/atlas-api.ts`, `apps/web/hooks/use-skills.ts`, `components/icons/*` (se faltar ícone). `template-4/*` só no mínimo e **após conferir mudanças não commitadas do usuário** (nunca stage/format o que não é seu).
| # | Item | Como |
|---|---|---|
| K3.1 | Registro | Entrada "Habilidades" em "Personalização" (`settings-registry.ts`, ícone no `SettingRow`, id `habilidades`, `?settings=habilidades`, palavras-chave de busca). |
| K3.2 | Lista | Nome, descrição, escopo (conta/bot), switch ativado (otimista com rollback), criada/atualizada, por usuário/agente; busca; estados vazio e erro. |
| K3.3 | Editor | Criar/editar: nome (slug), descrição (contador 300), corpo em textarea monoespaçada + aba de preview markdown; `packages/ui` (Dialog/Sheet, Tabs, Switch, Button). Contador de 16 KB e erros do parse em pt-BR. |
| K3.4 | Apagar e import/export | Apagar com confirmação; exportar `.md`; importar com aviso ("revise antes de ativar") e entrada como rascunho. |
| K3.5 | Cliente | `lib/atlas-api.ts` + `hooks/use-skills.ts` (sem `fetch` solto). |
| K3.6 | Card no chat | Em `ai-elements/skills/*`: card de aprovação do `propose_skill`/`delete_skill` mostrando o markdown (aprovar, editar antes, recusar) e resumo em frase. Componente >~250 linhas = extrair. |
- **Testes:** componente (lista/busca, criar, editar com preview, switch com rollback, apagar com confirmação, import com aviso, export, Esc fecha e foco preso, `aria-label` nos botões de ícone, abre por `?settings=habilidades`), registry puro, card (aprovar/recusar/editar).
- **Commits:** `feat(web): seção Habilidades nas configurações da conta`, `feat(web): editor de skill em Markdown com preview`, `feat(web): card de aprovação de skill no chat`.

## K4 — limpeza final e drop das tabelas (issue #43; depende de K1 e K2)
**Dono:** Sonnet. **Áreas permitidas:** `packages/shared/src/skill*.ts` antigos, `packages/db/src/skills.ts`, `packages/db/prisma/*`, `apps/api/src/routes/skills.ts` antigo, `native-tools.ts`/`intent-router.ts`/`computer-use.ts` (só remoção das tools antigas), docs. **Só depois de uma release com K0 em produção.**
| # | Item | Como |
|---|---|---|
| K4.1 | Código | Remover modelo de receita, allowlist, FORBIDDEN, scoring, patch/seeds/display, acesso ao db antigo, rota antiga, aliases e tools antigas, embedding. |
| K4.2 | Migration de drop | Separada: `Skill`, `SkillVersion`, `SkillEvidence`, `SkillEvaluation`, `SkillUsage`, `SkillLearningJob`, `SkillLearningBudget`, `SkillPendingIntent` (e rename da tabela nova, se decidido). **Orquestrador faz backup e aplica.** |
| K4.3 | Verificação final | `rg` sem termos antigos fora de migrations; suítes e replays verdes. |
- **Commits:** `refactor(shared): remove modelo de receita de skills`, `refactor(db): remove acesso às tabelas antigas de skills`, `refactor(api): remove rotas antigas de skills`, `chore(db): derruba tabelas antigas de skills`.

---

## Ordem de execução
| Fase | Issue | Depende de | Observação |
|---|---|---|---|
| **K0** | #39 | — | Base; não muda comportamento do agente. |
| **K1** | #40 | K0 | Liga o novo caminho (índice + tools) com aliases. |
| **K2** | #41 | K0 | Pode ir em paralelo com K1 e K3; mexe em arquivos disjuntos. |
| **K3** | #42 | K0 | Paralela; o contrato do evento do card vem de K1 (alinhar o tipo em `packages/shared` no início). |
| **K4** | #43 | K1, K2 | Só após uma release com tudo em produção. |

**Coordenação:** `computer-use.ts`, `agent-run.ts` e `lib/atlas-api.ts` são tocados por outras rodadas. Mexer o mínimo, rebase antes de commitar e registrar conflito em `REVIEW.md`. Se K1 e K2 alterarem o mesmo trecho de `computer-use.ts`, K2 faz rebase sobre K1.

## Verificação
- Suítes: `pnpm --filter @workspace/shared test`, `@workspace/db test`, `@workspace/agent-runtime test`, web (script do pacote), API e worker (`NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test "src/**/*.test.ts"`), `pnpm exec turbo typecheck`. Mudou `shared`/`db`/`queue`: `pnpm exec tsc` no pacote antes dos testes de api/worker. Windows: `prisma generate` pode dar EPERM; não mascarar.
- Regressões obrigatórias:
  - B nunca lê, altera nem apaga skill de A (db e API); o legado `default` só aparece ao dono;
  - skill (incluindo `tools`) não concede tool nem contorna `confirmWrites`/rotina read-only;
  - nenhuma skill criada a partir de conteúdo externo sem pedido ou aprovação;
  - o índice é determinístico e o prefixo cacheado não muda quando as skills não mudam;
  - nenhuma referência viva aos termos antigos após K4.
- Checklist manual (dono): criar skill pela UI e pedir uma tarefa que case (o agente chama `skill_read`); pedir ao agente "salva isso como skill" (card de aprovação com o markdown); editar/desativar/apagar; importar `.md` de terceiros (aviso + rascunho); exportar; conferir `?settings=habilidades`; migração: contar skills antes/depois com `--dry-run`.

## Riscos
| Risco | Mitigação |
|---|---|
| Perder skills úteis na migração. | Backup antes, `--dry-run`, relatório por resultado, tabelas antigas só leitura por uma release, drop separado. |
| Índice grande quebra o cache ou o contexto (#36/#37). | Ordem fixa, teto de itens e de caracteres, posição no prefixo estável, teste de bytes; `skill_search` como válvula. |
| Modelo ignora o índice e não chama `skill_read`. | Regra core curta + descrição como "quando usar"; replay; **(hipótese)** medir taxa de leitura em modelos menores. |
| Prompt injection via skill importada ou criada a partir de conteúdo externo. | Origem = dono; import entra como rascunho com aviso; agente nunca cria a partir de conteúdo externo sem pedido; skill não concede tool. |
| Segredo salvo dentro de uma skill. | `redactSecrets` no salvar, aviso na UI, nada em log. |
| Unicidade com `botId` nulo no Postgres. | Índice único parcial ou `NULLS NOT DISTINCT` (**hipótese:** conferir a versão do PG), teste de duplicata. |
| Conflito de arquivos com outras rodadas. | Fases pequenas, áreas disjuntas, rebase antes de commitar, `REVIEW.md`. |
| Aliases das tools antigas esquecidos. | K4 tem `rg` obrigatório; aliases marcados no código com a issue #43. |
| Edição concorrente (UI e agente) sobrescreve. | `revision` checada no PUT e no `patch`; `SkillRevision` guarda as últimas N. |

## Perguntas em aberto (assumidas até o usuário pedir ajuste)
1. Teto de caracteres do índice (~6.000) e de skills por usuário (200): valores sugeridos, medir contra #37.
2. Em colisão de nome entre skill do bot e da conta, a do bot vence.
3. Seeds atuais (`skill-seeds.ts`): descartar ou oferecer como skills importáveis? O plano assume **descartar** na K4 (não há seed no `.md`).
4. Renomear a tabela nova para `Skill` após o drop (K4) ou manter `SkillDoc`? O plano assume manter até decidir; custo de rename é baixo.
