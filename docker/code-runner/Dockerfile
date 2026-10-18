# Executor leve de Python (ferramenta `run_code`): sem desktop, sem navegador.
# Containers efêmeros por execução (rede none, rootfs somente leitura, volume tmpfs em /work).
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MPLBACKEND=Agg \
    MPLCONFIGDIR=/tmp/mpl \
    HOME=/tmp

RUN pip install pandas numpy scipy matplotlib openpyxl

# uid fixo: o servidor grava os arquivos de entrada com este dono (putArchive) e o tmpfs /work usa o mesmo uid.
RUN groupadd --gid 10001 runner \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin runner \
 && mkdir -p /app /work \
 && chown runner:runner /work

COPY run.py /app/run.py

USER 10001:10001
WORKDIR /work
CMD ["python", "/app/run.py"]
