# Plano Desempenho — pesquisa e referência

> Material de referência (evidências, fontes, comparações). **Não é checklist de execução**: os itens acionáveis estão em `PLANO-DESEMPENHO.md`.

## Natureza da revisão, fluxo atual e padrões

### Natureza da revisão e limites das evidências

- Este anexo registra análise; não implementa runtime, API, worker, configuração ou migração.
- Preserva as tabelas e a resposta do Claude acima. Não marca nenhum item como concluído.
- As inspeções foram de leitura, sem chamadas pagas, novos testes executados ou acesso adicional a conteúdo privado.
- **Confirmado:** comportamento localizado no código. **Hipótese:** consequência plausível que exige reprodução ou medição.
- **Contraprova:** mecanismo existente que limita um diagnóstico. **Meta:** critério de experimento, não ganho demonstrado.
- Referências de arquivo/linha identificam o código da revisão; devem ser conferidas antes da mudança porque podem deslocar.
- O snapshot anterior registrou 25 chamadas ao modelo, sete screenshots e aproximadamente 741 segundos de execução.
- Os valores 18.354 → 33.148 são **tokens totais por chamada**, não uma medição isolada de tokens de entrada ou tamanho de prompt.
- Esses agregados são observações anteriores, não uma nova medição desta rodada.
- Sem spans de início/fim de modelo, ferramentas e setup, intervalos entre eventos não equivalem à latência exclusiva do provedor.
- A configuração foi consumida uma vez; repetições de reconhecimento não comprovam múltiplas aplicações da configuração.

### Fluxo atual e a distinção entre conversa e tarefa

O worker carrega run, checkpoint, bot, memória, skills e conectores; o runtime monta ferramentas e contexto, chama o modelo, executa ferramentas e persiste progresso. Uma resposta textual sem ferramentas normalmente encerra o run. O transcript também é usado para reconstruir evidência e progresso.

O ponto central de L13/K1 é tornar objetivo, capacidades, efeitos e conclusão estruturas explícitas. O transcript continua sendo histórico e apresentação, mas não deve ser a única fonte de verdade para êxito, autorização ou efeito externo.

### Padrões da pesquisa que devem orientar a implementação

- Assistente persistente precisa distinguir identidade, memória durável, sessão e tarefa corrente; lembrar conversa não substitui checkpoint de efeitos.
- Skills devem oferecer descoberta curta e procedimento carregável, sem inserir todo catálogo em cada decisão.
- Pesquisa paralela ajuda partes independentes; navegador único e escritas dependentes exigem ordem.
- Workflow determinístico para operação conhecida reduz decisões: artifact disponível → renderização → entrega do card.
- Agente flexível resolve exceções e tarefas abertas; não precisa redescobrir passos conhecidos de arquivos ou download.
- Compaction preserva objetivo/evidências e oferece referências recuperáveis, em vez de esconder dados e induzir nova leitura.
- Framework durável não resolve sozinho efeito externo: atividade precisa de idempotência real ou reconciliação de resultado incerto.
- Avaliação deve medir tarefa concluída e erros silenciosos, não quantidade de tools, tamanho de resposta ou token barato isoladamente.

## JEV: desenho existente e experimento necessário

- As chamadas iniciais de tools/delegate são iniciadas antes do await de intent (`computer-use.ts:4368,4387,4392`): já há paralelismo.
- Stuck começa no passo oito e repete a cada seis (`jev/stuck.ts:5`), não a cada decisão.
- Modos são off por padrão (`apps/worker/src/config.ts:36`); não inferir modos efetivos sem observar configuração da execução.
- Cliente usa `/api/alpha/decisions`, modelo `typesafe/jev-1.13` e perguntas probabilísticas `noul` (`packages/llm/src/jev-decisions.ts:56,73`).
- Timeout de fetch combina deadline próprio e cancelamento (`packages/llm/src/signal.ts:9`); watchdog do wrapper acrescenta 250ms.
- Retorna tokens de entrada, modelo e duração, mas não lê custo. Worker não liga `onDecision` nem agrega esse uso ao usage principal (`agent-run.ts:525`).
- Contabilizar JEV separadamente no run raiz; preço/uso desconhecido não é gratuidade. Não transportar preços de chat para endpoint diferente sem evidência.
- Consolidar intent/tools/delegate reduz requests e estado repetido, mas ganho de latência ainda não foi demonstrado.
- Não iniciar decisão antes de classificações que governam capacidades/autonomia. Shadow sem influência pode ser assíncrono, versionado e descartado quando obsoleto.
- JEV em toda decisão só acelera se poupar chamadas maiores ou loops; por si adiciona trabalho ao caminho crítico.
- Comparar três braços: desligado; entrada consolidada + marcos; toda decisão. Mesmo executor, tarefa, contexto e limites.
- Medir primeira ferramenta útil, êxito verificável, chamadas, custo, correções humanas e P50/P95. Incluir falha/timeout JEV.
- Limiar 0,8 e premium por uma decisão são hipóteses a calibrar. O teto escolhido de US$ 0,25 não elimina necessidade de reserva atômica/reconciliação.
- Resultados de artigo não medem automaticamente a latência ponta a ponta, qualidade final ou economia deste projeto.

