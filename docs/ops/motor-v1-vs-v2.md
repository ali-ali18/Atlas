# Motor atual (v1) × motor novo (v2): comparativo

Modo: **roteiro (sem rede, determinístico)**
Custo estimado = tokens enviados e recebidos × US$ 1/Mtok de entrada e US$ 5/Mtok de saída.

## Resumo

| Medida | Atual (v1) | Novo (v2) |
|---|---|---|
| Tarefas concluídas (resposta normal, sem trava) | 11/11 | 10/11 |
| Cobertura média do pedido (termos pedidos que aparecem na entrega) | 100% | 100% |
| Perguntas ao usuário (total) | 1 | 1 |
| Chamadas ao modelo (total) | 114 | 140 |
| Custo estimado (total) | US$ 1.1895 | US$ 1.3230 |
| Itens "não confirmados" listados | 0 | 1 |
| Tarefas que geraram documento | 0 | 1 |

## Por tarefa

Cada célula: concluiu? · motivo de término · cobertura · perguntas · chamadas ao modelo · custo · itens não confirmados (n/c) · documento.

| Tarefa | Atual (v1) | Novo (v2) |
|---|---|---|
| pesquisa-5-fornecedores-ervas | sim · answered · 100% · 0? · 11 cham. · US$ 0.1059 | sim · answered · 100% · 0? · 18 cham. · US$ 0.1622 |
| pesquisa-funda-45-passos | sim · answered · 100% · 0? · 46 cham. · US$ 0.4853 | não · budget_cost/delivered · 100% · 0? · 49 cham. · US$ 0.5228 |
| comparar-precos-3-lojas | sim · answered · 100% · 0? · 4 cham. · US$ 0.0362 | sim · answered · 100% · 0? · 4 cham. · US$ 0.0239 |
| resumo-concorrentes | sim · answered · 100% · 0? · 9 cham. · US$ 0.0850 | sim · answered · 100% · 0? · 11 cham. · US$ 0.0728 |
| cotacao-varios-sku | sim · answered · 100% · 0? · 7 cham. · US$ 0.0640 | sim · answered · 100% · 0? · 10 cham. · US$ 0.0640 · 1 n/c |
| relatorio-curto | sim · answered · 100% · 0? · 4 cham. · US$ 0.0427 | sim · answered · 100% · 0? · 6 cham. · US$ 0.0516 |
| bom-dia | sim · answered · 100% · 1? · 1 cham. · US$ 0.0083 | sim · answered · 100% · 1? · 1 cham. · US$ 0.0055 |
| pergunta-simples | sim · answered · 100% · 0? · 1 cham. · US$ 0.0083 | sim · answered · 100% · 0? · 1 cham. · US$ 0.0055 |
| ferramenta-falhando | sim · answered · 100% · 0? · 7 cham. · US$ 0.0705 | sim · answered · 100% · 0? · 7 cham. · US$ 0.0496 |
| pesquisa-sem-novidade | sim · answered · 100% · 0? · 15 cham. · US$ 0.1438 | sim · answered · 100% · 0? · 15 cham. · US$ 0.1002 |
| relatorio-longo-documento | sim · answered · 100% · 0? · 9 cham. · US$ 0.1394 | sim · answered · 100% · 0? · 18 cham. · US$ 0.2649 · doc |

## Como ler

- Os dois motores recebem o **mesmo comportamento de pesquisa** de um modelo roteirizado (as mesmas buscas e leituras); o v2 acrescenta lista de tarefas, caderno e documento, que o prompt dele pede. O comparativo mede o que cada **motor** faz com esse comportamento (travas, perguntas, entrega, custo). Ele **não** mede qualidade de modelo: para isso use `--live`.
- Sem ajudantes (`delegate` precisa do banco): o v2 aqui é o coordenador sozinho. O ganho de "Sonnet coordena + Haiku nos ajudantes" só aparece em produção.
- "Concluiu" exige término normal (`answered`) e texto na entrega. Parar por orçamento (`budget_*`) ou por repetição (`loop_repeat`) não conta, mesmo quando o v2 entrega o que tem.
- Cobertura = fração dos nomes/itens pedidos que aparecem no texto final ou no documento; é uma régua grossa, leia as entregas antes de decidir.
