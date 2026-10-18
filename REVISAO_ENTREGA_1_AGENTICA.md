# Direcionamento de correção — Entrega 1 da arquitetura agêntica

Este documento deve ser usado como instrução de implementação para corrigir e concluir a **Entrega 1 — Runs duráveis e F5 seguro** descrita em `PLANO_ARQUITETURA_AGENTICA.md`.

O arquivo `PROGRESSO_ARQUITETURA_AGENTICA.md` atualmente classifica a Entrega 1 como **Feita (código)**. Essa classificação está incorreta. A infraestrutura inicial existe e o projeto passa no typecheck, mas ainda faltam requisitos essenciais de retomada, idempotência, retry, reconexão e entrada de mensagens durante a execução.

## Objetivo desta correção

Ao final, um `AgentRun` deve:

- continuar no worker mesmo que o navegador seja atualizado ou fechado;
- sobreviver à reinicialização da API e do worker;
- retomar do último checkpoint confirmado sem repetir ferramentas já concluídas;
- impedir dois workers de executarem simultaneamente o mesmo run;
- permitir que o usuário envie novas mensagens enquanto o agente trabalha;
- recuperar a transmissão de eventos sem duplicar ou perder conteúdo;
- cancelar de maneira cooperativa e previsível;
- continuar usando a memória global do usuário e a memória privada do agente;
- atualizar automaticamente a memória após a conclusão do run;
- possuir testes de integração que comprovem esses comportamentos.

## Estado encontrado

### O que já existe

- modelos `AgentRun`, `AgentStep`, `RunEvent` e `Artifact`;
- pacote `packages/agent-runtime` com o loop de ferramentas;
- fila BullMQ exclusiva para runs;
- worker com lease e heartbeat básicos;
- API para criar, consultar, cancelar e acompanhar runs;
- eventos persistidos no Postgres;
- stream SSE com parâmetro `after`;
- armazenamento do `runId` no frontend;
- carregamento de memória usando `botId`;
- checkpoint Git `976dbdc` na branch `checkpoint/agentic-baseline`.

### Status correto antes das correções

| Etapa | Status correto |
|---|---|
| 1.1 Estruturas de banco | Parcial — falta `RunInput` |
| 1.2 Runtime extraído | Feito |
| 1.3 Fila, lease e heartbeat | Parcial |
| 1.4 API de runs | Parcial |
| 1.5 Eventos persistidos e SSE | Parcial |
| 1.6 Reconexão depois de F5 | Parcial e sem teste de aceite |
| 1.7 Cancelamento e retry seguro | Não concluído |
| 1.8 Mensagens durante o run | Não implementado |

## P0 — Correções obrigatórias

### 1. Persistir o estado real do loop agêntico

O runtime mantém uma lista interna `conversation` com:

- mensagens enviadas ao modelo;
- resposta do modelo e `tool_calls`;
- resultados das ferramentas;
- screenshots e demais mensagens multimodais.

O checkpoint atual salva apenas as mensagens originais recebidas pelo run. O campo `llmMessages` existe no tipo, mas não é preenchido. O campo `nextStepIndex` é salvo, porém o loop sempre recomeça em zero.

Implementar:

1. um tipo serializável e validado para o estado do runtime;
2. persistência da conversa interna completa após cada passo confirmado;
3. persistência de `nextStepIndex`, modelo efetivamente usado, sandbox e metadados necessários;
4. inicialização do runtime a partir desse checkpoint;
5. continuação do loop a partir do próximo passo, sem reiniciar em zero;
6. versionamento do formato do checkpoint para permitir futuras migrações;
7. gravação atômica do checkpoint com os passos e inputs consumidos.

Não salvar imagens grandes como Data URL diretamente no JSON do run. Transformar screenshots necessárias em artefatos persistentes e guardar uma referência no checkpoint.

### 2. Gravar cada decisão e ferramenta como `AgentStep`

Hoje `AgentStep` é usado praticamente apenas para registrar um checkpoint. Isso não permite retomar ferramentas individualmente nem aplicar idempotência.

Implementar registros distintos para:

- decisão/chamada do modelo;
- cada chamada de ferramenta;
- resultado da ferramenta;
- checkpoint;
- aprovação, quando aplicável futuramente.

Cada ferramenta precisa ter uma identidade estável derivada, por exemplo, de:

`runId + índice da decisão + toolCallId + nome da ferramenta`

Rever `@@unique([runId, index])`, pois uma decisão pode conter várias ferramentas. Usar um índice/subíndice ou outra chave que permita representar todos os passos sem colisão.

### 3. Implementar idempotência de ferramentas

Antes de executar uma ferramenta:

1. calcular sua `idempotencyKey`;
2. consultar se existe um passo concluído com essa chave;
3. se existir, reutilizar o resultado persistido;
4. se não existir, marcar o passo como `running` e executar;
5. persistir o resultado antes de avançar o checkpoint.

Ferramentas com efeitos externos precisam receber a chave de idempotência quando a integração oferecer suporte. Para ações de navegador que não sejam naturalmente idempotentes, salvar evidências e implementar uma verificação antes de repetir a ação.

