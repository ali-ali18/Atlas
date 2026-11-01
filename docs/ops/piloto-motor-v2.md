# Piloto do motor novo no "Radar de Mercado"

Guia para o dono ligar o motor novo (v2) no bot Radar de Mercado, testar três combinações de modelo, ver se compensa e desligar na hora se não compensar. Nada aqui exige SQL para ligar ou desligar.

## O que é o motor novo, em uma frase
O motor atual para no meio de uma pesquisa e pergunta demais. O motor novo trabalha até o fim dentro de um orçamento (dinheiro e minutos) que você define, e entrega um resumo, as fontes e uma lista do que não deu para confirmar. Relatório grande vira documento (PDF, Word ou texto).

Por padrão ele só vale para a **conversa direta com o bot** (as rotinas, alertas, e-mails, grupos e conversa entre bots continuam no motor atual; para incluir rotinas, grupos e conversa entre bots, veja "Ampliar para rotinas e grupos" abaixo). Vale a partir da **próxima mensagem**; uma tarefa que já está rodando termina no motor em que começou.

## Como ligar

### Pela engrenagem (recomendado)
1. Abra o Radar de Mercado, clique na engrenagem (Configurações do bot).
2. Na linha **Motor**, escolha **Novo (teste)**. Aparece um texto curto explicando o que muda.
3. Em **Orçamento por tarefa longa**, ajuste os dois campos: dólares (US$) e minutos. Valores aceitos: de US$ 0,05 a US$ 20 e de 1 a 120 minutos. O padrão é **US$ 0,50 e 20 minutos**. Comece com **US$ 1,00 e 20 minutos** no piloto; com o padrão, tarefas muito longas podem parar no orçamento (o bot entrega o que já tem, mas você não terá a pesquisa completa).
4. Em **Modelo dos ajudantes**, escolha o modelo que os ajudantes usam (veja as combinações abaixo). Vazio = o mesmo modelo do bot.

Os campos de orçamento salvam ao sair do campo (ou com Enter). Texto inválido volta ao valor salvo.

### Pelo chat
Escreva para o bot, por exemplo:
- "liga o motor novo nesse bot"
- "liga o motor novo, orçamento de 1 dólar e 30 minutos por tarefa"
- "volta pro motor atual"

O bot mostra um cartão "Motor do bot atualizado" com o resumo ("Motor novo (teste) · até US$ 1,00 e 30 min por tarefa longa"). Se você pedir um valor fora da faixa, ele diz o que é aceito e não muda nada.

## Ampliar para rotinas e grupos (opcional, desligado por padrão)
Só depois de o chat estar bom no piloto.

1. **Por bot:** engrenagem, com Motor em Novo (teste), ligue **Usar também em rotinas e grupos**. Pelo chat: "liga o motor novo também nas rotinas e grupos". Vale a partir da próxima execução. Entram rotinas, conversa em grupo e conversa entre bots. Continuam no motor atual: alertas, rotinas "só importante", brief "Seu dia", e-mail, webhook, modo proativo e ajudantes.
2. **Para todos os bots que não escolheram o motor** (ação do operador, variável do worker): `ATLAS_ENGINE_V2_DEFAULT=chat` liga o motor novo no chat desses bots; `=all` também em rotinas, grupos e bot→bot. Reinicie o worker. Bot que escolheu **Atual** (grava `engine: "v1"`) nunca é afetado. Recomendado: `chat` por alguns dias, só depois `all`. A engrenagem continua mostrando "Atual" para bot sem escolha, mesmo com a variável ligada. O bot, se perguntado pelo chat, também diz "motor atual" nesse caso: a engrenagem e o bot não sabem da variável.
   - **Antes de ligar a variável:** bot que voltou para "Atual" **antes da 0.3.5** não tem a escolha gravada e vai para o motor novo com a variável ligada. Abra a engrenagem desses bots e escolha "Atual" de novo (agora fica gravado).
3. **O que muda em rotina no motor novo:** a rotina nunca pergunta (entrega o que conseguiu e diz o que faltou), não gerencia outras rotinas, não pesquisa na web nem escreve memória (igual ao motor atual), e relatório pode gerar documento. Custo: rotina de relatório pode gastar até o orçamento por tarefa longa.
4. **Para desligar:** tire a opção na engrenagem (ou "volta pro motor atual"), ponha `ATLAS_ENGINE_V2_DEFAULT=off` (ou remova) e reinicie o worker. Vale no próximo run; o que já está rodando termina no motor em que começou.
5. **Medir:** as consultas 6 a 11 de `docs/ops/por-que-runs-terminam.sql` separam por motor; filtre por `origin = 'routine'` para ver só rotinas.

## Como desligar na hora
- Engrenagem: Motor → **Atual**.
- Chat: "volta pro motor atual".

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
| Quanto custou? | Custo médio por tarefa dentro do orçamento; poucas tarefas batendo no teto. |
| Demorou? | A tarefa longa termina dentro dos minutos definidos. |
| A conversa curta piorou? | "Bom dia" e perguntas simples custam igual ou menos que antes. |

Sinais de alerta: muitas tarefas paradas no orçamento (aumente o orçamento ou use modelo mais barato nos ajudantes), muitos itens "não deu para confirmar" em coisas simples (fonte bloqueada ou modelo fraco), ou resposta perguntando no fim mesmo no motor novo.

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
| 11 | Como as tarefas do motor novo terminam (orçamento, itens descartados...). |

O motor de cada tarefa fica gravado na própria tarefa: motor novo aparece como `v2`; o atual não grava nada (por isso as consultas tratam "sem motor" como `v1`). Compare só tarefas parecidas: separe pedidos de pesquisa longa de conversa curta (a consulta já separa pelo perfil `long_work` e `chat` no motor novo).

## O que já foi medido sem gastar nada
`docs/ops/motor-v1-vs-v2.md` tem o comparativo com modelo roteirizado (sem internet, mesmo resultado sempre). Ele mostra o que **o motor** faz: o motor novo gera documento no relatório longo, lista o que não confirmou e é mais barato em conversa curta; em pesquisa muito longa ele gasta mais (o histórico cresce) e pode bater no orçamento. Ele **não** compara a qualidade de Haiku e Sonnet: isso só o piloto mostra. Para medir com modelo de verdade antes do piloto (gasta dinheiro, só com a sua decisão), há o modo `--live` descrito em `packages/evals/README.md`.

## Limites do piloto (honestidade)
- Por padrão só a conversa direta com o bot usa o motor novo. Rotinas e alertas do Radar continuam no atual, salvo se você ligar a ampliação acima (alertas e rotinas "só importante" ficam no atual de qualquer forma).
- O motor novo ainda não faz: planejar com aprovação, sessão de código e envio entre bots (ver `docs/features/motor-v2.md`). Se o Radar precisar disso, o bot segue no atual para aquele pedido.
- Custo é estimado quando o provedor não informa; modelos baratos podem parecer mais caros do que são.
- Não há ainda um painel de custo por motor; use as consultas acima.
