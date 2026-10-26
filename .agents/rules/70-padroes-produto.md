# Padrões de produto e arquitetura (decisões já tomadas)

Decisões que o dono do projeto já fez. Siga sem perguntar de novo; só proponha mudar com motivo forte.

## Bot autônomo e agent-first
- Tudo o que o usuário faz pela UI, o bot faz pelo chat (criar, editar, pausar, apagar, listar, mover de grupo, compartilhar). Feature nova sem tool equivalente está incompleta.
- Quanto mais autônomo, melhor: follow-up/conferência inferida da conversa é agendada **em silêncio** (sem card, sem botão de cancelar, sem anunciar). Volta só com novidade; sem novidade, não posta nada.
- Exceções que sempre pedem o usuário: escrita em conector com `confirmWrites`, link público, dado sensível. O resto o bot decide.
- Reaproveite o que existe antes de criar sistema paralelo: rotinas (cron/interval/once/event), follow-ups proativos, grupos de rotina (valem também para painéis), cards persistidos.

## Custo e contexto
- **Só entra no contexto se for usar**: schema detalhado, instruções e tools de uma feature ficam num grupo/skill lazy (`native-tools.ts`, `intent-router.ts`), carregado pela intenção ou a pedido do modelo. A descrição sempre carregada fica curta.
- Toda feature que adiciona prompt ou tool protege isso com teste: "Bom dia" continua pequeno (`computer-use.economy-replay.test.ts`) e o pedido da feature carrega o grupo no passo 1.
- Nada de polling caro com o modelo: alertas/rotinas de conferência têm intervalo mínimo (2h salvo pedido explícito), horários úteis e espaçamento quando nada muda.

## Linguagem com o usuário
- O bot nunca expõe internals: nomes de tool, campo, tipo, id de paleta, número de revisão, "a ferramenta recusou". Diz em palavras simples o que fez ou o que não dá, e oferece alternativa.
- Nomes de produto: **Painel/Painéis** (nunca "página" para o usuário), **Gráfico** (o solto no chat), **Rotina**, **Alerta**, **Biblioteca**. Paletas pelo nome de exibição (Bosque, Oceano…), descritas pela cor.
- Tool honesta: campo desconhecido ou valor inválido **falha** com a lista do que é aceito; nunca descarte em silêncio e responda como se tivesse feito.

## Chat e streaming
- Revisão da resposta não aparece na conversa: o rascunho revisado fica salvo, mas o chat mostra só a resposta final (decisão do dono, 24/10). Compactação aparece só como marcador "Conversa compactada · antes → depois", sem abrir o resumo.
- Card tem identidade estável entre ao vivo e persistido (ex.: `routineId`, `chartId`, `pageId` + run); o merge nunca mostra os dois.
- Portões que fazem o modelo refazer a resposta revisam no máximo uma vez por run.

## UI
- Ação destrutiva (lixeira) aparece só no hover/foco (`[@media(hover:hover)]`) e por pressão longa no toque.
- Hover cobre o card inteiro. Grupos de botões usam `ButtonGroup` do `packages/ui` (as pontas contam só filhos com `data-slot`).
- Desktop e celular são desenhados separadamente quando o padrão de um não serve no outro (ex.: menu "+" compacto no desktop, gaveta no celular).
- Seções da Biblioteca recolhíveis; listas relacionadas agrupadas (painéis e rotinas pelo mesmo grupo).

## Fluxo de trabalho
- Processo, prévias, merge só com ok do dono, subagentes, um processo pesado por vez e ideias fora do escopo (issue no GitHub): ver `80-fluxo-de-trabalho.md`.
