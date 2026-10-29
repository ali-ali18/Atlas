# F8 — Bots conversam entre si: consulta (`ask_bot`) e grupos

**Donos:** 8A → Bot B · 8B → Bot A · **Depende de:**
- 8A precisa da F5 (reusa a infraestrutura de run filho).
- 8B precisa de 8A e de o usuário commitar `template-4/*`.
- As duas precisam da F6, se ela já estiver mergeada (idioma por bot).

**Status:** a fazer

## Pedido do usuário
- **Consulta (como no Grok):** um bot chama outro bot para tirar dúvidas e afins. Ex.: a Jujuba pergunta ao bot "Dev" como está o deploy.
- **Grupos:** já existem na UI. Vários bots conversam entre si e com o usuário. Eles **param sozinhos** e só voltam quando algo acontece (evento, rotina, webhook) ou quando o usuário chama.

## Diagnóstico
- **Grupo = um `Bot` com `memberIds`** (`packages/db/prisma/schema.prisma:181`, `packages/shared/src/bot.ts:15`).
  - Criação: `create-bot-header.tsx:101`, `mobile-create-bot.tsx:52-66`, `template-4-client.tsx:603-628` (grupo = `[bot.id, ...memberIds]`, snippet "N bots no grupo").
  - A API aceita e valida (`apps/api/src/routes/bots.ts:36-60,128-131`).
- O grupo tem **uma** conversa (`Bot.conversationId`), mas `ConversationMessage` (`schema.prisma:107-117`) só tem `role` e `content`. **Não registra qual bot falou.**
- O run de chat usa o perfil, a memória e o modelo **do bot da conversa**. Num grupo, quem responde é o "bot-grupo", como se fosse um bot só. Não existe orquestração de turnos.
- **Diferença entre `delegate_task` (F5) e `ask_bot`:**
  - `delegate_task` cria um ajudante genérico e anônimo, com tools restritas.
  - `ask_bot` fala com **outro bot do usuário, com a identidade dele**: descrição, memória (`botId`), skills, modelo e idioma.

---

## 8A — `ask_bot` (consulta bot a bot) — Bot B

### Tarefas
- [ ] **Tool `ask_bot({ bot: string, question: string, context?: string })`:**
  - `bot` é o nome ou id de um bot do **mesmo dono**; não pode ser o próprio nem um bot-grupo;
  - resolver por nome sem acento e sem diferenciar maiúsculas; se o nome for ambíguo, devolver erro com a lista.
- [ ] **O `connectorsPrompt` e o prompt listam os bots consultáveis** (nome + snippet, até 10). O texto vai para o Bot C na F6 (anotar em `REVIEW.md`): "Use `ask_bot` quando outro bot for especialista no assunto ou tiver contexto que você não tem. Não use para o que você mesmo resolve."
- [ ] **Execução:** um run filho **como o bot consultado**, reaproveitando o caminho da F5:
  - `parentRunId`, `origin:"bot_consult"`, `botId` = bot consultado;
  - `prepareMessages` (memória, identidade e skills **dele**, `packages/db/src/memory-context.ts`) + `question` + `context`;
  - o modelo e o idioma dele;
  - tools: MCP read-only + pesquisa + `memory_search`. Sem cards, sem `propose_*`, sem sandbox;
  - **sem `ask_bot` nem `delegate_task`** (profundidade 1, evita ping-pong);
  - orçamento: soft 10, hard 20 passos, 5 min.
- [ ] **Retorno ao pai:** `{ bot, answer (até ~4k), status }`. Falha ou timeout **não** derrubam o pai.
- [ ] **Memória:** o bot consultado **não** grava memória a partir da consulta (fica só na conversa do pai). Registrar `botConsult` no histórico do filho para auditoria.
- [ ] **Eventos:** `bot_consult_started {bot, question}` e `bot_consult_done {bot, answer}`.
  - Web: bloco "Jujuba perguntou ao **Dev**" com a pergunta e a resposta recolhíveis, e o avatar do bot consultado. Reusar o bloco de subagente da F5.
- [ ] **Limites:** até 3 `ask_bot` por run, e no máximo 2 em paralelo (reusar o `Promise.all` da F5, se vierem no mesmo passo).

### Testes
- [ ] O filho usa o perfil, a memória, o modelo e o idioma do bot consultado (mocks de `getBotProfile` e memória).
- [ ] Não consegue consultar bot de outro dono, a si mesmo, nem um bot-grupo; nome ambíguo dá erro com a lista.
- [ ] O filho não vê `ask_bot`, `delegate_task` nem `propose_*`.
- [ ] Timeout do filho → o pai continua.

