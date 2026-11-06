# Arquitetura do Motor v4: base nova, do zero

> Decisão do dono (05/11): o v4 é uma **base nova**, modular desde o primeiro commit, feita para que v1 (`computer-use.ts`), v2 (`engine-v2/`) e v3 (`harness/v3`) possam ser **apagados** no fim, sem resto.
>
> Do v3 vêm só **ideias** (efeito declarado, núcleo pequeno, prompt em 3 blocos, compactação com *flush*, checkpoint com journal), reescritas na base nova. Nenhum import.

## 0. Regras de fronteira (o que torna a remoção possível)
- **Pacote novo:** `packages/agent` (`@workspace/agent`).
- **Proibido importar** de `packages/agent-runtime` (v1, v2, v3). Um teste de dependência falha se aparecer `@workspace/agent-runtime` ou um caminho relativo para lá.
- **Tudo de fora entra por porta (interface) injetada:** LLM, db, fila, sandbox, cofre, relógio, eventos. O worker monta as portas com as implementações reais; o teste monta com mocks.
- **Lógica pura compartilhada com o legado** (formatação, parse de gatilho, `ChartSpec`, `PageSpec`, autonomia) vai para `packages/shared`. Nunca se copia código do legado para o v4.
- **Ponte temporária do legado:** existe só em `packages/agent/src/legacy-bridge/`, uma tool por arquivo, cada uma com efeito declarado e teste de contrato.
  - Um teste de catraca (como o `visual-base-guard`) guarda a contagem de pontes. **O número só pode cair.**
  - Quando chegar a zero, `agent-runtime` deixa de ser dependência e é apagado (F10).

## 0.1 Open-source junto com o Atlas (decisão do dono, 05/11)
O motor é **do Atlas**, feito para o Atlas, e é open-source porque o Atlas inteiro é (MIT). Não é uma biblioteca genérica para outros produtos. O que muda por ser aberto:
- **Nada do dono no código.**
  - Nada de chave, e-mail, conta, host ou dado pessoal.
  - O conjunto ouro usa só domínios `.test` e dados inventados.
  - Segredos ficam no cofre ou no `.env` (documentados no `.env.example`).
- **Quem hospeda o próprio Atlas configura tudo.** Provedores e modelos por papel, tetos, VM e conectores vêm de configuração ou da UI, nunca fixos no código. Os padrões funcionam sem nenhuma conta paga específica.
- **Legível para quem chega.**
  - Pastas com nomes claros e módulos pequenos.
  - README do motor explicando o laço, o contrato, as capacidades e como rodar o eval.
  - Os ADRs contam o porquê das decisões.
- **Genérico no comportamento, sem viciar no uso do dono.** O v1 foi sendo moldado pelo uso do dono: há 13 pontos no runtime com casos do ERP Bling, regras escritas para conversas específicas e travas criadas a partir de um caso só. No v4:
  - Prompt, capacidade e regra **nunca** citam pessoa, empresa, site, marca ou conta específicos como regra. Exemplo só como exemplo, e trocável.
  - Correção de comportamento vem de **padrão** (uma classe de tarefa), nunca de um caso do dono. Cada correção precisa passar no conjunto do dono **e** no conjunto genérico (ver `04`).
  - Idioma, país, moeda, fuso e formato de data vêm do bot e do usuário. Nada de "Brasil" fixo, nem no juiz do eval.
  - Conector específico (Bling, Gmail…) tem o seu jeito dentro do próprio conector ou da skill dele, nunca no núcleo do motor.
- **Portas continuam, por testabilidade.** LLM, banco, fila, VM, cofre e relógio entram por interface, para testar com mock e trocar implementação. O motor pode usar os pacotes do Atlas (`@workspace/db`, `shared` etc.) pelas portas.

## 1. Camadas
```
packages/agent/src/
  kernel/        laço, estado do run, checkpoint, compactação, montagem de contexto
  contract/      classes de efeito, política, mandatos, handoff, proveniência (taint), recibos
  channels/      envelopes: fala do usuário, sistema (nonce), dado não confiável
  capabilities/  uma pasta por feature (tools + skill + ganchos + cards + evals)
  agenda/        lembrete, vigia, intenção por evento, brief (só o lado do agente)
  memory/        perfil, caderno, sessões, procedural (só o lado do agente)
  ports/         interfaces: Llm, Store, Queue, Sandbox, Vault, Clock, Events
  presets/       full | minimal (para o eval)
  adapters/      implementações das portas: Prisma, BullMQ, VM, cofre, packages/llm
  legacy-bridge/ temporário, com catraca
apps/worker      monta as portas e chama `runAgent(runId, ports)`
apps/worker/src/sleep/   consolidação (sono)
packages/shared  funções puras: política, agenda, classificação de falha, contrato de eventos
```
Quem importa quem: `capabilities` → `contract`, `channels`, `ports`. `kernel` → tudo, menos `capabilities` concretas: recebe o registro por injeção. Nenhuma capacidade importa outra; o que for comum vai para `contract` ou `shared`.

