export interface TarFile {
  name: string;
  content: string | Uint8Array;
  mode?: number;
  mtime?: number;
}

const BLOCK = 512;
const HEADER_SIZE = 512;

export function buildTar(files: TarFile[]): Uint8Array {
  const enc = new TextEncoder();
  let total = 0;
  const bodies: Uint8Array[] = [];
  for (const f of files) {
    const body =
      typeof f.content === "string" ? enc.encode(f.content) : f.content;
    bodies.push(body);
    total += HEADER_SIZE + roundUp(body.length, BLOCK);
  }
  total += 2 * BLOCK;

  const out = new Uint8Array(total);
  let off = 0;
  files.forEach((f, i) => {
    const body = bodies[i]!;
    writeHeader(out, off, f, body.length);
    off += HEADER_SIZE;
    out.set(body, off);
    off += roundUp(body.length, BLOCK);
  });
  return out;
}

function roundUp(n: number, m: number): number {
  return Math.ceil(n / m) * m;
}

function writeHeader(
  buf: Uint8Array,
  offset: number,
  file: TarFile,
  size: number,
): void {
  const enc = new TextEncoder();
  if (file.name.length > 100) {
    throw new Error(`tar: name too long (>100 chars): ${file.name}`);
  }
  buf.set(enc.encode(file.name), offset);
  buf.set(enc.encode(octalField(file.mode ?? 0o644, 7)), offset + 100);
  buf.set(enc.encode(octalField(0, 7)), offset + 108);
  buf.set(enc.encode(octalField(0, 7)), offset + 116);
  buf.set(enc.encode(octalField(size, 11)), offset + 124);
  buf.set(
    enc.encode(octalField(file.mtime ?? Math.floor(Date.now() / 1000), 11)),
    offset + 136,
  );
  for (let i = 0; i < 8; i++) buf[offset + 148 + i] = 0x20;
  buf[offset + 156] = 0x30;
  buf.set(enc.encode("ustar"), offset + 257);
  buf[offset + 263] = 0;
  buf.set(enc.encode("00"), offset + 263);

  let cksum = 0;
  for (let i = 0; i < HEADER_SIZE; i++) cksum += buf[offset + i]!;
  const cks = cksum.toString(8).padStart(6, "0");
  buf.set(enc.encode(cks), offset + 148);
  buf[offset + 148 + 6] = 0;
  buf[offset + 148 + 7] = 0x20;
}

function octalField(n: number, width: number): string {
  return n.toString(8).padStart(width, "0") + "\0";
}
