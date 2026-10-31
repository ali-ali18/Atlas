# Alertas inteligentes (regra conferida pelo servidor)

- **Status:** em andamento (etapas 1 e 2 de 6: base da regra, página pública e feed; fontes prontas de cotação, câmbio, cripto e clima; mais o modo guiado e o "brapi primeiro" da versão 0.3.3, descritos no fim)
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
- **Leitor** (`packages/search/src/alert-source.ts`): GET anônimo, só http(s), bloqueia loopback, rede privada, link-local e metadados de nuvem antes e depois do DNS, em cada redirect (máximo 3) e na conexão real; o endereço IPv6 é normalizado em bytes, então IPv4 embutido (`::ffff:7f00:1`, `::127.0.0.1`, NAT64, 6to4) vale como o IPv4 de dentro; 10 s e 5 MB (páginas de fundos e cotações passam de 2 MB; a regex segue limitada à janela de 64 KB); respeita o `robots.txt` do site (cache de 1 h por origem; falha ao ler o robots não bloqueia); User-Agent `atlas-agent/0.1 (+https://github.com/ali-ali18/Atlas)`. Alertas na mesma URL compartilham uma busca (cache de 60 s, sem dado de usuário).
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

---

# Etapa 2: fontes prontas (cotação, câmbio, cripto e clima)

## O que é
"Me avisa quando BBAS3 cair abaixo de R$ 15", "dólar acima de 6", "bitcoin abaixo de 300 mil" e "vai chover amanhã em Curitiba?" funcionam **sem link** e **sem modelo a cada conferência**. A regra ganha quatro fontes novas no mesmo formato fechado (campo desconhecido continua recusado, listando o aceito): `quote` (`symbol`, ticker da B3), `fx` (`pair`, ex.: `USD-BRL`), `crypto` (`symbol` + `quote` BRL ou USD) e `weather` (`place` ou `lat`/`lon`, `metric`: `rain_probability`, `rain_mm`, `temp_max`, `temp_min`, `wind_max`, e `day`: `today` ou `tomorrow`, relativo a cada conferência). As verificações reaproveitam `value` (`money` ou `number`, com `lt … changed_pct`); `new_item` e `text` não existem nessas fontes. Nenhuma fonte de mercado tem URL: o servidor monta a chamada, nunca o modelo.

## Provedores (pesquisa de 30/10/2026)
| Fonte | Provedor | Chave | Limites e atraso | Termos |
|---|---|---|---|---|
| Cotação B3 (ações, FIIs, ETFs, BDRs) | **brapi.dev** `/api/quote/{ticker}`, `Authorization: Bearer` | **Sim, a do próprio usuário** (grátis) | Plano grátis: 15 mil requisições/mês, 1 ticker por chamada, atraso de cerca de 30 min (Startup ~15, Pro ~5). 401 = chave inválida, 429 = limite (cabeçalho `Retry-After`) | API pública feita para uso programático; cada chamada conta como uma requisição |
| Câmbio | **AwesomeAPI** `economia.awesomeapi.com.br/json/last/USD-BRL` (`bid`) | Não | Documentação oficial cita 100 mil requisições/mês no plano grátis (com chave opcional); sem chave o limite exato não é explícito | API pública com uso por programas previsto |
| Cripto (BRL) | **Mercado Bitcoin** v4 `api.mercadobitcoin.net/api/v4/tickers?symbols=BTC-BRL` | Não | Endpoint público de mercado | Dados públicos de mercado |
| Cripto (BRL e USD) | **Binance market data** `data-api.binance.vision/api/v3/ticker/price` (reserva do Mercado Bitcoin; USD = par USDT) | Não | Host de dados públicos de mercado, sem geobloqueio de conta | Dados públicos de mercado |
| Clima | **Open-Meteo** `api.open-meteo.com/v1/forecast` + `geocoding-api.open-meteo.com/v1/search` | Não | Grátis só para uso **não comercial**, menos de 10 mil chamadas/dia, 5 mil/h, 600/min; licença CC-BY 4.0 | Ver nota abaixo |