## 2. Núcleo (`kernel/`)
- **Laço burro:** monta o contexto, chama o modelo, executa as tools pelo `contract`, grava o journal, faz o checkpoint e repete.
  - A resposta sem tool encerra o turno.
  - Nenhum empurrão de comportamento. Só os retries de transporte: resposta truncada, chamada malformada, erro de rede.
- **Estado explícito:** `PREPARE → MODEL → TOOLS → SETTLE → (PARKED | FINAL)`, serializável. O checkpoint é por passo, com journal de escrita para não repetir efeito na retomada.
- **Contexto em 3 blocos, só de acréscimo:**
  1. sistema estável (contrato de trabalho, canais, idioma);
  2. `[context]` (índice de capacidades, memória, caderno fixado);
  3. `runtime` volátil no fim.
  - Capacidade carregada entra no fim e não sai.
  - Tools nunca são removidas no meio do run; o que não pode ser usado é negado pela política com mensagem.
- **Compactação só quando a janela do modelo está para encher**, nunca para economizar:
  - O gatilho é a janela de contexto do modelo do papel (~85%), não um orçamento de custo.
  - Ordem:
    1. *flush*: o que está em uso vai inteiro para o caderno de trabalho ou para um arquivo, e fica restaurável;
    2. só então resume, guardando caminhos, URLs, ids, o último erro de cada tool e a referência ao que foi para o caderno.
  - Nada some sem ficar recuperável: o modelo relê do caderno ou do arquivo quando precisar.
- **Sem corte por economia (decisão do dono, 05/11).** Os motores v1, v2 e v3 cortavam contexto e pesquisa para gastar menos, e o bot não terminava o trabalho. No v4:
  - **não existe** teto padrão de chamadas de pesquisa;
  - nenhuma saída de tool é cortada para caber num orçamento, nem o modelo ou a pesquisa param por custo;
  - não existem estes módulos do legado: `research-budget.ts`, `tool-budget.ts`, `generation-budget.ts`, `subagent-budget.ts` e o corte de saída por tamanho de `tools-json-size.ts`.
  - Fica só o limite **técnico**: página ou arquivo grande demais para a janela é lido **em partes** (paginação com "ler o resto"), nunca truncado em silêncio.
  - Economia de verdade vem de não **carregar** o que não vai ser usado (módulos sob demanda, cache estável), nunca de **cortar** o que está sendo usado.
  - O único teto de gasto é o que o dono configurar.
- **Limites:** só os que protegem o dono (teto que ele configurou, US$, passos sem humano) e o laço infinito (ADR 0003).
  - Bater no limite nunca aborta calado: vira passo final com o motivo real e o gasto.
- **A resposta do modelo nunca é reescrita, descartada nem substituída.** Texto vazio depois do retry vira evento de status com o motivo.

## 2.1 Ciclo de vida da tarefa: nunca insistir
- **Uma tarefa vive dentro de um turno.** Nenhum run herda itens abertos de outro run. Não há "previous task stopped with open items", nem lista semeada, nem continuação automática por item aberto. O histórico da conversa basta: o modelo vê o que aconteceu, como qualquer pessoa veria.
- **Atravessar turnos é sempre explícito:** o modelo agenda (`remind_me`, `watch`) ou deixa uma pendência no cartão de espera. Os dois têm estado próprio, freio e contagem de ignorados.
- **Falhou e avisou = encerrado.** Uma tarefa que falhou e foi relatada termina como `not_done` com o motivo. Ela não volta sozinha.
- **Oferta tem estado.** "Quer que eu continue?" só existe como **cartão de pergunta** (`ask_owner`), nunca como texto solto que o harness persegue. O cartão termina como `answered`, `dismissed` ou `ignored`.
  - `ignored` é estrutural: o dono mandou outra mensagem sem tocar no cartão.
  - Oferta ignorada ou dispensada **não volta** na conversa. Fica em `declinedOffers`, no estado da conversa, e o modelo recebe como dado: "você já ofereceu X e o dono não quis; não ofereça de novo".
- **A agenda herda o freio:** vigia ou lembrete com 2 avisos seguidos ignorados se encerra sozinho, e a contagem é por item.

