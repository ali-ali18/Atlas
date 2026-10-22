# Code runner (ferramenta `run_code`)

Imagem para o agente executar Python (contas, CSV/planilhas, gráficos) e **gerar documentos finais** sem ligar a VM:
`python:3.12-slim-bookworm` + pandas, numpy, scipy, matplotlib (Agg), openpyxl, python-docx, docxtpl, python-pptx, pypdf,
pdfplumber, pandoc, LibreOffice headless (Writer/Calc/Impress, DOCX/XLSX/PPTX → PDF), poppler (`pdftoppm`),
TeX Live com abnTeX2 (`latexmk`) e fontes livres (Liberation, Carlito, Caladea, DejaVu). Sem navegador nem desktop.
Tamanho esperado: ~2,3–2,8 GB (não medido: a imagem ainda não foi construída). Cai o tamanho ~150 MB tirando
`libreoffice-calc`/`libreoffice-impress` se só Word/PDF importarem.
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

## Documentos (`/app`)

- `doclib.py`: `md_to_docx_abnt`, `docx_to_pdf`, `pdf_to_pngs`, `latex_abnt`, `fill_template`, `docx_add_toc`
  (uso: `sys.path.insert(0, "/app"); import doclib`). `lo_export.py` atualiza o sumário via UNO antes de exportar o PDF.
- `templates/abnt/`: `abnt-reference.docx` (gerado no build por `build_reference.py`), `abnt-trabalho.tex`,
  `abnt-projeto.tex`, `latexmkrc`, `referencias.bib`.
- Páginas para conferência: PNGs salvos em `/work/preview/` (até 12 por chamada) voltam ao modelo como imagens e não
  são entregues ao usuário; só `/work/out/` vira arquivo/cartão.
- Variáveis para rootfs somente leitura: `HOME=/tmp`, `TEXMFVAR`/`TEXMFCACHE=/tmp/texmf-var`; LibreOffice usa
  `-env:UserInstallation=file:///tmp/lo`.

## Teste de fumaça da imagem (após o build)

```bash
docker run --rm --network none --read-only --user 10001:10001   --tmpfs /tmp:size=128m,mode=1777 --tmpfs /work:size=160m,uid=10001,gid=10001   atlas-code-runner:latest python /app/smoke.py
```

Testes sem binários pesados (rodam fora da imagem, precisam de python-docx): `python -m unittest docker/code-runner/test_doclib.py`.

## Teste de fumaça local (bibliotecas)

```bash
docker run --rm --network none --read-only --tmpfs /tmp atlas-code-runner:latest \
  python -c "import pandas, numpy, scipy, matplotlib, openpyxl; print('ok')"
```