O sistema deve priorizar **não repetir um efeito externo** após um crash.

### 4. Corrigir o retry do BullMQ

A fila configura múltiplas tentativas, mas o processor captura erros e retorna um resultado `failed`. Isso faz o BullMQ considerar o job concluído e impede o retry.

Implementar classificação de erros:

- transitório: liberar ou expirar o lease corretamente e lançar o erro para o BullMQ tentar novamente;
- permanente: finalizar o run como `failed` sem nova tentativa;
- cancelamento: finalizar como `cancelled`;
- intervenção necessária: mudar para `waiting_user`;
- orçamento esgotado: mudar para `budget_exhausted`.

O evento de erro terminal deve ser emitido somente quando a política de retry estiver esgotada ou quando o erro for permanente. Uma tentativa transitória não pode produzir uma falsa falha definitiva na interface.

### 5. Fortalecer lease e heartbeat

O worker atual continua executando mesmo quando a renovação do lease falha. Um segundo worker pode adquirir o run enquanto o primeiro ainda executa ferramentas.

Implementar:

- `leaseToken` ou número monotônico de geração;
- verificação de proprietário e token ao renovar o lease;
- interrupção do executor quando a renovação falhar;
- verificação do token ao salvar checkpoint, registrar passo e finalizar o run;
- impossibilidade de um worker antigo sobrescrever o estado de um worker novo;
- tempo de lease e política de retry compatíveis entre si;
- liberação segura do lease em estados terminais.

### 6. Implementar `RunInput` e manter o composer habilitado

Criar o modelo `RunInput` previsto no plano, contendo pelo menos:

- `id`;
- `runId`;
- sequência monotônica;
- autor;
- conteúdo;
- modo `steer`, `queue` ou `cancel`;
- status `pending`, `consumed` ou `superseded`;
- timestamps de criação e consumo.

Implementar endpoints para criar e consultar inputs do run.

Comportamento esperado:

- o composer permanece habilitado enquanto o agente trabalha;
- enviar uma mensagem durante o run cria `RunInput(mode=steer)` por padrão;
- o runtime lê inputs pendentes antes da próxima decisão do modelo;
- os inputs incorporados são marcados como `consumed` na mesma transação do checkpoint;
- `queue` cria o próximo objetivo somente depois que o run atual termina;
- uma mensagem nova não cria silenciosamente um segundo run concorrente;
- o texto digitado deve permanecer como rascunho por conversa durante F5;
- a interface deve mostrar se a mensagem foi enviada ao run atual ou colocada na fila.

Remover as duas barreiras atuais:

- `disabled={sending}` no composer;
- `if (!trimmed || sending) return` no hook.

Não remova essas barreiras sem implementar primeiro o protocolo persistente de `RunInput`.

### 7. Tornar a reconexão SSE realmente retomável

O servidor já possui sequência de eventos e suporta `after`, mas o cliente ignora o campo SSE `id` e não persiste o último cursor.

Implementar:

- parsing do campo `id:` de cada evento SSE;
- cursor do último evento aplicado por `runId`;
- persistência do cursor no cliente;
- reconexão automática com backoff usando `after`/`Last-Event-ID`;
- deduplicação de eventos já aplicados;
- consulta do status do run quando o stream terminar inesperadamente;
- remoção do `runId` local somente após confirmar estado terminal;
- reconstrução determinística da interface depois de F5;
- tratamento de mais de um run ativo sem esconder execuções.

O stream é apenas uma projeção dos eventos persistidos. O término da conexão HTTP não deve alterar o estado do run.

### 8. Corrigir persistência e enfileiramento

Atualmente o run é criado no Postgres e depois enfileirado no Redis. Uma falha entre as duas operações pode deixar um run eternamente como `queued`.

Implementar uma destas estratégias:

- outbox transacional no Postgres com dispatcher; ou
- reconciliador periódico de runs `queued` sem job correspondente.

A mensagem do usuário e a criação do run também devem ter uma garantia consistente. Não ocultar falhas de persistência com apenas `console.error` quando a informação for necessária para continuar depois de F5.

### 9. Corrigir o cancelamento

O cancelamento precisa ser verificado:

- antes de chamar o modelo;
- antes de cada ferramenta;
- depois de cada ferramenta;
- antes de salvar e iniciar o próximo passo;
- durante operações longas, quando a ferramenta aceitar `AbortSignal`.

Não usar um evento genérico de erro para cancelamento. Criar um evento/status coerente para a interface.

Se a chamada de cancelamento falhar no frontend, não apagar o `runId` local nem afirmar que o run parou.

### 10. Preservar a memória de cada agente

O comportamento necessário é:

- `target=user`: perfil global compartilhado pelo usuário;
- `target=memory` e `botId`: memória privada do agente;
- o run deve carregar ambas antes da inferência;
- alterações devem ser gravadas usando o mesmo `userId` e `botId` do run;
- ao terminar com sucesso, o run deve enfileirar a revisão automática de memória;
- a revisão automática não deve duplicar entradas já criadas explicitamente pelo agente;
- retry do run ou do revisor não pode duplicar fatos.