## 3. Contrato (`contract/`): onde mora a coerência
É a parte que faz o bot se comportar **sempre igual**, em chat, agenda, rotina, subagente, bot-para-bot, web e celular. O detalhe está em [`06-contrato-de-comportamento.md`](06-contrato-de-comportamento.md). Em resumo:
- **Classe de efeito obrigatória** em `defineTool`: `read`, `draft`, `write_internal`, `write_external`, `send`, `money`, `public_link`, `credential`, `destructive`. Sem classe, a tool não registra.
- **Três estados por chamada:** `run`, `approve` (cartão com os argumentos reais) e `handoff` (o dono faz).
  - A decisão é **uma função pura** em shared: `decide(effect, surface, owner, autonomy, rules, taint, mandate)`.
  - É a mesma função em todas as superfícies.
- **Aprovação = token** ligado ao hash dos argumentos. O executor recusa a execução sem token válido. O modelo não consegue "se aprovar".
- **Mandato:** autorização delimitada por valor, loja, prazo e número de usos, para quem quer mais autonomia. Nunca "sempre permitir" em `money`, `destructive` ou `credential`.
- **Lista fixa de handoff:** trocar senha, mover dinheiro entre contas, aceitar termos, criar conta e investir.
- **Proveniência:**
  - Todo valor lido de fonte não confiável (e-mail, página, arquivo, MCP de terceiro, outro bot) carrega um *taint*.
  - Efeito externo (`send`, `write_external`, `public_link`) cujos argumentos contêm dado com taint, ou que acontece depois de leitura com taint no mesmo run, passa de `run` para `approve`.
  - É a defesa contra a "trifeta letal".
- **O autorizador não lê conteúdo.** O cartão e a política veem só metadados e argumentos tipados, nunca o corpo do e-mail ou da página.
- **Segredo nunca no contexto.** Senha, token e cartão são preenchidos pela porta `Vault` na camada de execução (`login_fill` e `card_fill`). Um teste varre eventos, journal e mensagens procurando segredos.
- **Recibo:** toda tool de efeito devolve um `Receipt` tipado (o que fez, onde, id externo, link). Os cards de resultado e o "o que eu fiz" são montados **do journal de recibos**, não da narração do modelo. O texto do modelo continua intacto ao lado.

## 4. Canais (`channels/`)
- **Fala do usuário:** mensagem `user` limpa.
- **Sistema:** `<atlas:runtime id="{nonce}">`, com nonce por run citado no prompt estável.
- **Dado não confiável:** `<data source="email|web|file|mcp:{conector}|bot:{nome}" trust="untrusted">`.
- **Escape determinístico** de `<atlas:` e `<data` em tudo que não vem do runtime.
- A origem vem de `RunInput.kind` e de `ConversationMessage.origin`, nunca de marcador no texto.

## 5. Capacidades (`capabilities/<id>/`)
```ts
export default defineCapability({
  id: "shopping",
  title: "Compras",
  summary: "Find products, compare prices, buy with the saved card, track delivery.",
  core: false,
  tools: [productSearch, checkout, recordPurchase],   // cada uma com effect
  skill: "./skill.md",                                // só entra ao carregar
  hooks: { afterTool: { record_purchase: trackDelivery } },
  cards: ["product", "purchase"],                     // tipos em shared
  evals: ["shopping/*"],
});
```
- **Índice de uma linha por capacidade** no `[context]`. O modelo carrega com `use_capability(id)`. Não há roteador por regex.
- **Ganchos tipados:**
  - `beforeTool` pode devolver só `{ verdict, riskFacts }`;
  - `afterTool` pode devolver só `{ schedule, note-no-resultado }`;
  - `onRunEnd` e `onWake` completam o conjunto.
  - Nenhum gancho toca no texto do assistente.
- **Capacidades iniciais:**
  - Núcleo: `web` (busca e extração), `deliverables` (arquivo, painel, gráfico, inspeção), `agenda`, `memory` (memória e caderno), `tasks` (lista de tarefas).
  - Sob demanda: `research`, `email`, `calendar`, `shopping`, `browser` (VM), `code`, `connectors` (ponte MCP com `tool_search`), `bots` (falar com outros bots), `routines` (o recorrente do dono), `settings` (configurar o bot pelo chat).
- **Feature nova:** pasta + registro + evals. Sem tocar no `kernel`.

## 6. Agenda do agente (`agenda/` + worker)
Uma entidade só para a proatividade do agente. `BotFollowup` ganha uma migration aditiva com `kind`, `intervalMinutes`, `untilAt`, `maxRuns`, `eventFilterJson`, `noChangeStreak` e `lastResultJson`.
- **Tipos:**
  - `remind`: o "me lembra" e o "eu volto";
  - `watch`: de X em X tempo, até uma condição;
  - `intent`: quando chegar o e-mail tal, faço Y;
  - `brief`: plano do dia, inspirado no brief matinal do Duet e no Daily Brief do Gemini.
