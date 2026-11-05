# Plano Motor v4: um agente que trabalha sozinho

> Status: **rascunho para aprovação do dono** (05/11/2026). Nenhum código foi escrito.
>
> Arquivos:
> - [`01-diagnostico.md`](01-diagnostico.md): o que v2 e v3 fazem hoje e por que não parecem melhores.
> - [`02-referencias.md`](02-referencias.md): o que copiar dos harnesses abertos.
> - [`03-arquitetura.md`](03-arquitetura.md): núcleo, capacidades, ganchos, canais, memória e agenda.
> - [`04-avaliacao.md`](04-avaliacao.md): como saber se o problema é o harness ou o modelo.
> - [`05-fases.md`](05-fases.md): fases, PRs, arquivos, testes e critério de pronto.

## Por quê
O dono não sente evolução do v2 para o v3. O diagnóstico (ver `01`) mostra o motivo.
- O v3 é um laço melhor: mais barato, cache estável, política por efeito, checkpoint por passo e sem regex no núcleo.
- Mas o comportamento que o usuário sente quase não mudou:
  - O prompt de trabalho tem 9 linhas genéricas.
  - Criar arquivo, painel e pesquisa profunda saíram do núcleo e ficaram atrás de `tool_search`/`tool_call`.
  - O caderno e os ajudantes do v2 não vieram.
  - O agente não tem agenda própria. Só tem lembrete se lembrar de achar `schedule_return`.
  - "Sistema" e "usuário" chegam no mesmo canal, só com um prefixo de texto.
  - Não existe eval com modelo real que meça pesquisa, documento ou autonomia.

O v4 **não recomeça do zero**. Ele usa o laço do v3 como núcleo e investe no que o usuário sente:
1. Capacidades completas: e-mail com conteúdo, compras, documentos, pesquisa, dia planejado, código.
2. Uma agenda própria: lembretes, vigias e intenções por evento.
3. Memória que aprende fora do caminho quente.
4. Um eval que separa harness de modelo.

## O que o dono pediu → onde está no plano
| Pedido | Onde |
|---|---|
| Autônomo, prevê o que eu não pedi (resumo de e-mail com conteúdo e ação) | Contrato de trabalho no prompt (`03` §3), capacidade E-mail (F7) |
| Busca produtos e mostra muito bem (card com foto, preço, loja) | Capacidade Compras (F6) |
| Detecta ação perigosa de forma inteligente e pede aprovação | Política por efeito + risco por argumento (`03` §4), sem regex |
| Faz compras com o cartão salvo, sempre confirmando | Compras (F6): `money` sempre pede cartão; o número do cartão nunca entra no contexto |
| Documentos, slides e tabelas incríveis (trabalho da faculdade) | Capacidade Entregáveis (F2): no núcleo, com "renderiza e confere" e ABNT |
| Usa o computador/VM muito bem | Navegador v3 (`browser-v3`) mantido, com bench real (F0/F8) |
| Gera lembrete para si mesmo; vigia algo de X em X tempo **sem criar rotina** | Agenda do agente: `remind_me` e `watch` (F4) |
| Acompanha a entrega quando ele mesmo compra, sem eu pedir | Gancho pós-tool de Compras cria um vigia (F6) |
| Distingue entrada do usuário e do sistema | Canais com envelope assinado (`03` §5) |
| Pesquisa incrível | Capacidade Pesquisa: plano, ajudantes, caderno, fontes (F3) |
| Programa bem | Perfis plan/build e edição precisa (F8) |
| Planeja meu dia e tem um caderno para anotar | Dia planejado (F4) + Caderno persistente (F5) |
| Fácil de adicionar feature, modular | Capacidade = pacote com tools, skill, ganchos e evals (`03` §2) |
| Saber se é harness ou modelo | Matriz de eval e classificação automática de falha (`04`) |
| Aprende com o tempo, guarda só o útil | Sono (consolidação), memória em camadas e skills aprendidas (F5) |
| Sem travas e sem regex; não reescreve a resposta | Princípios 1 a 3 abaixo, com teste de guarda |

## Princípios (valem para todo PR do v4)
1. **Núcleo burro, capacidades espertas.** O laço só chama o modelo, executa tools e persiste. Inteligência de domínio mora na capacidade (skill + tools + ganchos), carregada sob demanda.
2. **Zero regex sobre texto do usuário ou do modelo para decidir comportamento.** Decisão vem de sinal estrutural: efeito declarado da tool, argumentos tipados, estado do run, configuração do dono. Um teste de guarda varre `engine-v4/` e `capabilities/` (ver F1).
3. **A resposta do modelo nunca é reescrita, descartada nem trocada.** Não há revisor, rascunho revisado nem portão de entrega. Se algo faltou, o próprio modelo é que nota (via resultado de tool) e age.
4. **Liberdade com fronteira.** O modelo decide o caminho. O harness só intervém nos limites que protegem o dono (dinheiro, envio, link público, credencial, teto que o dono configurou) e no laço infinito (ADR 0003).
5. **Proatividade é trabalho agendado com contrato silencioso.** Vigia, lembrete e "planejar o dia" são jobs. Sem novidade, o resultado é `no_change` e nada é postado.
6. **Só entra no contexto o que vai ser usado.** O núcleo tem as tools que quase todo pedido usa. O resto vem por capacidade, carregada pela intenção que o próprio modelo declara (sem roteador por regex).
7. **Toda falha tem dono:** harness, modelo ou ambiente. O run guarda o suficiente para o eval classificar sozinho (`04`).
8. **Aprender fora do caminho quente.** Memória e skills se consolidam num job de "sono" depois do run, com proveniência, sem juiz LLM bloqueando a resposta.

## Decisões que preciso do dono
1. **Base:** v4 = núcleo do v3 (`origin/harness/v3`) promovido e limpo. *(Recomendado.)* A alternativa é reescrever do zero, o que joga fora checkpoint, política e catálogo que já funcionam.
2. **O que fazer com o branch `harness/v3`:** fechar o PR8d (UI dos cartões) e mergear na versão como base, sem ligar para usuários. *(Recomendado.)* A alternativa é abandonar e copiar arquivos.
3. **Compras:** checkout pelo navegador da VM com o cartão no cofre, sempre com cartão de confirmação mostrando item, loja, total e frete. *(Recomendado.)* As alternativas são uma API de pagamento (Stripe, Mercado Pago) ou só busca, sem comprar.
4. **Modelos do bench:** quais 3 modelos baratos e 1 forte entram na matriz (ex.: o padrão atual + Haiku 5.5 + um DeepSeek V4 Flash + Sonnet 5.5).
5. **"EVA":** qual projeto você quis dizer? A pesquisa achou vários com esse nome (ver `02`). O mais provável é o Vercel Eve (agente durável com canais).

## Custo esperado
- **Tokens:**
  - "Bom dia" continua pequeno; o núcleo do v3 já mede ≤ 50% da entrada do v2.
  - O núcleo cresce com Entregáveis e Agenda (~1,5k caracteres de schema).
  - O contrato de trabalho acrescenta ~1,2k caracteres.
  - Proteção: `economy-replay`.
- **Jobs:**
  - Vigias com intervalo mínimo de 2h, salvo pedido explícito, e com espaçamento quando nada muda.
  - Sono: um job por bot ao fim do dia, com modelo barato.
- **Bench real:** cerca de US$ 3 a 8 por rodada completa, sob demanda e antes de cada corte.