**Fora:** Yahoo Finance (o `robots.txt` proíbe leitura automática e o bot já foi bloqueado). **Bolsai** (`usebolsai.com`): é uma API brasileira de dados da B3/CVM/BCB (350+ ações, 400+ FIIs, fundamentos, dividendos, séries desde 1986) **com chave de API** (há gestão de chaves, planos pagos a partir de US$ 10 e um servidor MCP com OAuth). Não achamos documentação pública de endpoints, limites nem atraso (só perfis de terceiros e o fabricante) e o domínio não abre neste ambiente, então **não foi implementada**: a vaga de segundo provedor de cotação está reservada em `packages/search/src/market-data.ts` (`providersFor`), no mesmo molde da brapi (host fixo, chave do dono no Marketplace, backoff por chave). Para ligar: confirmar base URL, cabeçalho de chave, caminho e formato da resposta com a documentação oficial e a conta do dono. O fluxo n8n do dono (brapi ↔ bolsai) não foi inspecionado.

**Nota Open-Meteo:** o plano grátis é para uso não comercial. O Atlas, enquanto beta e sem cobrança, cabe; se o produto passar a ser cobrado, é preciso migrar para o plano pago da Open-Meteo ou trocar de provedor de clima. Registrado como risco.

**Verificação ao vivo:** os hosts acima não abriam a partir do ambiente de desenvolvimento (rede restrita), então os formatos de resposta vêm da documentação e de fontes públicas, e os testes usam respostas simuladas. A brapi é tolerante a duas formas de resposta (campos na raiz do item ou em `data`). Na primeira conexão real o teste da chave (uma cotação de PETR4) acusa qualquer diferença.

## A chave da brapi (Marketplace, nunca `.env`)
- A brapi é uma entrada do **Marketplace** (`id: brapi`, categoria "Fontes de dados", `kind: "data_source"` em `packages/shared/src/mcp-catalog.ts`): não é servidor MCP, não tem tools. É o mesmo cartão de "conectar com chave" dos outros conectores (ícone, descrição, link para criar a chave grátis).
- Ao colar a chave, a API (`POST /v1/mcp/connections`) **testa a chave com uma cotação de verdade**, e só então guarda: selada em `secretsEnc` (AES-256-GCM, `CONNECTOR_ENCRYPTION_KEY`), na linha do dono. A resposta e o erro nunca trazem a chave. "Atualizar" a conexão repete o teste e marca erro se a chave deixou de valer.
- Quem usa a chave é o **servidor**: o worker (e o teste da criação, no agent-runtime) chama `resolveMarketKeys(userId)`, que lê só a conexão **ativa do dono do alerta** (`getMcpConnectionByCatalogId` filtra por `ownerIds`; `default` e usuário vazio não recebem nada), abre o cofre em memória e entrega a chave só para aquela chamada. Alerta do usuário B nunca usa a chave do A (teste: `apps/api/src/routes/mcp-data-source.test.ts`).
- Nada de variável de ambiente do operador para chave de provedor.
- **Sem chave** (ou recusada): a criação falha com motivo e dica, e o bot chama `propose_connector` com `app: "brapi"` para abrir o cartão de conexão, sem pedir a chave no chat. No dia a dia, alerta de cotação que perdeu a chave vira um único "não consegui verificar … conecte a brapi no Marketplace". Câmbio, cripto e clima seguem sem chave.
- **Chave revogada ou recusada (401/403):** o worker e o teste da criação marcam a conexão **do dono** como erro (só se a chave guardada ainda é a recusada). O Marketplace passa a mostrar a conexão com erro, `resolveMarketKeys` devolve sem chave e `propose_connector` oferece o cartão de **reconexão**; o outro usuário não é afetado.
- A cota da brapi é **por chave**: o backoff de falha (401, 429 com `Retry-After`, 5xx) é registrado por provedor + impressão digital curta da chave (hash de 8 caracteres, nunca a chave); a chave ruim de um dono não bloqueia o outro.

