# Alertas inteligentes (regra conferida pelo servidor)

- **Status:** em andamento (etapa 1 de 6: base da regra, página pública e feed)
- **Data:** 2026-10-30
- **Plano:** "Plano dos alertas inteligentes" (aprovado pelo dono em 30/10/2026; as etapas seguintes vêm cada uma em seu PR)
- **Issues/PRs:** #

## O que é
O bot entende o pedido ("me avisa se o tênis baixar de R$ 400 nessa página") uma vez e grava uma regra. O servidor confere a regra sozinho, sem gastar IA a cada conferência, e só avisa quando a condição passa a valer. Para quem usa nada muda: pede pelo chat do mesmo jeito.

## Problema
Todo alerta por condição era uma execução do modelo a cada conferência (token, latência e aviso falso por interpretação). Para um número ou um item novo numa página pública isso é caro e frágil.

## Por que existe
Valor exato e item novo não pedem julgamento: dá para ler o dado e comparar. A regra num formato fechado e validado impede que uma página mande o servidor fazer outra coisa, e o custo de IA vai a zero por conferência.

## Alternativas descartadas
- Script ou código gerado pelo modelo: superfície de ataque grande e difícil de validar. A regra é dado (campos fixos), nunca código.
- Frequência mínima fixa de produto (ex.: 1 h): o dono decidiu que o bot escolhe a frequência. Fica só um piso técnico por fonte (página 30 min, feed 15 min) para não sobrecarregar sites de terceiros.
- Sistema novo de agendamento: reaproveita rotinas (cron e intervalo), `planAlertRun` e `settleAlertRun`.
- Serviço novo de leitura: o leitor mora em `packages/search`, que já tem o guard SSRF, `linkedom` e o limite de tamanho.

## Como funciona
- **Formato** (`packages/shared`, `alert-rule*.ts`): `alertJson.rule` opcional. `source`: `page` (`css` com atributo opcional, `jsonpath` pequeno, `regex` com checagem estática) ou `feed` (RSS/Atom); a união é extensível (cotação, câmbio, clima e conector entram nas próximas etapas). `check`: `value` (`number|money|text` com `lt lte gt gte eq neq between contains changed_pct`) ou `new_item`. `message` com só `{value}`. `intervalMinutes` escolhido pelo bot e ajustado ao piso da fonte. Campo desconhecido é recusado listando o aceito. A `condition` em linguagem natural é gerada da regra (a UI e os filtros seguem iguais).
- **Avaliação pura** (`alert-rule-eval.ts`): número pt-BR e en ("R$ 1.234,56", "$1,234.56"), debounce de 2 leituras seguidas, aviso único com rearme só quando o valor sai da condição com folga de 0,5%, salto brusco (>60%) tratado como suspeito até a leitura seguinte confirmar, valor vazio/ilegível/absurdo = sem veredito, item novo por id estável (guid, link ou hash do título) com no máximo 200 ids vistos. O estado fica em `alertJson.ruleState`.
- **Leitor** (`packages/search/src/alert-source.ts`): GET anônimo, só http(s), bloqueia loopback, rede privada, link-local e metadados de nuvem antes e depois do DNS, em cada redirect (máximo 3) e na conexão real; o endereço IPv6 é normalizado em bytes, então IPv4 embutido (`::ffff:7f00:1`, `::127.0.0.1`, NAT64, 6to4) vale como o IPv4 de dentro; 10 s e 2 MB; respeita o `robots.txt` do site (cache de 1 h por origem; falha ao ler o robots não bloqueia); User-Agent `atlas-agent/0.1 (+https://github.com/ali-ali18/Atlas)`. Alertas na mesma URL compartilham uma busca (cache de 60 s, sem dado de usuário).
- **Worker** (`processors/routine.ts`, `rule-alert.ts`): antes de resolver o modelo, lê, avalia e reaproveita `planAlertRun` e `settleAlertRun`. Não cria AgentRun: a execução da rotina fecha direto (`settleRoutineRunDirect`, escopado pelo dono). O aviso entra na conversa do bot e vira push. Fonte fora do ar vira "não consegui verificar", uma vez só. Quando nada muda, o intervalo se alarga sozinho (e o cron também se espaça), nunca abaixo do piso da fonte. Log por conferência: rotina, host, resultado e ms, sem URL.
- **Bot** (`propose_routine`, `alert.rule`): a regra é lida uma vez na criação; se não ler, a tool falha com o motivo e uma dica e nada é criado. O resultado traz a leitura de agora para o bot contar ("hoje está R$ 449,90"). O grupo de rotinas segue carregado só por intenção.
- **Limite:** 30 alertas ativos por pessoa (rotina ligada com alerta), no db (`AlertLimitError`), na API (409) e na tool; os de outro usuário não contam.
- **UI:** o cartão da rotina mostra "Alerta · tênis < R$ 400,00 · hoje R$ 449,90 · a cada 2 h", no idioma e formato da tela (pt-BR, en-US, es-ES).

