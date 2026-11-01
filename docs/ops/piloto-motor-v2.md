# Piloto do motor novo no "Radar de Mercado"

Guia para o dono acompanhar o motor novo (v2) no bot Radar de Mercado, testar três combinações de modelo, ver se compensa e voltar ao motor anterior na hora se não compensar. **Desde 01/11 o motor novo é o padrão de todo bot que não escolheu o motor**: não é preciso ligar nada para ele valer. As seções "Como ligar" valem para quem escolheu o motor anterior e quer voltar ao novo. Nada aqui exige SQL.

## O que é o motor novo, em uma frase
O motor anterior para no meio de uma pesquisa e pergunta demais. O motor novo trabalha até o fim, decidindo quando já pesquisou o bastante pelo progresso da tarefa e pelo tempo (não pelo preço, que varia muito entre modelos), e entrega um resumo, as fontes e uma lista do que não deu para confirmar. Relatório grande vira documento (PDF, Word ou texto).

Por padrão ele vale para **todas as origens** de um bot sem escolha: conversa direta, rotinas, alertas, e-mails, grupos, conversa entre bots, proativo e webhook (o subagente herda o motor do pai). Um bot que escolheu "Novo" (engrenagem ou chat) também vale em tudo, a menos que a opção "rotinas e grupos" seja desligada; um bot que escolheu "Anterior" não muda. Vale a partir da **próxima mensagem**; uma tarefa que já está rodando termina no motor em que começou.

## Como ligar

### Pela engrenagem (recomendado)
1. Abra o Radar de Mercado, clique na engrenagem (Configurações do bot).
2. Na linha **Motor**, escolha **Novo (padrão)** (o bot sem escolha já aparece assim). Aparece um texto curto explicando o que muda.
3. Em **Limites da tarefa longa** há dois campos. **Gasto máximo por tarefa longa** (US$): **vazio por padrão = sem limite de gasto**; se você preencher (de US$ 0,05 a US$ 20) vira um teto duro e o bot ainda reserva o fim para escrever. **Tempo em minutos**: de 1 a 180, padrão **60**. No piloto deixe o gasto **vazio** (o limite do bot é o progresso e o tempo) e acompanhe o custo pelas consultas abaixo; não existe teto em dinheiro de fábrica: só vale o "Custo máximo por execução" da conta se você escolher um valor (aí vale em tudo, trabalho longo incluso), o gasto máximo do bot e, no servidor, `ATLAS_MAX_RUN_COST_USD` (teto do operador, opcional). Chat que passa de 8 min com trabalho em andamento é promovido a trabalho longo no mesmo run (grava `promotedFrom: "chat"` no `budgetJson`; para auditar: `select id, "budgetJson" from agent_runs where "budgetJson"->>'promotedFrom' = 'chat'`).
4. Em **Modelo dos ajudantes**, escolha o modelo que os ajudantes usam (veja as combinações abaixo). Vazio = o mesmo modelo do bot.

Os campos salvam ao sair do campo (ou com Enter). Texto inválido volta ao valor salvo; o campo de gasto vazio remove o limite.

### Pelo chat
Escreva para o bot, por exemplo:
- "liga o motor novo nesse bot"
- "liga o motor novo, no máximo 90 minutos por tarefa" (e, se quiser um teto de gasto, "gasto máximo de 3 dólares por tarefa"; "sem limite de gasto" remove)
- "volta pro motor anterior"

O bot mostra um cartão "Motor do bot atualizado" com o resumo ("Motor novo · gasto máximo de US$ 1,00 e até 30 min por tarefa longa"; bot sem escolha mostra "Motor novo (padrão)"). Se você pedir um valor fora da faixa, ele diz o que é aceito e não muda nada.

## Rotinas e grupos, e a chave de emergência do deploy
Bot sem escolha já roda rotinas, grupos e o resto no motor novo. O que segue vale para limitar ou desfazer.