## Custo, cache e saúde dos provedores
- Cache de 60 s por símbolo, **compartilhado** entre alertas e donos (a falha de chave do dono que iniciou a busca não é entregue a outro dono: ele refaz com a própria chave; 4xx de um símbolo, como 400/402/422, não põe a chave inteira em backoff; durante o backoff o último erro de verdade é relançado) (valor de mercado não é segredo) e leituras iguais em andamento reaproveitam a mesma chamada: 50 alertas em BBAS3 custam uma requisição por minuto. A elegibilidade (ter chave) é conferida **antes** do cache: quem não tem chave não "pega carona" no valor de outro.
- Provedores com reserva (cripto BRL: Mercado Bitcoin → Binance) trocam sozinhos; falha de um provedor entra em backoff exponencial (30 s a 10 min) para não martelar um serviço fora do ar.
- Orçamento da brapi grátis (15 mil/mês, ~500/dia): uma ação conferida a cada 15 min no pregão (10h–17h55, ~32 leituras/dia, mas o cache junta alertas do mesmo ticker) cabe com folga em cerca de 15 ações diferentes por chave.

## Segurança (regra 40)
- O cache de páginas dos alertas (etapa 1) agora tem teto de 100 MB de memória além das 200 entradas (páginas de até 5 MB).
- **SSRF:** nenhuma URL vem do modelo. Cada provedor tem host fixo no código (lista fechada), só `https`, sem seguir redirect (3xx vira erro), 8 s de timeout e 256 KB de resposta; ticker, par, símbolo e cidade são validados (`^[A-Z]{4}\d{1,2}$`, moedas de uma lista) e escapados na URL (`URL`/`searchParams`). Campo `url` numa fonte de mercado é "campo desconhecido".
- Resposta de provedor validada à mão (números finitos, símbolo devolvido igual ao pedido, estrutura esperada); lixo vira "a fonte não devolveu dados no formato esperado", nunca valor.
- A chave só vai no cabeçalho `Authorization`, nunca em URL, log (o log traz rotina, host, resultado e ms), resultado de tool, evento SSE ou mensagem de erro; o erro 401 vira "a brapi recusou a chave: reconecte a brapi no Marketplace".

## Pregão da B3 (config pura em `packages/shared/src/market-hours.ts`)
- Cotação só é conferida **durante o pregão e uma vez depois do fechamento** (a que pega o preço de fechamento); noite, fim de semana e feriado descartam o disparo sem chamar o provedor e **sem criar linha de execução** (seriam ~96 por dia por alerta). Câmbio e cripto (24 h) e clima não dependem do pregão.
- Grade (conferida em 30/10/2026 em notícias do mercado que citam o comunicado da B3; o Ofício Circular 050/2026-VNC, de 13/10, é a fonte primária e não abriu neste ambiente):
  - no horário de verão dos EUA (da segunda depois do 2º domingo de março ao 1º domingo de novembro): regular 10h–16h55, leilão de fechamento até 17h, after-market de ações 17h30–18h;
  - **a partir de 03/11/2026** (primeiro dia útil depois do fim do horário de verão americano, 01/11; 02/11 é Finados): regular **10h–17h55**, leilão até 18h e **sem after-market de ações** (exceto dias de vencimento de opções).
- Feriados de 2026 (lista oficial; Ofício Circular 054/2025-VNC e errata 041/2026-VNC): 01/01, 16/02, 17/02, 03/04, 21/04, 01/05, 04/06, 07/09, 12/10, 02/11, 20/11, 24/12, 25/12 e 31/12. O feriado só de São Paulo (09/07) não fecha a B3. **2027 em diante é calculado** (a B3 ainda não publicou o ofício; não achei fonte oficial): feriados nacionais fixos, 24/12 e 31/12, e Carnaval, Sexta-feira Santa e Corpus Christi pela Páscoa; a regra reproduz a lista oficial de 2026 em teste. Conferir quando a B3 publicar o ofício do ano. Rede de segurança: durante o pregão (depois da 1ª hora) e na conferência de depois do fechamento a cotação precisa ser de hoje; se o provedor mostrar outro dia, o mercado é tratado como fechado e a conferência fica em silêncio.
- **Atraso da cotação:** é medido (agora − horário da cotação), não suposto pelo plano. Entre 10 e 45 min aparece como atraso; acima de 45 min (ativo pouco negociado, ex.: FII) o aviso e o cartão dizem "último negócio às HH:MM" (Brasília) em vez de afirmar um atraso que não é do provedor. Aparece no aviso ("BBAS3 está em R$ 14,90 (cotação com atraso de ~30 min)"), no estado do alerta e no cartão ("hoje R$ 21,34 (atraso ~30 min)").

