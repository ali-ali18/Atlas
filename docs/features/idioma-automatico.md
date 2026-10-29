# Idioma automático do bot

- **Status:** entregue (aguardando merge)
- **Data:** 2026-10-29
- **Issues/PRs:** branch `feat/lang-bot`

## O que é
O bot responde no idioma em que você escreveu por último (pt-BR, en-US ou es-ES), sem configurar nada. No campo "Idioma" do bot e no padrão da conta aparece "Automático"; ainda dá para fixar um idioma.

## Problema
O idioma do bot era um valor fixo, com padrão pt-BR. O projeto vai ser aberto (open source) e não é só para o Brasil: quem escreve em inglês ou espanhol recebia resposta em português até achar o seletor. Rotinas, alertas e o "Seu dia" também saíam no idioma fixo, e as mensagens de erro e de trava do sistema eram sempre pt-BR.

## Por que existe
O idioma certo é o de quem fala, e o servidor consegue saber isso de graça. A detecção é uma heurística local e determinística; o modelo só recebe uma linha curta no fim do prompt. Onde não há mensagem do usuário (rotina, alerta, workers), vale o último idioma gravado, sem custo.

## Alternativas descartadas
- **`franc-min` (biblioteca de detecção):** erra em frase curta de chat, pesa mais que três tabelas de ~100 palavras e adiciona dependência. A tabela por idioma vem do registro e idioma novo é uma entrada só.
- **Detecção toda pelo modelo:** funcionaria no chat, mas rotina, alerta e workers não têm mensagem para o modelo olhar, e não haveria idioma gravado para eles. O servidor precisa do estado de qualquer jeito.
- **Migrar os bots antigos para "auto":** o usuário veria a resposta mudar de idioma sem pedir. Só bots novos nascem "Automático".
- **Traduzir toda a interface agora:** cerca de 330 arquivos `.tsx` e 96 pontos com "pt-BR" fixo (15 a 30 PRs). Fica para quando houver usuário real que não fale português.

## Como funciona
- **Valor `"auto"`** em `Bot.language` (continua texto). Registro de idiomas em `packages/shared/src/language-registry.ts`; resolvedor `resolveReplyLanguage` em `packages/shared/src/bot-language.ts`.
  - Idioma fixo: comportamento de antes.
  - `auto` com mensagem do usuário: instrução curta no fim do prompt ("siga a última mensagem; se ambígua, o último idioma gravado"). A persona não leva a linha de idioma, então o prefixo em cache fica estável.
  - `auto` sem mensagem: último idioma da conversa ou da conta, depois o locale da conta (idioma do navegador), depois pt-BR, com a instrução fixa de sempre.
- **Detecção e gravação** (`packages/shared/src/language-detect.ts`): remove código, URL, caminho, menção, emoji, citação e texto colado ou a traduzir; exige 20 letras e 4 palavras, vencedor com 3+ indícios e 2x o segundo. O primeiro idioma grava na hora; trocar exige 2 mensagens seguidas ou uma de 120+ letras. Só texto digitado (chat não silencioso, mensagem no meio do run, fala no grupo).
- **Estado** (`packages/db/src/user-language.ts`): `lastLanguage`/`pendingLanguage` em `conversations` e `user_settings`, mais `uiLocale`/`browserLocale`. Sempre escopado por `userId`; a gravação usa compare-and-set (perdeu a disputa, relê uma vez, depois desiste). Grupo segue quem falou por último.
- **Fiação:** `computer-use.ts` (inclui `swapLanguageInstruction` na retomada e subagentes, que herdam o idioma do pai), `apps/worker/src/processors/agent-run.ts` e workers de resumo, compactação, memória, lições, skills e reflexão. Resumo de compactação nunca usa "siga a mensagem".
- **API** (`apps/api/src/routes/bots.ts`, `groups.ts`): aceita `"auto"`; desconhecido continua 400. Bot novo sem idioma explícito usa o padrão da conta, senão "auto".
- **Mensagens do sistema** (`packages/shared/src/system-messages.ts`): dicionário `Record<BotLanguage, …>` com limites, "Parei porque…", repetição sem progresso, retomada, falha de lembrete e `describeRunError`. Idioma novo = o compilador cobra a entrada. Texto de modelo continua em inglês.
- **Web:** opção "Automático" no seletor do bot (`agent-settings.tsx`) e no padrão da conta; ditado em "auto" usa o idioma do navegador.
- **Migration:** `20261205000000_language_auto`, só colunas nuláveis, sem backfill.

## Riscos
- **Ordem do deploy:** aplicar a migration `20261205000000_language_auto` antes (aditiva e nula). Depois api e worker; o **web só depois da api**, para a UI não oferecer "Automático" a uma api que o recusa (400).
- **Versões mistas:** worker ou api antigos leem `"auto"` como pt-BR (`isBotLanguage` falha e cai no padrão); nada quebra, só responde em pt-BR até atualizar. Reverter o web não afeta nada.
- **Falso positivo da heurística** (código, citação, "traduza isto: ..."): mitigado por limiar de tamanho, remoção de citações e texto colado e regra de 2 confirmações; coberto por teste.
- **Corrida entre envios simultâneos:** compare-and-set; no pior caso a troca chega uma mensagem depois.
- **Cache de prompt:** a linha de idioma fica no fim e a persona não embute o idioma gravado.
- **Bots com idioma fixo, evals e replays:** sem mudança de comportamento; cenários de evals aceitam `bot.language: "auto"`.

## Custo
Praticamente zero em tokens: uma linha curta no fim do prompt, do mesmo tamanho da instrução de idioma fixo (o "Bom dia" da economia tem teste de tamanho). A detecção é local, sem chamada ao modelo e sem dependência nova.

## Como testar
- `pnpm --filter @workspace/shared test`: resolvedor, detecção (curta, emoji, código, citação, colado, mista, 2 confirmações), persona, `system-messages`.
- `pnpm --filter @workspace/db test` (Postgres de teste): estado de idioma, outro usuário não lê nem grava (IDOR), compare-and-set, bot novo com o padrão da conta.
- `pnpm --filter @workspace/agent-runtime test`: replay com LLM mockado (inglês, depois a rotina em en-US; "ok" não troca; grupo com duas pessoas), tamanho do "Bom dia".
- api e worker: `PATCH`/`POST` de bots com `"auto"`, desconhecido 400.
- web: seletor com "Automático".