### Commits
1. `feat(agent): ask_bot — um bot consulta outro com a identidade dele`
2. `feat(web): bloco de consulta entre bots no chat`

---

## 8B — Grupos: vários bots conversando, com pausa automática — Bot A

### Modelo de dados
- [ ] Migration: `ConversationMessage.authorBotId String?` (null = usuário ou sistema) + índice. O histórico de chat e a web exibem o nome e o avatar do autor.
- [ ] Nenhum modelo novo de grupo: continua sendo `Bot.memberIds`. O bot-grupo guarda a conversa, as rotinas e a política do grupo em `policyJson.group`: `{ maxBotTurnsPerWake, mode }`.

### Orquestrador de turnos
Arquivos novos: `packages/shared/src/group-turns.ts` (puro) e `apps/worker/src/processors/group-turn.ts`.
- [ ] **Acordar o grupo:** mensagem do usuário, `@Bot` citado, rotina ou webhook ligado ao bot-grupo (o run de rotina posta o evento na conversa do grupo) ou `ask_bot` direcionado ao grupo (fora do escopo; anotar).
- [ ] **Quem fala** (função pura `pickSpeakers`):
  - `@menção` → os citados, em ordem;
  - sem menção → um roteador barato (uma chamada ao LLM **sem tools**, com o modelo do grupo) recebe as últimas mensagens + nome/snippet/descrição dos membros e devolve 1 ou 2 membros (ou nenhum);
  - fallback determinístico se o roteador falhar: o membro com maior sobreposição de palavras com o snippet.
- [ ] **Cada fala** = um `AgentRun` normal **como aquele membro**:
  - `botId` = membro, `conversationId` = conversa do grupo, `origin:"group"`;
  - histórico com prefixo de autor (`[Dev]: ...`), para que ele saiba quem disse o quê;
  - tools e conectores normais do membro;
  - a resposta é gravada com `authorBotId`.
- [ ] **Bot chamando bot dentro do grupo:** se a resposta de um membro citar `@Outro`, esse outro entra na fila de turnos.
- [ ] **Pausa automática** (função pura `shouldContinue`). Para quando:
  - a fila fica vazia;
  - se atinge `maxBotTurnsPerWake` (padrão 6);
  - um membro responde só `[PASS]` (instrução no prompt de grupo: "responda `[PASS]` se não tiver nada novo a acrescentar"; o `[PASS]` não é gravado);
  - o mesmo par de bots troca mais de 2 mensagens seguidas sem o usuário;
  - ou o usuário manda uma mensagem, o que **cancela** a fila atual e recomeça a partir dela.

  Parado, o grupo fica **ocioso** até o próximo "acordar". Não existe loop em segundo plano.
- [ ] **Prompt de grupo** (texto do Bot C; enviar via `REVIEW.md`): "You are <membro> in a group chat with the user and <outros>. Speak only when you add something; mention @Name to ask another member; reply [PASS] if you have nothing new."
- [ ] **Concorrência:** um turno de grupo por vez por conversa (jobId determinístico `group-<conversationId>`, e o worker processa a fila em sequência).
- [ ] **Web** (em `template-4`, depois de o usuário commitar):
  - bolhas com o avatar e o nome do autor;
  - indicador "Dev está digitando…" durante o turno;
  - estado "grupo em pausa" discreto;
  - autocomplete de `@` com os membros.

### Testes
- [ ] `pickSpeakers`: menções, fallback sem roteador, grupo sem membros.
- [ ] `shouldContinue`: limite de turnos, `[PASS]`, ping-pong do mesmo par, fila vazia.
- [ ] Mensagem do usuário cancela a fila em andamento.
- [ ] Cada fala grava `authorBotId` certo e usa o perfil do membro.
- [ ] Rotina ligada ao grupo acorda o grupo e ele para sozinho.

### Commits
1. `feat(db): autor da mensagem (authorBotId)`
2. `feat(groups): orquestrador de turnos com pausa automática`
3. `feat(web): grupo com autores, menções e estado de pausa`

---

## Critérios de aceite (`/run`)
- Na conversa da Jujuba: "pergunta ao Dev se o deploy de hoje passou" → bloco "Jujuba perguntou ao Dev", com a resposta do Dev usando os conectores dele.
- Grupo "Jujuba + Dev + Pesquisador": "qual o melhor dia para lançar a nova interface do loja exemplo?" → 1 ou 2 bots respondem, citam uns aos outros com `@` quando precisam, e o grupo **para sozinho** em até 6 falas.
- Mandar "@Pesquisador e aí?" → só ele responde.
- Uma rotina do grupo às 9h posta o evento, os membros relevantes comentam e o grupo volta a ficar em pausa.

## Commits feitos
_(preencher)_