## Frequência e proteções
- Quem escolhe é o bot; o servidor só impõe o piso técnico: cotação 15 min (dentro do pregão), câmbio 15 min, cripto 5 min, clima 3 h. Padrões: 30 min, 30 min, 15 min, 6 h.
- Valem todas as proteções da etapa 1: limite de 30 alertas ativos, 2 leituras seguidas, avisa uma vez e rearma com folga de 0,5%, salto brusco só confirmado (**exceto clima**, que muda de um dia para o outro por natureza), compare-and-set do estado e texto externo citado. Leitura de mercado é número vindo de provedor validado; não há texto de terceiros nesses avisos.

## UI
`Alerta · BBAS3 < R$ 15,00 · hoje R$ 21,34 · a cada 15 min no pregão` (pt-BR; en-US `… every 15 min during market hours`; es-ES `… cada 15 min en horario de bolsa`). Clima leva a unidade (`chuva em Curitiba ≥ 60% · hoje 75%`). A brapi aparece no Marketplace em "Fontes de dados".

## Alternativas descartadas
- Chave no `.env` do operador (`ATLAS_BRAPI_TOKEN`): decisão do dono, a chave é de cada usuário e mora no cofre.
- Yahoo Finance: `robots.txt` proíbe.
- Cotação sem chave por raspagem de sites: frágil e contra os termos; sem chave a criação falha com orientação.
- Um provedor de câmbio/cripto pago: desnecessário no volume atual; AwesomeAPI, Mercado Bitcoin e Binance cobrem sem chave.

## Riscos desta etapa
- **Cota da brapi esgotada** (15 mil/mês por chave): 429 entra em backoff com `Retry-After`; o usuário recebe um "não consegui verificar" único. Mitigação: cache por símbolo, piso de 15 min, só no pregão.
- **Formato da brapi mudou** (a documentação mostra rotas v1 e v2 em lugares diferentes): o parser aceita campos na raiz ou em `data` e exige o símbolo igual; mudança maior falha honesta no teste da chave.
- **Open-Meteo não comercial:** ver nota acima.
- **Feriado fora da lista:** coberto pela checagem do dia da cotação.
- **Deploy com versões mistas:** `alertJson.ruleState.delayMinutes` e as novas fontes são opcionais/aditivos; um worker antigo que lê uma regra `quote`/`fx`/`crypto`/`weather` não a entende e cai no jeito com modelo (`parseRoutineAlert` tolera). Ordem de deploy continua api + worker antes do web.
- **Rotina por cron com cotação:** disparos fora do pregão são descartados sem linha de execução.

## Como testar
- `pnpm --filter @workspace/shared test` (fontes, pregão com `now` injetado, avaliação), `pnpm --filter @workspace/search test` (provedores com `fetch` simulado: ok, 401, 429, malformado, timeout, redirect, rotação, cache), `pnpm --filter @workspace/agent-runtime test` (replays dos quatro pedidos e economia), worker e api (`tsx --test`: `rule-alert.test.ts`, `routine.rule-alert.test.ts`, `mcp-data-source.test.ts` com acesso de outro usuário), web (cartão nos três idiomas).

---

# Modo guiado e "brapi primeiro" (0.3.3-beta)

## O que é
Duas melhorias aprovadas pelo dono depois do caso real do BBAS3: o bot chutou uma regex "Cotação R$" para a página do Investidor10 (2,2 MB, ~50 KB de texto visível) e ela pegaria o **ouro**, porque a faixa de commodities no topo tem dezenas de "Cotação: R$ ..." antes do preço da ação.
1. **Modo guiado:** a IA guia a criação (acha o valor, escolhe a ocorrência certa pelo contexto) e o servidor passa a conferir sem IA, com um seletor CSS estável que ele mesmo validou.
2. **Brapi primeiro:** preço de ação, FII, ETF ou BDR da B3 é sempre a fonte `quote`, nunca a página de um site de cotação.

