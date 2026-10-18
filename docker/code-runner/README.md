# Code runner (ferramenta `run_code`)

Imagem mínima para o agente executar Python leve (contas, CSV/planilhas, gráficos) **sem ligar a VM**:
`python:3.12-slim` + pandas, numpy, scipy, matplotlib (backend Agg), openpyxl. Sem navegador nem desktop.
Não é um serviço: cada execução cria um container efêmero (`packages/sandbox/src/code-runner/`).

## Build

```bash
docker build -t atlas-code-runner:latest docker/code-runner
# ou, pelo compose (container sai na hora; só a imagem importa):
docker compose build code-runner
```

No servidor (Dokploy) o serviço `code-runner` do `docker-compose.yml` constrói `atlas-code-runner:latest`
junto com as outras imagens. A api/worker usam `CODE_RUNNER_IMAGE` (padrão `atlas-code-runner:latest`).

## Isolamento por execução

Rede `none`, 512 MB (sem swap), 1 CPU, pids limitados, rootfs somente leitura; `/tmp` em tmpfs e `/work` em volume anônimo tmpfs de 160 MB (removido com o container; precisa ser volume porque `putArchive` não enxerga um tmpfs comum),
`CapDrop ALL`, `no-new-privileges`, `AutoRemove`, usuário não-root (uid 10001), timeout 60s (máx. 120s).
Labels `atlas.code-runner=1` (o reaper remove órfãos).

## Protocolo

Entrada: o servidor sobe o container, grava `/work/main.py` e `/work/in/*` por `putArchive` e depois `/work/.go`.
`/app/run.py` executa o código, grava `/work/.result.json`, imprime `__ATLAS_CODE_RUN_DONE__` e aguarda.
Saída: o servidor lê `/work/.result.json` e `/work/out/*` por `getArchive` e remove o container.
O código do usuário lê entradas em `in/` e salva resultados em `/work/out/` (ex.: `plt.savefig("/work/out/grafico.png")`).

## Teste de fumaça local

```bash
docker run --rm --network none --read-only --tmpfs /tmp atlas-code-runner:latest \
  python -c "import pandas, numpy, scipy, matplotlib, openpyxl; print('ok')"
```
