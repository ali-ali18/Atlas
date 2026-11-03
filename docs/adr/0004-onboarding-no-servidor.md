# ADR 0004: o onboarding do bot novo é disparado pelo servidor

- **Status:** aceito (decisão do dono: "via servidor, para ficar controlado por um lado só")
- **Data:** 2026-11-03

## Contexto

O onboarding de um bot recém-criado (apresentação em 1ª pessoa, questionário uma pergunta por vez, no fim `propose_profile_update`) era disparado pelo **cliente web**: depois de `POST /v1/bots`, o `createBot()` do `template-4-client.tsx` chamava `POST /v1/runs` com o system prompt, `objective: "[bot-created] ..."`, `silent: true` e `clientKey = bot-created:<botId>:<hash>`. O runtime libera `propose_profile_update` só em run `[bot-created]` ou com pedido explícito. O app móvel vai criar bots e precisa do mesmo onboarding; duplicar o prompt e o disparo em cada cliente deixaria o comportamento em dois lugares.

## Decisão

- `POST /v1/bots` enfileira o run de onboarding logo após criar o bot, pelo mesmo caminho de `POST /v1/runs` (`createAgentRun` + `enqueueAgentRunJob`, função de serviço em `apps/api/src/chat/bot-onboarding.ts`, sem HTTP interno). O dono vem da sessão.
- Prompt, objetivo, chave (`bot-created:<botId>`) e mensagens são funções puras em `packages/shared/src/bot-onboarding.ts` (texto para o modelo em inglês, curto, em seções), com teste de string.
- Só bot comum: grupo (`memberIds`) não tem onboarding. `onboarding:false` no corpo desliga (cliente que não quer).
- **Idempotência por conversa:** existe no máximo um run com objetivo `[bot-created]` na conversa do bot. O serviço não cria outro e `POST /v1/runs` devolve o existente (200, `enqueued: true`) quando recebe um objetivo `[bot-created]` para uma conversa que já tem um. Isso cobre o deploy misto (web antigo, cuja `clientKey` tem hash e por isso não colide com a nova) e repetições.
- Falha ao criar ou enfileirar o onboarding só registra aviso (sem a mensagem do erro) e o 201 da criação continua. Run criado e não enfileirado é recuperado pelo reconcile de runs `queued` sem job.
- O web deixa de disparar o run e de manter o prompt e o hash.

### Catálogo e proposta de bot

`POST /v1/catalog/bots/:slug/install` e a aprovação de `bot-proposal` **não** disparam onboarding. O comportamento atual já era esse e há motivo: o bot do catálogo nasce com perfil pronto e já posta a `firstMessage`; a proposta aprovada traz `first_task` e um briefing do próprio agente. Perguntar "qual o seu papel?" a um bot cujo papel já foi definido seria ruído e custo de tokens.

## Alternativas descartadas

- **Manter o disparo no cliente e só copiar para o móvel:** dois prompts e dois disparos para manter em sincronia; foi justamente o que o dono não quis.
- **Fila própria ou tabela de "onboarding pendente":** o objetivo `[bot-created]` na conversa já é a marca de que o onboarding existe; tabela nova só adiciona migration e estado.
- **Chave `clientKey` única como única defesa:** a deduplicação por `clientKey` vale por run (`runId`, `clientKey`), não impede um segundo run, e o web antigo usa outra chave.

## Consequências e riscos

- Deploy misto: api nova + web antigo — o run do servidor sai primeiro; o do web é recusado pelo guarda (200 com o run existente). Api antiga + web novo — bot criado sem onboarding até a api subir (janela curta, aceita).
- Corrida: o run do servidor é gravado antes do 201 de `POST /v1/bots`, então o web antigo (que só pede o seu depois do 201) já encontra o run e é barrado pelo guarda. A corrida real só existe se o servidor falhou em criar o run (fila ou banco fora); nesse caso o run do web antigo nasce normalmente, o que é benigno: o bot recebe o onboarding uma vez.
- A criação do bot espera a criação do run (resolver modelo e gravar): alguns ms a mais no `POST /v1/bots`.
- O serviço reaproveita do `POST /v1/runs` a escolha do modelo, a checagem de catálogo e chave do provedor (`checkRunModel`), o `contextLength` e a máscara de segredos do cofre. Modelo inutilizável: nenhum run nasce (`skipped`, com aviso), em vez de um run que falha calado no worker.
- Idioma: o único texto "do usuário" do run é o evento em JSON (chaves em inglês), que no modo `auto` faria o bot se apresentar em inglês. O prompt traz o idioma do bot, ou o do navegador (`Accept-Language`) no modo auto, ou pt-BR.
- O guarda de duplicidade só vale para pedido silencioso de chat com objetivo `[bot-created]` (sem diferenciar maiúsculas) e só casa run de onboarding de verdade (um run digitado pelo dono, `humanTurn`, não conta). O 200 diz `enqueued:false` se o run existente ainda não tem job.
- Segurança, follow-up: `propose_profile_update` é liberado pelo objetivo `[bot-created]`, que um cliente pode forjar (já era assim). Proposta: gravar uma marca interna no `budgetJson` do run de onboarding (como `humanTurn`) e o runtime passar a exigi-la. Fica para outra entrega porque exige mudança em `agent-runtime` e no web antigo (que não grava a marca).
