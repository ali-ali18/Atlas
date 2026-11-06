# Memória, caderno e sono (Motor v4, F5)

- **Status:** em andamento (backend entregue; falta a seção "Caderno" e as regras aprendidas na Biblioteca)
- **Data:** 2026-11-06
- **Issues/PRs:** F5.1 e F5.3 do `PLANO-AGENTE-V4`

## O que é
O bot guarda o que importa para você: fatos curtos (memória), notas mais longas (caderno) e, à noite, revisa o dia sozinho e guarda o que vale. Tudo o que ele aprende é visível, editável e pode ser desfeito.

## Problema
Sem caderno, informação estruturada (lista, plano, detalhes de viagem) ou some na conversa ou vira um fato espremido na memória. Sem revisão, o bot só aprende quando você manda. E um bot que aprende escondido (como os concorrentes) não merece confiança.

## Por que existe
- **Caderno:** tabela `notes` própria. O caderno de trabalho do run (`agent_notes`, notas `work:`) é descartável, grande e de chave composta; a nota do dono é pequena, fixável, listada na Biblioteca e entra no histórico desfazível. Misturar as duas poluiria a lista e o ciclo de vida.
- **Sono:** manutenção de fim de dia, no papel de modelo barato `sleep`, para a memória melhorar sem custo por conversa nem polling de modelo.

## Alternativas descartadas
- Estender `agent_notes`: a lista do dono teria de filtrar por prefixo, e o desfazer não caberia na chave composta.
- Sono por regex sobre o texto (detectar "me chamo", "prefiro"): o texto é ambíguo (`60-agente.md`). A fonte é estrutural: a fala do dono, citada por id.
- Dedupe de notas por embedding: as notas não têm vetor (a memória tem). Igualdade normalizada (sem acento, caixa ou pontuação, no mesmo escopo) cobre a repetição literal; o doctor semanal aponta as parecidas. Fatos de memória seguem com embedding quando há chave.
- Sono por mensagem (a cada conversa): uma chamada por bot por dia basta e custa menos.

## Como funciona
- **Caderno:** `notes` (dono, bot opcional, título, texto, fixada, origem). `botId` nulo = nota do dono, vale para todos os bots; preenchido = só daquele bot. O bot do run enxerga as do dono e as suas. Tools `note_search`, `note_get`, `note_add`, `note_update`, `note_pin`, `note_remove` na capacidade `memory` (lazy). Leitura é dado privado do dono; escrita pede confirmação depois de leitura não confiável (inclusive fixar, porque o título fixado entra no `[context]`, que é bloco de sistema). Contexto: até 20 títulos fixados e 1.800 caracteres, só id e título; o resto, por busca.
- **Limites técnicos:** título 120, texto 20.000, 500 notas por dono (a busca varre todas, então nenhuma fica de fora).
- **Sono:** `sleep-sweeper` (worker) a cada 5 min, só de banco; só com a flag do v4 e a conta na lista. Depois das 23:30 no fuso do dono, reserva `(bot, daily, dia)` em `sleep_reports` (a trava entre workers) e roda `runDailySleep`: lê a conversa direta do bot na janela (do fim do sono anterior até o slot), separa a fala do dono (fonte) do resto, faz uma chamada ao modelo `sleep` e confere cada proposta no código (fonte citada existe e é do dono; duplicata). Fatos e notas entram pelas funções da UI com origem `sleep`; habilidades e casos de eval (de `classifyRunFailure` sobre o journal) ficam como proposta no relatório.
- **Doctor:** aos domingos, duplicatas e itens velhos por regra e conflitos por uma chamada com ids conferidos. Só propõe.
- **Desfazer:** `MemoryChange` (alvo `note` para o caderno) guarda antes/depois, origem, relatório e desfazer que recusa com 409 se o item mudou depois.
- **Opt-out:** `policyJson.sleep = false` desliga o sono do bot.

### Rotas (todas atrás do `requireUser`; 404 para recurso alheio)
- `GET /v1/notes?botId=&pinned=true` · `GET /v1/notes/changes?botId=&cursor=&limit=` · `GET|PATCH|DELETE /v1/notes/:id` · `POST /v1/notes` (`{title, body, pinned?, botId?}`). `PATCH` aceita `title`, `body`, `pinned`.
- `GET /v1/bots/:botId/rules` · `PATCH /v1/bots/:botId/rules/:ruleId` (`{verdict?, note?}`) · `DELETE /v1/bots/:botId/rules/:ruleId`.
- `GET /v1/sleep/reports?botId=&kind=daily|doctor` · `GET /v1/sleep/reports/:id` · `POST /v1/sleep/reports/:id/proposals/:proposalId/dismiss` · `GET /v1/sleep/changes?botId=&reportId=`.
- Desfazer qualquer mudança (memória ou nota): `POST /v1/memory/changes/:id/undo`.

## Riscos
- **Migration:** só acréscimo (2 tabelas, 2 colunas nulas); versões mistas de api e worker convivem.
- **Injeção por título fixado:** escrita e fixação pedem confirmação após leitura não confiável; o sono só usa fala do dono; o `[context]` escapa sequências reservadas.
- **Vazamento entre conversas:** o sono lê só `Bot.conversationId` (conversa direta); grupo nunca é lido; bot não enxerga nota de outro bot.
- **Custo:** ver abaixo.
- **Classificação de falha:** o journal só sabe parada e chamadas; hoje só `model.loop` é derivável. As outras classes entram quando o journal guardar mais sinais.
- **`policyJson.rules` agora vale no run:** antes nada as lia. Regras vazias (o caso de hoje) não mudam nada.

## Custo
Sem conversa do dono no dia: zero chamadas. Dia comum: uma chamada ao papel `sleep` (Haiku) com a fala do dono inteira (assistente só como contexto, 1.500 caracteres por fala) mais o que já está salvo. Limite técnico por chamada: 300 mil caracteres (~75 mil tokens); dia maior é dividido em chamadas em ordem. Doctor: uma chamada por semana e bot. "Bom dia" não muda: as tools do caderno são lazy (uma linha de índice, medido < 60 tokens) e o trecho dos fixados só existe quando há nota fixada.

## Como testar
`pnpm --filter @workspace/shared test`, `pnpm --filter @workspace/agent test`; `pnpm --filter @workspace/db test:db` (notas, relatórios, regras); worker `sleep-run.test.ts`, `sleep-sweeper.test.ts`, `sleep.db.test.ts`; api `notes.test.ts`, `bot-rules.test.ts`, `sleep.test.ts`, `notes.db.test.ts`.
