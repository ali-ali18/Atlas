# Cache de build no deploy (Dokploy + BuildKit)

## O que fica em cache

- `api`, `worker`, `migrate` (`docker/node-service.Dockerfile`): estágio `deps` depende só de
  `package.json`/`pnpm-lock.yaml`/`pnpm-workspace.yaml`/`.npmrc`. `pnpm install` roda **uma vez por
  mudança de lockfile/manifest** e é compartilhado pelos três (alvo `migrate` = `--target migrate`).
  Mudança só de código => reaproveita deps, roda apenas `pnpm build` (tsc/prisma generate).
- `web` (`docker/web/Dockerfile`): mesma lógica; só `next build` roda em mudança de código.
- `agent-sandbox` (`docker/agent-sandbox`): contexto próprio; apt/Chrome/VS Code primeiro, scripts
  (`bin`, `desktop`, `plank`, `control`, `entrypoint.sh`) por último. Só reconstrói o pesado se o
  Dockerfile mudar ou o cache for apagado.
- O store do pnpm fica no cache mount `atlas-pnpm-store` (sobrevive entre builds, mas é apagado por
  `docker builder prune`). Se o lockfile mudar, só os pacotes novos são baixados.

## Limpeza de disco que preserva o cache

```sh
# imagens sem tag (sobras de builds antigos); não toca no cache de build
docker image prune -f
# cache de build: apaga só o que não é usado há 7 dias
docker builder prune -f --filter "until=168h"
# alternativa: limite por tamanho (mantém o mais recente)
docker builder prune -f --keep-storage 15GB
```

Evite `docker system prune -a`, `docker builder prune -a` sem filtro e `docker image prune -a`:
apagam o cache e forçam rebuild completo (pnpm install de tudo, apt do sandbox, next build).

## Dokploy

A limpeza diária do Dokploy (Settings > Server > Daily Docker Cleanup / "Clean Cache") executa
`docker builder prune` completo: com ela ligada, todo deploy no dia seguinte recompila do zero.
Desligue-a (ou o item de limpar build cache) e use um cron no servidor com os comandos acima:

```cron
0 4 * * * docker image prune -f && docker builder prune -f --keep-storage 15GB
```

Não há opção por compose para preservar o cache; é configuração do servidor. Não use
"Clean Cache" manual nem `--no-cache` no deploy, a menos que queira rebuild total.
