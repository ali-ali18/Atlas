# Executor de Python (ferramenta `run_code`): calculos, planilhas, graficos e DOCUMENTOS (Word/PDF/slides/LaTeX),
# sem desktop e sem navegador. Containers efemeros por execucao (rede none, rootfs somente leitura, tmpfs em /work e /tmp).
# Base fixada em bookworm: os nomes/versoes dos pacotes Debian abaixo (pandoc 2.17, LibreOffice 7.4, TeX Live 2022,
# abnTeX2 em texlive-publishers) dependem dela. Tamanho esperado: ~2,3-2,8 GB (TeX Live + LibreOffice dominam).
FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1     PYTHONUNBUFFERED=1     PIP_NO_CACHE_DIR=1     PIP_DISABLE_PIP_VERSION_CHECK=1     DEBIAN_FRONTEND=noninteractive     LANG=C.UTF-8     MPLBACKEND=Agg     MPLCONFIGDIR=/tmp/mpl     HOME=/tmp     TEXMFVAR=/tmp/texmf-var     TEXMFCACHE=/tmp/texmf-var     TEXMFCONFIG=/tmp/texmf-config     DOCLIB_TEMPLATES=/app/templates/abnt

# Documentos: pandoc (md -> docx), LibreOffice headless (docx/xlsx/pptx -> pdf; python3-uno atualiza o sumario),
# poppler (pdftoppm), TeX Live minimo para abnTeX2 offline (memoir/natbib/etc. vem de latex-extra/recommended),
# fontes livres metricamente compativeis com Times/Arial/Calibri/Cambria (sem fontes proprietarias).
RUN apt-get update  && apt-get install -y --no-install-recommends       pandoc       libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress python3-uno       poppler-utils       latexmk perl texlive-latex-base texlive-latex-recommended texlive-latex-extra texlive-publishers       texlive-lang-portuguese texlive-fonts-recommended lmodern       fontconfig fonts-liberation fonts-crosextra-carlito fonts-crosextra-caladea fonts-dejavu-core  && fc-cache -f  && rm -rf /var/lib/apt/lists/* /usr/share/man /usr/share/info  && (find /usr/share/doc -type f ! -name copyright -delete 2>/dev/null || true)

RUN pip install       pandas==2.2.3 numpy==2.1.3 scipy==1.14.1 matplotlib==3.9.2 openpyxl==3.1.5       python-docx==1.1.2 docxtpl==0.19.0 python-pptx==1.0.2 pypdf==5.1.0 pdfplumber==0.11.4

# uid fixo: o servidor grava os arquivos de entrada com este dono (putArchive) e o tmpfs /work usa o mesmo uid.
RUN groupadd --gid 10001 runner  && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin runner  && mkdir -p /app /work  && chown runner:runner /work

COPY run.py doclib.py lo_export.py build_reference.py smoke.py /app/
COPY templates /app/templates
# Documento de referencia ABNT do pandoc: gerado no build (nada de binario no repositorio).
RUN python /app/build_reference.py /app/templates/abnt/abnt-reference.docx  && chmod -R a+rX /app

USER 10001:10001
WORKDIR /work
CMD ["python", "/app/run.py"]
