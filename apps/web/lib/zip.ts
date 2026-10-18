/**
 * ZIP mínimo (método "stored", sem compressão) para baixar o pacote de uma skill.
 * Sem dependências; nomes em UTF-8.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export function createZip(files: ReadonlyArray<{ path: string; content: string }>): Uint8Array {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  const u16 = (view: DataView, at: number, value: number) => view.setUint16(at, value, true)
  const u32 = (view: DataView, at: number, value: number) => view.setUint32(at, value >>> 0, true)

  for (const file of files) {
    const name = encoder.encode(file.path)
    const data = encoder.encode(file.content)
    const crc = crc32(data)

    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    u32(lv, 0, 0x04034b50)
    u16(lv, 4, 20)
    u16(lv, 6, 0x0800) // nomes em UTF-8
    u16(lv, 8, 0) // stored
    u16(lv, 10, 0)
    u16(lv, 12, 0x21) // 1980-01-01
    u32(lv, 14, crc)
    u32(lv, 18, data.length)
    u32(lv, 22, data.length)
    u16(lv, 26, name.length)
    u16(lv, 28, 0)
    local.set(name, 30)

    const entry = new Uint8Array(46 + name.length)
    const ev = new DataView(entry.buffer)
    u32(ev, 0, 0x02014b50)
    u16(ev, 4, 20)
    u16(ev, 6, 20)
    u16(ev, 8, 0x0800)
    u16(ev, 10, 0)
    u16(ev, 12, 0)
    u16(ev, 14, 0x21)
    u32(ev, 16, crc)
    u32(ev, 20, data.length)
    u32(ev, 24, data.length)
    u16(ev, 28, name.length)
    u32(ev, 42, offset)
    entry.set(name, 46)

    chunks.push(local, data)
    central.push(entry)
    offset += local.length + data.length
  }

  const centralSize = central.reduce((sum, item) => sum + item.length, 0)
  const end = new Uint8Array(22)
  const dv = new DataView(end.buffer)
  u32(dv, 0, 0x06054b50)
  u16(dv, 8, files.length)
  u16(dv, 10, files.length)
  u32(dv, 12, centralSize)
  u32(dv, 16, offset)

  const total = offset + centralSize + end.length
  const out = new Uint8Array(total)
  let at = 0
  for (const part of [...chunks, ...central, end]) {
    out.set(part, at)
    at += part.length
  }
  return out
}