- **Freios estruturais:**
  - intervalo mínimo de 2h, salvo pedido explícito;
  - espaçamento por `noChangeStreak`;
  - `maxRuns`;
  - limite por dono;
  - para depois de N avisos ignorados (freio da Meta);
  - horário útil.
- **Contrato silencioso:** o run de agenda termina com `agenda_result(no_change | update | done)`. `no_change` não posta nada.
- **Permissão decidida na criação e persistente:** a agenda roda com perfil sem humano. O que precisa do dono vira **pendência na fila** ("termina o resto e traz a aprovação depois", como o Duet). Nunca pergunta a cada execução, que é a falha do Cowork agendado.
- **Visível e pausável:** seção "Agenda" na Biblioteca. A criação é silenciosa, como manda a regra de produto.

## 7. Memória (`memory/` + sono)
| Camada | Entidade | No contexto | Visível e editável pelo dono |
|---|---|---|---|
| Perfil e preferências | `MemoryEntry` | sempre (com teto) | sim (já existe) |
| Caderno | **`Note`** nova | títulos fixados; o resto por busca | sim, Biblioteca → Caderno |
| Sessões | `ConversationSummary` + FTS | por busca | via histórico |
| Procedural | `Skill*` | índice de uma linha | sim |
| **Regras aprendidas** | regras de política em `policyJson.rules` | via política | **sim, sempre**; é o diferencial contra dots e Duet, que escondem |

- **Nada que o agente aprende fica fora dessas cinco camadas.**
- **Sono** (job por bot, fim do dia):
  - propõe fatos, notas, skills e casos de eval a partir das falhas;
  - só promove de fonte confiável;
  - duplicata por embedding;
  - toda mudança vai para `MemoryChange` (diff e desfazer).
- Escopo por dono e por conversa: memória de grupo não vaza para o 1:1 (Meta).

## 8. Modelos e presets
- **Papéis de modelo:** `main`, `helper`, `code`, `vision`, `sleep` e `classifier`.
  - Cada papel tem uma **cadeia ordenada de provedor + modelo**, configurada pelo dono por bot ou por conta e mudável pelo chat. Ex.: `main` = Sonnet (Anthropic) → Sonnet (OpenRouter) → modelo da assinatura ChatGPT; `code` = Opus; `helper` e `sleep` = Haiku.
  - O `classifier` só classifica *schema* de tool MCP sem anotação, uma vez, em cache.
- **Nunca travar por cota:**
  - limite, erro 429 ou indisponibilidade no provedor → o próximo da cadeia assume **no mesmo passo**, com o checkpoint intacto;
  - o dono recebe um evento de aviso curto, e o run nunca morre por cota de um provedor só;
  - a escolha é uma função pura em shared (`pickModelFor(role, chain, health, ceilings)`), testada.
- **Teto opcional do dono:** US$ ou tokens por dia, semana ou mês. A nota de parada diz qual teto, quanto foi gasto e como liberar. Painel de uso por provedor e modelo.
- **Porta `Llm`:** reaproveita `packages/llm` (`provider-router`, `provider-fallback`, `prompt-cache`), que já fala Anthropic, OpenRouter, assinatura ChatGPT/Codex e OpenCode.
- **Presets:**
  - `full`;
  - `minimal`: núcleo, web e arquivo, sem capacidades nem contrato de trabalho;
  - os motores legados, via eval, enquanto existirem.
- Trocar o modelo e manter o harness, ou o contrário, é só uma configuração (`04-avaliacao.md`).

## 9. Convivência e remoção do legado
- **Entrada:** `chooseRunEngine` ganha `v4`, atrás de `ATLAS_ENGINE_V4` + `ATLAS_ENGINE_V4_ACCOUNTS`. O contrato externo (status do run, lease, `{runId}`, `run_events.seq`, tipos de `ComputerUseEvent`) é mantido, e os eventos novos entram como tipos novos em shared.
- **Subagentes:** hoje estão no v1. No v4, `research` e `delegate` usam o próprio kernel com preset filho, e a política filha nunca concede mais do que a mãe.
- **Remoção:** quando a catraca da ponte chegar a zero e o critério de corte for atendido:
  1. o v2 vira emergência por 2 versões;
  2. depois saem `engine-v2/`, `computer-use.ts` (v1), o branch `harness/v3`, `intent-router.ts`, `memory-gate.ts` e `lesson-gate.ts`, junto com os testes deles;
  3. ADR 0006 registra a remoção.