O fluxo de `AgentRun` atualmente carrega a memória, mas não agenda a revisão automática executada pelo chat comum. Restaurar essa etapa.

Enquanto não houver autenticação real, documentar que `userId="default"` serve apenas ao ambiente local. Não apresentar esse isolamento como multiusuário.

## P1 — Correções adicionais desta entrega

### API de listagem

O endpoint de runs de uma conversa chama `listActiveRunsForConversation` tanto com `active=1` quanto com `active=0`. Corrigir o contrato ou remover o parâmetro enganoso.

### Validação de entrada

- validar os papéis permitidos das mensagens;
- rejeitar payload inválido em vez de filtrar silenciosamente;
- validar a existência e relação de `conversationId`, `botId` e sandbox;
- preparar a autorização por usuário, mesmo que a autenticação real pertença à Entrega 7.

### Finalização atômica

A persistência da resposta do assistente, o evento final e a transição do run para `completed` devem formar uma operação consistente. Uma falha intermediária não pode mostrar `done` e depois executar novamente todo o objetivo.

## Testes obrigatórios

Adicionar testes automatizados relevantes. O typecheck isolado não é critério de aceite.

### Persistência e retomada

- interromper o worker depois de uma ferramenta e verificar retomada no próximo passo;
- provar que a ferramenta concluída não é executada novamente;
- reiniciar a API sem interromper o worker;
- reiniciar o worker e recuperar o run pelo checkpoint;
- simular falha de Redis após criar o run e confirmar recuperação pelo outbox/reconciliador.

### Lease

- dois workers disputam o mesmo run e apenas um executa;
- worker perde o lease e para antes de executar outra ferramenta;
- worker antigo não consegue salvar nem finalizar depois que outro adquiriu o run.

### SSE e F5

- desconectar depois do evento N e reconectar com `after=N`;
- comprovar ausência de eventos duplicados;
- dar F5 durante ferramenta longa e recuperar o mesmo run;
- derrubar temporariamente a conexão e acompanhar o resultado após reconexão;
- confirmar que o cliente não limpa um run ainda ativo.

### Mensagens durante a execução

- enviar `steer` enquanto uma ferramenta está ativa;
- consumir o input antes da próxima decisão;
- enviar vários inputs e preservar a ordem;
- enviar `queue` e iniciar o próximo objetivo somente após o término;
- atualizar a página e preservar inputs pendentes e rascunho.

### Cancelamento e retry

- cancelar run enfileirado;
- cancelar entre duas ferramentas;
- cancelar durante ferramenta que aceita abort;
- erro transitório gera retry real do BullMQ;
- erro permanente não gera retry;
- retry não duplica ferramenta nem mensagem final.

### Memória

- dois agentes do mesmo usuário recebem o perfil global;
- cada agente recebe somente sua memória privada;
- conclusão do run agenda revisão automática;
- retry da revisão não duplica fatos.

## Critério final de aceite

A Entrega 1 só pode voltar para **Feita** quando todos estes itens forem comprovados:

- [ ] checkpoint restaura o estado interno completo do loop;
- [ ] worker continua do próximo passo confirmado;
- [ ] ferramentas concluídas não são repetidas após crash;
- [ ] erros transitórios acionam retry real;
- [ ] lease perdido interrompe o worker antigo;
- [ ] F5 recupera o mesmo run e o mesmo progresso;
- [ ] queda temporária do SSE reconecta pelo último cursor;
- [ ] composer funciona durante o run com `steer` e `queue`;
- [ ] cancelamento funciona nos pontos seguros;
- [ ] memória global e memória privada do agente continuam isoladas;
- [ ] revisão automática de memória ocorre após o run;
- [ ] não existem runs `queued` abandonados por falha de enfileiramento;
- [ ] testes automatizados cobrem retomada, idempotência, lease, SSE e inputs;
- [ ] teste manual com reinício de API e worker foi registrado;
- [ ] `pnpm typecheck` passa;
- [ ] `pnpm lint` não introduz novos avisos ou erros.

## Atualização do relatório de progresso

Antes de implementar, alterar a Entrega 1 em `PROGRESSO_ARQUITETURA_AGENTICA.md` para **Parcial**.

Depois da implementação:

1. registrar cada mudança feita;
2. listar migrations e endpoints adicionados;
3. registrar os testes executados e seus resultados;
4. deixar explícito o que ainda não foi validado manualmente;
5. marcar uma etapa como `Feito` somente quando o respectivo critério de aceite estiver comprovado;
6. não iniciar a Entrega 2 enquanto os itens P0 acima permanecerem abertos.

## Restrições de execução

- preservar todas as mudanças locais existentes;
- não usar `git reset`, checkout destrutivo ou limpeza do working tree;
- não alterar a interface visual fora do necessário para `RunInput`, status e reconexão;
- manter compatibilidade com OpenRouter e com o modelo configurado pelo agente;
- não resolver retomada apenas aumentando `maxSteps`;
- não usar memória como substituto do checkpoint operacional;
- executar e registrar migration, typecheck, lint e testes de integração;
- seguir as instruções de `AGENTS.md` e consultar a documentação instalada do Next.js antes de alterar código Next.js.

