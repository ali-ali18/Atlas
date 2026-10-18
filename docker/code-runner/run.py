"""Runner do `run_code`.

Protocolo com o servidor (containers com rootfs somente leitura e /work em tmpfs, então o
servidor só consegue gravar em /work depois que o container iniciou):

1. espera o arquivo /work/.go (o servidor grava /work/main.py e /work/in/* antes dele);
2. executa /work/main.py com timeout (CODE_TIMEOUT_SEC), stdout/stderr em arquivos;
3. grava /work/.result.json, imprime o marcador e fica parado até o servidor ler /work/out
   e remover o container (AutoRemove). Sem o servidor, sai sozinho depois de um tempo.
"""
import json
import os
import signal
import subprocess
import sys
import time

WORK = "/work"
MARKER = "__ATLAS_CODE_RUN_DONE__"
STREAM_CAP = 200_000
GO_WAIT_SEC = 30
LINGER_SEC = 120


def read_capped(path: str) -> str:
    try:
        with open(path, "rb") as fh:
            data = fh.read(STREAM_CAP * 4 + 1)
    except OSError:
        return ""
    text = data.decode("utf-8", errors="replace")
    if len(text) > STREAM_CAP:
        head = text[: STREAM_CAP // 2]
        tail = text[-STREAM_CAP // 2 :]
        text = head + "\n[... saída cortada ...]\n" + tail
    return text


def main() -> int:
    waited = 0.0
    while not os.path.exists(os.path.join(WORK, ".go")):
        time.sleep(0.05)
        waited += 0.05
        if waited > GO_WAIT_SEC:
            return 3
    timeout = float(os.environ.get("CODE_TIMEOUT_SEC", "60"))
    os.makedirs(os.path.join(WORK, "out"), exist_ok=True)
    out_path, err_path = "/tmp/stdout.txt", "/tmp/stderr.txt"
    started = time.time()
    timed_out = False
    with open(out_path, "wb") as out, open(err_path, "wb") as err:
        proc = subprocess.Popen(
            [sys.executable, os.path.join(WORK, "main.py")],
            cwd=WORK,
            stdin=subprocess.DEVNULL,
            stdout=out,
            stderr=err,
            start_new_session=True,
        )
        try:
            code = proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                proc.kill()
            proc.wait()
            code = None
    result = {
        "exit_code": code,
        "timed_out": timed_out,
        "duration_ms": int((time.time() - started) * 1000),
        "stdout": read_capped(out_path),
        "stderr": read_capped(err_path),
    }
    with open(os.path.join(WORK, ".result.json.tmp"), "w", encoding="utf-8") as fh:
        json.dump(result, fh)
    os.replace(os.path.join(WORK, ".result.json.tmp"), os.path.join(WORK, ".result.json"))
    print(MARKER, flush=True)
    time.sleep(LINGER_SEC)
    return 0


if __name__ == "__main__":
    sys.exit(main())
