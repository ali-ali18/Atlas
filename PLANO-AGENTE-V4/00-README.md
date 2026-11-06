# Plano Motor v4: um agente que trabalha sozinho

> Status: **rascunho para aprovação do dono** (05/11/2026). Nenhum código foi escrito.
>
> Arquivos:
> - [`PROGRESSO.md`](PROGRESSO.md): **comece por aqui** para executar. Checklist por fase e passagem entre contas.
> - [`auditorias/README.md`](auditorias/README.md): auditoria ao fim de cada fase (segurança, bugs, testes, contrato, custo), com verificação, correções e reauditoria.
> - [`01-diagnostico.md`](01-diagnostico.md): o que v2 e v3 fazem hoje e por que não parecem melhores.
> - [`02-referencias.md`](02-referencias.md): o que copiar dos harnesses abertos.
> - [`03-arquitetura.md`](03-arquitetura.md): núcleo, capacidades, ganchos, canais, memória e agenda.
> - [`04-avaliacao.md`](04-avaliacao.md): como saber se o problema é o harness ou o modelo.
> - [`05-fases.md`](05-fases.md): fases, PRs, arquivos, testes e critério de pronto.
> - [`07-explicacao-em-audio.md`](07-explicacao-em-audio.md): o plano inteiro em texto corrido, para ouvir.
> - [`06-contrato-de-comportamento.md`](06-contrato-de-comportamento.md): as 17 cláusulas de coerência de uso, com mecanismo e teste invariante.
> - [`pesquisa/coerencia-de-uso.md`](pesquisa/coerencia-de-uso.md): pesquisa sobre Grok Bot, ChatGPT dots, Claude Duet, Gemini, Alexa+, Comet, Manus e outros (notas em `pesquisa/notas/`).
>
> **Revisão de 05/11:** o dono decidiu fazer uma **base nova, do zero**, modular, preparada para apagar v1, v2 e v3 no fim. O v3 vira só referência de ideias. O foco é a **coerência de uso**: o bot se comporta sempre igual, em qualquer superfície.

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

O v4 é uma **base nova** (`packages/agent`), sem import do legado. A ideia é que a coerência nasça da arquitetura e não do prompt: a pesquisa mostra que os produtos coerentes (Claude Duet, ChatGPT dots, Gemini) decidem no código, por classe de efeito, o que fazem sozinhos e o que perguntam. Sobre essa base, o v4 investe no que o usuário sente:
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
| Faz compras com o cartão salvo, sempre confirmando | Compras (F6): cartão no cofre sem o CVV; o CVV é digitado pelo dono a cada compra, no cartão de aprovação, e vai direto para a loja |
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
| Não insistir em tarefa que larguei (ex.: resumo de vídeo) | Ciclo de vida da tarefa (`03` §2.1), cláusula 17; causa no v2 em `01` |
| Sem travas e sem regex; não reescreve a resposta | Princípios 1 a 3 abaixo, com teste de guarda |

## Princípios (valem para todo PR do v4)
0. **Coerência é contrato no código.** As 17 cláusulas de `06` têm mecanismo e teste invariante. A frase do Atlas: "Eu leio, pesquiso, rascunho e organizo sozinho. Antes de enviar, pagar, publicar ou apagar, eu te mostro exatamente o quê. Senha, dinheiro entre contas e aceite de termos ficam com você. Você vê tudo o que eu agendei e aprendi, e pode parar a qualquer momento."
0.0 **Open-source como o Atlas.** O motor é dedicado ao Atlas e público como ele: nada do dono no código (chave, conta, dado pessoal), tudo configurável por quem hospeda (provedores, modelos, tetos), legível e documentado (`03` §0.1).
0.1 **Sem corte por economia.** Nada de cortar contexto, pesquisa ou saída de tool para gastar menos (o que fazia o v2 não terminar pesquisa). Economia vem de não carregar o que não vai ser usado. Compactação só quando a janela está cheia, e sempre restaurável. O único teto de gasto é o do dono.
1. **Núcleo burro, capacidades espertas.** O laço só chama o modelo, executa tools e persiste. Inteligência de domínio mora na capacidade (skill + tools + ganchos), carregada sob demanda.
2. **Zero regex sobre texto do usuário ou do modelo para decidir comportamento.** Decisão vem de sinal estrutural: efeito declarado da tool, argumentos tipados, estado do run, configuração do dono. Um teste de guarda varre `engine-v4/` e `capabilities/` (ver F1).
3. **A resposta do modelo nunca é reescrita, descartada nem trocada.** Não há revisor, rascunho revisado nem portão de entrega. Se algo faltou, o próprio modelo é que nota (via resultado de tool) e age.
4. **Liberdade com fronteira.** O modelo decide o caminho. O harness só intervém nos limites que protegem o dono (dinheiro, envio, link público, credencial, teto que o dono configurou) e no laço infinito (ADR 0003).
5. **Proatividade é trabalho agendado com contrato silencioso.** Vigia, lembrete e "planejar o dia" são jobs. Sem novidade, o resultado é `no_change` e nada é postado.
6. **Só entra no contexto o que vai ser usado.** O núcleo tem as tools que quase todo pedido usa. O resto vem por capacidade, carregada pela intenção que o próprio modelo declara (sem roteador por regex).
7. **Toda falha tem dono:** harness, modelo ou ambiente. O run guarda o suficiente para o eval classificar sozinho (`04`).
8. **Aprender fora do caminho quente.** Memória e skills se consolidam num job de "sono" depois do run, com proveniência, sem juiz LLM bloqueando a resposta.