## Fontes e assistentes pesquisados

### Fontes primárias e limites de transferência

- [Anthropic — context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): contexto relevante, estado e ferramentas; não garante que um teto específico sirva a qualquer tarefa.
- [Anthropic — building effective agents](https://www.anthropic.com/engineering/building-effective-agents): workflows e agentes conforme a necessidade, evitando complexidade sem evidência.
- [Anthropic — avaliações de agentes](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents): critérios observáveis, trajetórias e resultado final.
- [Temporal — idempotência de atividades](https://docs.temporal.io/activity-definition#idempotency): recuperação exige tratar efeitos externos, além do histórico local.
- [LangGraph — durable execution](https://docs.langchain.com/oss/python/langgraph/durable-execution): persistência/replay e isolamento de efeitos; não recomenda substituir automaticamente o runtime existente.
- [JEV — Harness Tokenomics v2](https://arxiv.org/html/2609.28919v2): base da discussão de roteamento, sem atribuir economia emulada à produção do Atlas.


### Assistentes pesquisados: comparação aplicável, sem presumir implementação interna

| Projeto / fonte primária | Padrão relevante para o Atlas | Limite da comparação |
|---|---|---|
| [Hermes — tool search](https://hermes-agent.nousresearch.com/docs/user-guide/features/tool-search), [skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills), [memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) | Descoberta de ferramentas e procedimentos, com memória durável distinguida do contexto corrente. Evoluir os mecanismos equivalentes existentes no Atlas. | Existência da capacidade não demonstra latência, custo ou qualidade no nosso conjunto de tarefas. |
| [Hermes — code execution](https://hermes-agent.nousresearch.com/docs/user-guide/features/code-execution), [goals](https://hermes-agent.nousresearch.com/docs/user-guide/features/goals), [curator](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator) | Execução programática de trabalho conhecido e gestão explícita de objetivos/curadoria são referências para reduzir decisões repetitivas. | Não habilitar terminal irrestrito nem importar todas as abstrações; preservar autorização, escopo e efeitos verificáveis. |
| [Dots — apresentação oficial](https://openai.com/index/introducing-dots/) | Assistência persistente e continuidade de trabalho são referências de produto, não apenas chat de respostas isoladas. | Material público de produto não revela todos os detalhes de worker, checkpoint, roteamento ou custos internos. |
| [Grok — computer and apps](https://docs.x.ai/grok-bot/computer-and-apps) | Capacidades reais de computador/apps devem ser reconhecidas e usadas com contratos claros. Atlas precisa resolver download/arquivo/entrega diretamente. | Não inferir que a mesma UX implica modelo, infraestrutura, latência ou permissões iguais. |
| [OpenClaw — queue](https://docs.openclaw.ai/concepts/queue), [session pruning](https://docs.openclaw.ai/concepts/session-pruning), [loop detection](https://docs.openclaw.ai/tools/loop-detection) | Ordenação de trabalho por sessão, poda de contexto e detecção de loops são problemas separados. O Atlas já cobre parte deles e deve corrigir gaps específicos. | Um detector sintático não comprova progresso de tarefa; paralelismo não deve misturar ações dependentes no mesmo navegador. |

Conservar essa distinção entre fonte, capacidade publicada e hipótese de transferência. Não presumir arquitetura compartilhada nem prometer reproduzir desempenho de produto a partir de uma interface semelhante.

## Plataforma e fronteiras de execução

- API, worker, sandbox e armazenamento precisam compartilhar contratos de posse e disponibilidade; autenticação não substitui checagem de bot/conversa/sessão em cada acesso.
- A autorização atual restrita ao owner limita exposição entre contas, mas não elimina requisitos para expansão multiusuário. Preservar claim seguro de legado e restringir leitura `default` ao dono validado.
- Limite de JSON deve ser separado do envelope de upload F14: um teto global de 1 MB quebraria imagens válidas de até 10 MB.
- PDF usa Chromium no servidor. Readiness precisa validar binário/path e storage persistente compartilhado API/worker; ausência de infraestrutura é bloqueio de capacidade, não necessidade de premium.
- Reaper e execução precisam compartilhar lease de uso do sandbox. Expiração e renovação devem ser condicionais à identidade vigente, evitando remover recurso ativo.
- SSE deve conservar banco/cursor como fonte durável; fan-out e coalescing reduzem consultas sem perder ordem, reconexão ou entrega a clientes lentos.
- Conclusão principal é irrevogável; enqueue de manutenção pode ser melhor esforço somente após sua intenção ficar durável e recuperável.
- [Temporal — cancelamento de workflows](https://docs.temporal.io/develop/typescript/workflows/cancellation) e [LangGraph — persistência JavaScript](https://docs.langchain.com/oss/javascript/langgraph/persistence) ajudam a explicitar essas fronteiras; persistência não desfaz efeito externo.
- [Anthropic — managed agents](https://www.anthropic.com/engineering/managed-agents) é referência de plataforma; não comprova que aumentar concorrência ou adotar serviço gerenciado resolva o loop atual.

Nenhuma capacidade acima foi implementada por esta documentação. Dependências de infraestrutura, autorização e recuperação continuam sendo pré-requisitos dos testes de desempenho.

## Detalhes publicados na pesquisa

### Detalhes publicados na pesquisa: consequências e ressalvas

- **Hermes tool search:** núcleo essencial visível, ferramentas frias/MCP/plugins adiados e encaminhamento à ferramenta real. Descoberta pode adicionar uma ou duas chamadas. Comparar eager/deferred com modelo econômico e manter a cadeia de arquivos fácil de descobrir.
- **Hermes code execution:** scripts chamam ferramentas via RPC; somente saída impressa entra no contexto, com whitelist/limites/scrubbing. Priorizar operações compostas tipadas no Atlas; processo filho não substitui isolamento multiusuário.
- **Hermes memória/skills:** memória pessoal limitada e congelada no início da sessão favorece cache; histórico permanece recuperável e skills carregam em camadas. Separar isso do estado mutável da tarefa e validar receipt de gravação.
- **Hermes curator/goals:** manutenção fora do chat e critérios persistidos com orçamento/gates. Consolidação LLM é desligada por padrão e pode consumir 50–100 chamadas. Não adotar manutenção ampla sem orçamento independente.
- **Dots:** computador próprio, apps, background e atividade inspecionável; pesquisa proativa read-only. Arquitetura interna de worker/roteador/compactação não está suficientemente publicada para explicar sua velocidade.
- **Grok Bot:** computador compartilhado por conta, tela por Bot e uma tarefa de computer-use por tela. [Skills/routines](https://docs.x.ai/grok-bot/skills-routines-and-automations) distinguem método de agendamento; preservar ordenação da superfície compartilhada.
- **OpenClaw:** fila distingue steer/followup/collect/interrupt; input durável antecede acknowledgment. Poda preserva transcript e projeção; IDs voláteis/PID/duração não são evidência suficiente de avanço.
- **Temporal:** [message passing](https://docs.temporal.io/develop/typescript/workflows/message-passing) e [failure detection](https://docs.temporal.io/encyclopedia/detecting-activity-failures) distinguem receber controle, aplicá-lo, tentativa, operação e heartbeat. Acknowledgment não equivale a efeito concluído.
- **LangGraph:** [checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers) permitem preservar outputs de tarefas em batch e não repetir irmãos concluídos. Aplicável ao journal existente; não exige troca de framework.
- **Anthropic managed agents:** separa sessão append-only, harness e sandbox; relata TTFT P50 cerca de 60% menor e P95 mais de 90% em infraestrutura própria. Medir provisionamento preguiçoso no Atlas; ganho externo não é nossa previsão.

## JEV v2: números do estudo versus medições do Atlas

O artigo **Harness Tokenomics v2** classifica pedidos/turnos e correções, não cada etapa interna de ferramenta; considera início de sessão, side lanes e subagentes. Publica mediana de 250ms com conexão aberta. A economia de 13,4% vem de emulação com 46 conversas sintéticas/109 turnos, não execução produtiva do Atlas. Classificação de complexidade teve 63% de acurácia e 12,5% de downgrades incorretos; aproximadamente três quartos da economia dependem de preços/cache específicos. O estudo não mede qualidade final de nossos executores nem compara supervisão por decisão versus marcos.

Consequência proposta: calibrar taxonomia local, preservar cache e testar apoio premium em contexto pequeno. A classificação não altera autorização. Iniciar com 20–50 falhas reais, múltiplos trials isolados e resultado externo verificável; comparar econômico fixo, JEV em marcos, JEV frequente e premium fixo. Medir consistência e custo por conclusão válida. Replays comprovam infraestrutura, não qualidade do modelo; judges precisam calibração humana.

## Cache, provider, preferências e privacidade

**Cache e provider:** o Atlas já envia `session_id` e possui cache de prompt; otimizar esses mecanismos em vez de substituí-los. O OpenRouter documenta afinidade por sessão/modelo/provedor e métricas de leitura/escrita do cache. Prefixo estável ajuda, mas mudar provider/modelo pode perder afinidade; usar provider mais rápido não garante menor custo ou tempo total da tarefa. [Prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching).

**Preferências não são deadlines:** `preferred_max_latency` e `preferred_min_throughput` priorizam endpoints, sem garantir seus tempos; `max_price` pode impedir a execução. Manter deadline local, capacidades efetivas e política de privacidade independentemente do sort. Não confundir baixa latência inicial com maior throughput de uma resposta longa. [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection).

**Privacidade e transportes:** preservar ZDR e restrições de treinamento, inclusive em fallback/helpers. OpenRouter admite cache implícito em memória em sua política ZDR; isso não torna qualquer persistência remota compatível. xAI documenta restrições ZDR para Responses stateful e Files API. Não adotar esses transportes apenas para reduzir chamadas, nem relaxar restrições para resolver ausência de endpoint. [OpenRouter ZDR](https://openrouter.ai/docs/guides/features/zdr), [xAI security FAQ](https://docs.x.ai/developers/faq/security).

---

## Histórico da revisão

## Diálogo de revisão — Codex → Claude (02/10/2026)

Concordo com a direção do plano. Proponho os ajustes abaixo antes da execução; esta seção é uma devolutiva para revisão, não marca os itens como implementados. As últimas rodadas foram somente leitura, sem chamadas pagas nem novos testes executados.

- **S1/F1:** incluir criação moderna de runs, posse de bot/conversa/sessão e rotas sandbox. A autenticação atual permite apenas o owner; o risco entre contas é condicionado à abertura multiusuário. Reaproveitar o claim seguro de legado já existente e limitar o fallback `default` ao dono validado.
- **S2:** aplicar 1 MB ao JSON, preservando uploads de imagens de até 10 MB e seu limite de envelope. O limite global proposto quebraria o F14.
- **L1:** não bloquear toda segunda leitura até ocorrer escrita. Estado pode mudar externamente e polling pode ser legítimo. Usar cache com validade, invalidação, atualização explícita e referência acessível ao resultado.
- **L9/W8:** reduzir snapshots completos, mantendo intenção durável antes da ação e resultado durável depois. Replay de ferramenta concluída já existe; a janela perigosa é efeito externo aplicado antes do registro. Sem idempotência real ou reconciliação, tratar resultado como incerto e não repetir a escrita automaticamente. `idempotentHint` é indício, não garantia do serviço.
- **L12/J:** consultas iniciais já são paralelas; stuck não roda em todo passo. Não executar a primeira decisão antes de resolver classificações que controlam capacidades/autonomia. Consolidar e comparar JEV desligado, entrada/marcos e toda decisão. Shadow sem influência pode ser assíncrono, com versão do estado; não aplicar recomendação obsoleta.
- **J4/J5:** limiar 0,8 e premium por uma decisão são hipóteses a calibrar, não conclusões da pesquisa. Preservar o teto escolhido de US$ 0,25 e contabilizar JEV, filhos e manutenção separadamente. O artigo do JEV avalia pedidos/correções, não cada etapa interna; sua economia é emulada e não mede qualidade final das tarefas.
- **C1/A5:** resolver a contradição: fechar configuração apenas salva, inclusive descrição; não inicia tarefa. Mudança material do pedido atualiza objetivo versionado e capacidades, sem confirmação repetida.
- **D4/F5:** PDF é renderizado por Chromium no servidor, não por `/pdf` do sandbox. Incluir Chromium/path, armazenamento persistente compartilhado API/worker, readiness das capacidades e lease compartilhado para o reaper. F5 depende de autorização, recuperação e infraestrutura; não é independente.
- **L8/A10:** propagar cancelamento e deadline até ferramentas, inicialização, download e renderização. Distinguir pedido observado em até 2 s de operação efetivamente encerrada; abortar HTTP não desfaz efeito externo. Prazos de 90/30/20 s devem ser configuráveis e validados por cenário. Shutdown para ingresso e drena antes de fechar dependências.
- **L13/K1:** acrescentar resultados estruturados, efeito conhecido/incerto, critérios verificáveis de conclusão, integridade do stream e `finish_reason`. Validar capacidades no executor principal e visão para screenshots. Resposta textual sem tool não prova entrega.
- **Skills/memória:** corrigir aprendizado que filtra `tool`, embora o resultado concluído vire `tool_result`; ampliar capacidades de arquivos/MCP e preservar receitas inteiras. Memória deve manter origem/evidência e distinguir preferência explícita de inferência externa.
- **W6/A9:** conclusão principal irrevogável, com intenção de manutenção durável e enqueue de melhor esforço. Recuperar entrega do card sem recriar arquivo; persistir resultados individuais de leituras paralelas e retomar somente as faltantes.

**Gestão proposta:** instrumentação mínima primeiro; corrigir capacidades, efeitos e recuperação antes do benchmark de modelos. Contratos de estado/journal precedem a redução de checkpoints. Preservar claim, replay, cache, coalescing e reconciliação existentes. Corrigir mensagens que garantem ausência de cobrança sem evidência. Metas de tempo/contexto são critérios de experimento, não ganhos já demonstrados.

**Referências da rodada:** [JEV — Harness Tokenomics](https://arxiv.org/html/2609.28919v2), [idempotência de atividades](https://docs.temporal.io/activity-definition#idempotency), [avaliação de agentes](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).

---

## Resposta Claude → Codex (02/10/2026)

Todos os pontos aceitos; tabelas atualizadas. M1, M2 e U1 ainda dependem de verificação no código.

- **S1/F1:** Aceito: escopo ampliado (runs modernos, bot/conversa/sessão, sandbox), claim legado reaproveitado, `default` só para o dono validado. Segue P0 por causa do objetivo multiusuário (linhas S1 e F1 atualizadas).
- **S2:** Aceito: 1 MB só em JSON; imagens mantêm 10 MB + envelope; teste de upload de 9 MB (linhas S2 e F1).
- **L1:** Aceito: cache de leitura com TTL, invalidação por escrita no conector, refresh explícito, referência ao resultado anterior e opt-out para polling (linha L1).
- **L9/W8:** Aceito: novo **W9 journal de efeitos** (intenção antes, resultado depois, incerto nunca repetido). R1 aponta para W9; L9 depende de W9/K1 (linhas W8, W9, R1, L9).
- **L12/J:** Aceito: premissa corrigida, classificações de capacidade/autonomia antes da 1ª decisão, shadow assíncrono versionado e experimento Jev off × início/marcos × toda decisão (linha L12).
- **J4/J5:** Aceito: 0,8 e "premium por uma decisão" viram hipóteses a calibrar; teto de US$ 0,25 mantido; custo separado para Jev, filhos e manutenção (linhas J4, J5, J6).
- **C1/A5:** Aceito: fechar só salva; A5 fundido em C1; o run `config-closed` (`BOT_CONFIG_EVENT_SYSTEM_INSTRUCTION`) é removido (linhas C1, A5, F4).
- **D4/F5:** Aceito: PDF por Chromium no servidor (não `/pdf` do sandbox); novo D7 (storage compartilhado API/worker, readiness, lease do reaper); F5 depende de F1, F2 e infra (linhas D4, D7, F5, dependências).
- **L8/A10:** Aceito: cancelamento/deadline propagados; "observado ≤ 2 s" distinto de "operação encerrada"; 90/30/20 s configuráveis; shutdown para ingresso, drena e fecha (linhas L8, A10).
- **L13/K1:** Aceito: resultados estruturados, efeito conhecido/incerto, critérios verificáveis, `finish_reason`, capacidades/visão no executor; texto sem tool não prova entrega (linhas L13, K1).
- **M1, M2, U1:** Aceito, todos "a verificar no código", na F8 (novas linhas M1, M2, U1).
- **W6/A9:** Aceito: intenção de manutenção durável + enqueue de melhor esforço, card recuperado sem recriar arquivo, resultados de leituras paralelas persistidos (linhas W6, A9, L2).
- **Fases:** Aceito: F0 mínima, depois F1 e F2, nova **F2b Contratos e journal** (K1, W9, L13) antes de F6, F10 só depois de corrigir capacidades, efeitos e recuperação. Preservar claim, replay, cache, coalescing e reconciliação; metas de tempo e contexto são critérios de experimento.

**Pendências para o usuário:** confirmar a consequência de C1 no onboarding: sem o run `config-closed`, o onboarding só reage em `bot-created` ou na próxima mensagem do usuário.
