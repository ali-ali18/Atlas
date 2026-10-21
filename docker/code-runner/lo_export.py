"""Converte um documento com o LibreOffice via UNO, atualizando sumarios/indices antes de salvar.

Rodar com o python do sistema (`/usr/bin/python3`, pacote python3-uno), nao com o python do venv:
    /usr/bin/python3 /app/lo_export.py entrada.docx saida.pdf      (ou saida.docx)
O `soffice --convert-to` simples nao atualiza o sumario; por isso o doclib usa este script primeiro.
"""
import os
import subprocess
import sys
import time

import uno
from com.sun.star.beans import PropertyValue

FILTERS = {".pdf": "writer_pdf_Export", ".docx": "MS Word 2007 XML"}


def prop(name, value):
    p = PropertyValue()
    p.Name, p.Value = name, value
    return p


def main(src, dst):
    ext = os.path.splitext(dst)[1].lower()
    pipe = "doclib%d" % os.getpid()
    proc = subprocess.Popen(
        ["soffice", "--headless", "--invisible", "--norestore", "--nologo",
         "-env:UserInstallation=file:///tmp/lo", "--accept=pipe,name=%s;urp;" % pipe],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        local = uno.getComponentContext()
        resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
        remote = None
        for _ in range(240):
            try:
                remote = resolver.resolve("uno:pipe,name=%s;urp;StarOffice.ComponentContext" % pipe)
                break
            except Exception:
                time.sleep(0.5)
        if remote is None:
            raise RuntimeError("LibreOffice nao respondeu")
        desktop = remote.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", remote)
        doc = desktop.loadComponentFromURL(uno.systemPathToFileUrl(os.path.abspath(src)), "_blank", 0, (prop("Hidden", True),))
        for _ in range(2):  # 2 passadas: o numero de paginas do sumario pode mover o resto
            indexes = doc.getDocumentIndexes()
            for i in range(indexes.getCount()):
                indexes.getByIndex(i).update()
            doc.refresh()
        doc.storeToURL(uno.systemPathToFileUrl(os.path.abspath(dst)), (prop("FilterName", FILTERS[ext]),))
        doc.close(True)
        try:
            desktop.terminate()
        except Exception:
            pass
    finally:
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