1. **Por bot:** engrenagem, com Motor em Novo, a opção **Usar também em rotinas e grupos** vem ligada para bot sem escolha; desligue para deixar o bot só na conversa direta (isso grava o motor novo de forma explícita só no chat). Pelo chat: "usa o motor novo só no chat" ou "também nas rotinas e grupos". Vale a partir da próxima execução. Entram rotinas, conversa em grupo, conversa entre bots, alertas, "só importante", brief "Seu dia", e-mail, webhook e modo proativo.
2. **Chave de emergência para todos os bots que não escolheram o motor** (ação do operador, variável do worker `ATLAS_ENGINE_V2_DEFAULT`): sem a variável (ou vazia, ou com valor desconhecido) vale `all`. `off` **desliga o motor novo para todos os bots**, inclusive os que escolheram Novo (todo run novo vai ao motor anterior; o que já está rodando termina no motor em que começou); `chat` deixa o motor novo só no chat dos bots sem escolha. Reinicie o worker. Bot que escolheu **Anterior** (grava `engine: "v1"`) nunca é afetado pela variável. A engrenagem e o bot **não conhecem a variável**: com `off` no deploy eles continuam mostrando "Novo (padrão)" e o bot, se perguntado, diz isso. Por isso `off` é para emergência e deve ser temporário.
   - **Bot antigo:** bot que voltou para o motor anterior **antes da 0.3.5** não tem a escolha gravada e agora roda no motor novo. Abra a engrenagem desses bots e escolha "Anterior" de novo (fica gravado).
3. **O que muda em rotina no motor novo:** a rotina nunca pergunta (entrega o que conseguiu e diz o que faltou), não gerencia outras rotinas, não pesquisa na web nem escreve memória (igual ao motor atual), e relatório pode gerar documento. Custo: rotina de relatório pode gastar até o orçamento por tarefa longa.
4. **Para desligar em emergência (todos os bots):** ponha `ATLAS_ENGINE_V2_DEFAULT=off` no `.env` do worker e reinicie o worker (para voltar, remova a linha ou ponha `all`). **Para um bot só:** engrenagem em **Anterior** (ou "volta pro motor anterior" no chat). Vale no próximo run; o que já está rodando termina no motor em que começou.
5. **Medir:** as consultas 6 a 11 de `docs/ops/por-que-runs-terminam.sql` separam por motor; filtre por `origin = 'routine'` para ver só rotinas.

## Como desligar na hora
- Um bot: engrenagem, Motor → **Anterior**; ou no chat, "volta pro motor anterior".
- Todos os bots, de uma vez (operador): `ATLAS_ENGINE_V2_DEFAULT=off` no worker e reinicie. A engrenagem não mostra essa chave.

Vale na próxima mensagem. As tarefas já feitas e as conversas ficam como estão; o bot não perde nada.

## As três combinações para medir
Use o mesmo tipo de pedido em cada uma (por exemplo, "pesquisa de mercado com 5 fornecedores de ervas") e troque só o que está na tabela. Deixe cada combinação rodar por alguns dias antes de trocar.

| | Modelo do bot (linha **Modelo**) | Modelo dos ajudantes | Outros ajustes |
|---|---|---|---|
| **A. Haiku sozinho** | Haiku | vazio (igual ao bot) | nenhum |
| **B. Sonnet coordena + Haiku nos ajudantes** | Sonnet | Haiku | nenhum |
| **C. Sonnet raciocinando pouco** | Sonnet | vazio (igual ao bot) | nível de raciocínio **Baixo** (ver nota) |

Nota sobre C: o controle de raciocínio está em outro trabalho (branch `feat/nivel-de-raciocinio`) e ainda não está nesta versão. Enquanto ele não chega, **a combinação C não pode ser medida**; quando chegar, aparece como "nível de raciocínio" na engrenagem e na doc do motor, e o resto do roteiro vale igual.

Para o modelo dos ajudantes valer, a tarefa precisa ser longa o bastante para o bot chamar ajudantes (pesquisa com vários fornecedores, por exemplo). Em conversa curta nada muda.