## Decisões
- ~~Base~~: **base nova, do zero** (decisão do dono, 05/11).
- ~~"Duet" e "dots"~~: identificados. São o Claude Duet (Anthropic, prévia de 21/10/2026) e os dots do ChatGPT (DevDay de 29/09/2026). Ver a pesquisa.

- ~~Compras~~: **cartão salvo no app sem o CVV** (decisão do dono, 05/11). Número, nome, validade e endereço ficam no cofre. Toda compra pede aprovação. Ao aprovar, o dono digita o CVV num campo seguro do cartão de aprovação, e o valor vai direto para o formulário de pagamento da loja no navegador da VM. O modelo nunca vê o CVV, e ele não é guardado (ver F6).

- ~~Modelos~~: Sonnet (conversa), Haiku (rápido, ajudantes, sono) e Opus (código), mais 2 baratos de outros provedores para comparar, escolhidos na F0.5.
- ~~Branch `harness/v3`~~: **congelado**, só como referência.
- ~~"EVA"~~: **Vercel Eve**. As ideias aproveitadas estão em `02-referencias.md`.

**Execução:** acompanhe e retome por [`PROGRESSO.md`](PROGRESSO.md). Ele traz o checklist por fase, o protocolo de commit e push por item e o diário de passagem entre contas do Claude.

## Controle de provedor e modelo (motivo do Atlas existir)
O problema do Grok Bot não é o preço, é a **cota**. Ela acaba no meio da semana e trava faculdade, trabalho e projetos até sábado. O v4 garante **liberdade de escolha e nunca ficar travado**:
- **Modelo por papel, escolhido pelo dono:**
  - conversa e trabalho geral (ex.: Sonnet);
  - passos rápidos, ajudantes, sono e classificação (ex.: Haiku);
  - código (ex.: Opus);
  - visão.

  Configurável por bot e mudável pelo chat ("usa o Opus nessa tarefa").
- **Vários provedores ao mesmo tempo:** chave própria da Anthropic, OpenRouter, assinatura ChatGPT/Codex e outros que a camada `packages/llm` já fala (`provider-router`, `provider-fallback`).
- **Cadeia de reserva por papel:** se um provedor bate limite ou cai, o próximo da lista assume no mesmo passo. O dono recebe um aviso curto ("troquei para X porque Y bateu o limite").
- **Teto só se o dono quiser:** US$ ou tokens por dia, semana ou mês, por bot ou por conta. Quando um teto dispara, a nota diz qual teto, quanto foi gasto e como liberar. Nunca trava em silêncio.
- **Painel de uso:** quanto cada provedor e cada modelo gastou, para o dono decidir.
- **Eficiência continua importando, para render mais:**
  - "Bom dia" pequeno (teste de economia);
  - cache de prompt estável;
  - módulos sob demanda;
  - agenda com freios;
  - sono com modelo barato.
- **Bench real:** cerca de US$ 3 a 8 por rodada completa, sob demanda.