## Problema
- Regex e seletor chutados leem o número errado, e o teste da criação só dizia "leu um número", não "leu o número certo".
- Em loja com várias variantes (128 GB, 256 GB) o seletor da primeira ocorrência lê o preço do modelo errado.
- Páginas de cotação são frágeis (layout, JavaScript, bloqueio) e a brapi já resolve o caso com dado limpo.

## Como funciona
- **`find_page_value`** (`packages/agent-runtime/src/tools/find-page-value.ts`, grupo lazy das rotinas; não entra no "Bom dia"). Args: `url`, `value` (como a IA viu: "16,47", "R$ 3.299"), `near` opcional (texto que identifica o item: "256 GB"). O servidor busca a página com o **mesmo leitor seguro dos alertas** (`fetchAlertPage`: SSRF em cada salto, 5 MB, 10 s, robots.txt) e devolve até 10 ocorrências: dados estruturados primeiro (`meta[itemprop=price]`, `meta[property=product:price:amount]`, `[itemprop=price]`, JSON-LD), depois as que têm `near` no elemento ou num ancestral próximo, depois o resto. Cada uma traz o `extract` pronto para a regra, o tipo (`structured`/`css`), a leitura e ~120 caracteres de contexto. O resultado vai ao modelo como **dado não confiável** (marcado, saneado, sem HTML cru) e a tool falha (`ok:false`) com dica quando não acha.
- **Localizador** (`packages/search/src/page-value.ts`; comparação e heurísticas puras em `packages/shared/src/page-value.ts`). Acha o menor elemento visível que contém o número (token a token: "16,47" não casa "116,47"; "16,47" = "R$ 16,47" = 16.47) e só aceita a ocorrência se a regra **leria o mesmo valor** (a regra lê o primeiro número do elemento: o "3" de "BBAS3 cotação R$ 16,47" descarta a ocorrência). Seletor: prefere `id`, `itemprop`/`data-*` e classes com significado, ancora em ancestrais quando preciso, recusa classe gerada (CSS-in-JS, CSS modules), utilitária e de estado, nunca usa `nth-child`, e só vale se casar **exatamente 1 elemento** no documento. Sem jeito estável, a ocorrência vem com `extract: null` e nota. JSON-LD é evidência (`extract: null`): a regra ainda não lê JSON-LD.
- **`expect`** em `alert.rule`: o valor que a IA viu. O teste ao vivo da criação exige que a leitura bata (mesma normalização, tolerância zero); senão falha com `the rule read "X" but you expected "Y"; use find_page_value to get the right selector` e nada é criado. `expect` nunca é gravado na regra. **`expect` é obrigatório** para regra de valor em página criada pela tool (css, jsonpath e regex); sem ele a criação falha mandando usar o `find_page_value` (feed e item novo não pedem). Campo desconhecido continua falhando com a lista do aceito.
- **Âncora contra deriva:** o salto brusco só segura uma leitura até a seguinte confirmar, então um seletor que passa a casar outro card (outro número) seria aceito na 2ª leitura. Por isso a criação guarda na regra o `anchor`, o rótulo que estava junto do valor ("cotacao", derivado pelo servidor do contexto lido, nunca do modelo), o leitor devolve o contexto do elemento e a avaliação descarta a leitura quando o rótulo sumiu ("não consegui verificar" uma vez, sem aviso de valor, sem sobrescrever o último valor bom). Regra sem âncora (contexto só com números) segue só com o filtro de salto.
- **Ranking e custo do localizador:** estruturado primeiro; prosa (valor dentro de `<p>` ou de bloco com mais de ~60 caracteres) depois do elemento que mostra só o valor; então `near`; então ancestral com nome de preço/cotação. Orçamento de 800 ms depois do parse (estourou: devolve o que tem, sem montar seletor), cache de 60 s por URL e no máximo 3 buscas por run (a 4ª falha com a saída). Valor de atributo no seletor só com `[\w-]`.
- **Salto brusco e seletor que some:** já existiam e foram conferidos. Seletor que deixa de casar lê `null`, vira "não consegui verificar" uma vez, sem anunciar valor e sem mexer no último valor lido; o salto >60% só vale confirmado (teste novo em `apps/worker/src/rule-alert.test.ts`).
- **Brapi primeiro:** prompt e descrição do esquema mandam usar `quote` para ticker da B3 (ou nome de empresa listada); sem a chave (ou recusada) o bot chama `propose_connector` com app `brapi` (aparece o cartão), não insiste em páginas e oferece o alerta simples conferido pelo modelo. **Guarda no executor** (`b3QuotePageReason`, `packages/shared`): regra de página de investidor10, statusinvest, fundamentus, tradingview, investing.com (qualquer subdomínio), advfn, maisretorno, finance.yahoo.com, google.*/finance (qualquer domínio) ou infomoney.com.br/cotacoes cuja URL, título, detalhe, condição, rótulo ou a última fala do usuário citam ticker da B3 (4 caracteres com 3 letras no mínimo + sufixo 3-6, 11-13 ou 31-39 + `F` opcional: B3SA3, BBAS3F; "Fire7" não casa) **e pedem o preço** é recusada com "Use source quote (brapi) for B3 tickers; if the key is missing call propose_connector app brapi". O `find_page_value` aplica a mesma guarda e nem busca a página.