## Riscos
- **Deploy com versões mistas:** não há migration (`alertJson` é JSON). Um worker antigo ignora `rule` e confere pelo modelo, como hoje. Um api/worker antigo que reescreve o `alertJson` (editar a condição, gravar o estado) **perde `rule` e `ruleState`** e o alerta volta a ser conferido pelo modelo. Por isso a ordem é **api + worker antes do web**, e a criação de alerta com regra só existe no agent-runtime novo, que vai junto do worker. Esta entrega sai como um deploy só; não há janela com versões misturadas a cobrir além disso.
- **Site muda o layout:** valor vazio/ilegível não avisa; o salto brusco só vale confirmado. O conserto automático da regra é a etapa 5.
- **Site bloqueia acesso automático:** piso de frequência, User-Agent honesto, erro claro na criação. Páginas que exigem login ou JavaScript continuam no jeito antigo (modelo).
- **SSRF e DNS rebinding:** guard em cada salto e na conexão; testes cobrem IP privado, localhost, metadados, DNS apontando para dentro e redirect para dentro.
- **Regex perigosa:** checagem estática (sem retrovisor, lookaround, repetição aninhada, no máximo 3 repetições ilimitadas) e, principalmente, execução numa `worker_thread` com orçamento de 100 ms (estourou = leitura sem veredito com motivo honesto; na criação o padrão é recusado) sobre no máximo 64 KB de texto (página inteira só se couber; senão o texto visível).
- **Texto de site na conversa:** o que vem de página ou feed (`{value}` de texto, título de item) é saneado (sem controle, marcação ou quebra de linha, 80 caracteres), entra entre aspas e o aviso é gravado com origem `routine` (no histórico do modelo vira "[Automated run - not a user request]"). Número é sempre o valor formatado pelo servidor.
- **Duas execuções ao mesmo tempo (agendada + manual):** compare-and-set por `checkedAt` ao gravar o estado; só quem grava avisa.
- **Limite de 30 sob concorrência:** a contagem e a gravação do alerta ativo rodam na mesma transação sob `pg_advisory_xact_lock` por usuário.
- **Sem leitura não é falha:** a execução fecha como concluída com o "não consegui verificar" no resumo (falha entraria na lista de falhas do diagnóstico a cada ciclo).
- **Aviso falso ou repetido:** 2 leituras, aviso único com folga, dado suspeito confirmado.
- **Dado de outro dono:** toda leitura e gravação do alerta e da execução filtra pelo dono (testes de acesso cruzado no db e na API).
- **Alertas que já existem:** não mudam. O bot oferecer converter vem na etapa 6.

## Custo
Valor e item novo: zero de IA por conferência; só uma requisição HTTP, compartilhada entre alertas da mesma URL. Alerta com regra não usa AgentRun (sem tokens, sem fila de agente).

## Como testar
- `pnpm --filter @workspace/shared test` (formato, avaliação, frases), `pnpm --filter @workspace/search test` (SSRF, limites, leitura), db e worker (`tsx --test`), `pnpm --filter @workspace/agent-runtime test` (tool, replay "me avisa se o tênis X baixar de R$ 400"), web (frase do cartão nos 3 idiomas).
- Prévias: `apps/web/e2e/alert-rule-previews.spec.ts` (`ALERT_RULE_PREVIEW_DIR`), desktop 1440 e celular 390, tema escuro.