## O que observar
Compare o motor Atual (antes do piloto) com o Novo (durante o piloto) nas mesmas perguntas:

| Pergunta | Bom sinal |
|---|---|
| A tarefa foi entregue inteira? | O bot lista todos os fornecedores/itens pedidos, ou diz claramente o que não deu para confirmar. |
| Perguntou demais? | Menos perguntas no meio ("quer que eu continue?"), sem chutar o que é importante. |
| O relatório grande virou documento? | Pedidos de relatório completo geram um arquivo, com fontes. |
| Quanto custou? | Custo médio por tarefa (sem teto em US$ por padrão); poucas tarefas batendo no tempo máximo. |
| Demorou? | A tarefa longa termina dentro dos minutos definidos. |
| A conversa curta piorou? | "Bom dia" e perguntas simples custam igual ou menos que antes. |

Sinais de alerta: muitas tarefas paradas no tempo máximo ou no teto de gasto que você pôs (aumente o limite ou use modelo mais barato nos ajudantes), tarefas encerradas por estagnação logo no começo, muitos itens "não deu para confirmar" em coisas simples (fonte bloqueada ou modelo fraco), ou resposta perguntando no fim mesmo no motor novo.

## Como rodar a consulta (depois de alguns dias)
O arquivo `docs/ops/por-que-runs-terminam.sql` tem, no fim, as consultas 6 a 11 do piloto. Elas só leem; não alteram nada. Rode contra o banco de produção (de preferência uma réplica):

1. Abra o arquivo e troque `<BOT>` por `Radar de Mercado` e, se quiser, `interval '7 days'` pelo período.
2. Rode cada consulta no seu cliente SQL (ou `psql "$DATABASE_URL" -f arquivo.sql`).

| Consulta | Responde |
|---|---|
| 6 | Quantas tarefas terminaram bem (`answered`) contra as que pararam em travas, por motor. |
| 7 | Custo médio, mediana e p90 (US$) e duração por motor. |
| 8 | Quanto os ajudantes gastaram dentro das tarefas do motor novo. |
| 9 | Quantas tarefas tiveram questionário e quantas terminaram perguntando. |
| 10 | Quantas tarefas longas geraram documento. |
| 11 | Como as tarefas do motor novo terminam (resposta, tempo, passos, gasto máximo, itens descartados...). |

O motor de cada tarefa fica gravado na própria tarefa: motor novo aparece como `v2`; o atual não grava nada (por isso as consultas tratam "sem motor" como `v1`). Compare só tarefas parecidas: separe pedidos de pesquisa longa de conversa curta (a consulta já separa pelo perfil `long_work` e `chat` no motor novo).

## O que já foi medido sem gastar nada
`docs/ops/motor-v1-vs-v2.md` tem o comparativo com modelo roteirizado (sem internet, mesmo resultado sempre). Ele mostra o que **o motor** faz: o motor novo gera documento no relatório longo, lista o que não confirmou e é mais barato em conversa curta; em pesquisa muito longa ele gasta mais (o histórico cresce) e pode bater no orçamento. Ele **não** compara a qualidade de Haiku e Sonnet: isso só o piloto mostra. Para medir com modelo de verdade antes do piloto (gasta dinheiro, só com a sua decisão), há o modo `--live` descrito em `packages/evals/README.md`.

## Limites do piloto (honestidade)
- Por padrão o bot sem escolha usa o motor novo em todas as origens (incluindo rotinas e alertas do Radar). Para deixar o Radar só no chat, ou no motor anterior, use a engrenagem como acima.
- O motor novo ainda não faz: planejar com aprovação e sessão de código (ver `docs/features/motor-v2.md`). Se o Radar precisar disso, o bot segue no atual para aquele pedido.
- Custo é estimado quando o provedor não informa; modelos baratos podem parecer mais caros do que são.
- Não há ainda um painel de custo por motor; use as consultas acima.