## Alternativas descartadas
- Pedir ao modelo para "revisar" o seletor depois: custa IA e ainda erra; o servidor valida sem modelo (seletor único + `expect`).
- Aceitar `nth-child` quando não há atributo estável: funciona hoje e quebra quando a loja reordena as variantes; prefere-se dizer que não dá e cair na condição simples.
- Ler JSON-LD na regra: exigiria um novo tipo de extração (`jsonld`) em `shared`, `search`, worker e UI. Fica como sugestão; hoje JSON-LD só confirma o valor e ajuda o `near`.
- Regex gerada pelo servidor sobre o HTML: o leitor roda a regex numa janela de 64 KB de texto visível (sem script), então não alcança o JSON-LD de páginas grandes.
- Bloquear só no prompt: o modelo ignora; por isso a guarda está no executor, com teste.

## Riscos
- **Seletor com classe que parece estável mas muda** (marca nova, redesign): vira "não consegui verificar" (nunca um valor errado); o conserto automático é a etapa 5.
- **Variantes sem atributo que as distinga:** a ocorrência volta sem seletor; o bot diz que não dá para vigiar só aquele modelo com regra e oferece a condição simples.
- **Falso positivo da guarda da B3:** exige site de cotação **e** ticker no endereço ou no pedido **e** pedido de preço; DY, P/VP, dividendos e data com passam (a fonte `quote` não os cobre), assim como página de commodity no mesmo site sem ticker.
- **Texto da página no resultado da tool:** contexto saneado (sem marcação, aspas, controle), 160 caracteres, marcado como não confiável; o modelo não segue ordem encontrada nele.
- **Custo:** `find_page_value` não usa modelo (uma busca HTTP, no máximo 5 MB, ~1 s para 2 MB). O grupo das rotinas ganhou uma tool, mas só carrega por intenção; o "Bom dia" segue abaixo de 40 mil caracteres de prefixo (a dica do índice do grupo foi encurtada para compensar).
- **Deploy com versões mistas:** sem migration e sem contrato novo no banco; `expect` é só da criação. Agent-runtime novo com worker antigo funciona (a regra gravada é a mesma de antes).

## Como testar
- `pnpm --filter @workspace/shared test` (comparação de valor, classes estáveis, guarda da B3, `expect` no parse), `pnpm --filter @workspace/search test` (localizador com fixtures reduzidas do Investidor10 e de uma loja com variantes, SSRF, JSON, página grande), `pnpm --filter @workspace/agent-runtime test` (`computer-use.alert-guided.test.ts`: tool, `expect`, guarda e os replays "me avisa se a BBAS3 cair abaixo de R$ 15" e "Galaxy X de 256 GB"; `computer-use.economy-replay.test.ts`: "Bom dia" pequeno e o pedido de alerta carregando o grupo no passo 1), worker (`rule-alert.test.ts`).
