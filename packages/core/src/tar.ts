/**
 * Minimal ustar/POSIX tar writer for a small fixed set of files.
 * Workers don't have a built-in archiver; this is enough for our
 * install-bundle (Dockerfile + vector.yaml + .env + install.sh +
 * README.md) without pulling in a dependency.
 *
 * Wire format (ustar): each file is one 512-byte header followed by
 * the file content padded with zeros up to the next 512-byte boundary.
 * Archive ends with two 512-byte zero blocks.
 *
 * Reference: https://www.gnu.org/software/tar/manual/html_node/Standard.html
 */

export interface TarFile {
  /** Path inside the archive, e.g. "logtura/Dockerfile". */
  name: string;
  content: string | Uint8Array;
  /** POSIX mode bits, e.g. 0o644 (default) or 0o755 for scripts. */
  mode?: number;
  /** Modification time in seconds since epoch; defaults to zero for reproducibility. */
  mtime?: number;
}

const BLOCK = 512;
const HEADER_SIZE = 512;

export function buildTar(files: TarFile[]): Uint8Array {
  const enc = new TextEncoder();
  // Compute total size first so we can allocate one buffer.
  let total = 0;
  const bodies: Uint8Array[] = [];
  const names = new Set<string>();
  for (const f of files) {
    if (!f.name || f.name.startsWith("/") || f.name.includes("\\") ||
        f.name.includes("\0") || f.name.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error(`tar: unsafe path: ${f.name}`);
    }
    if (names.has(f.name)) throw new Error(`tar: duplicate path: ${f.name}`);
    names.add(f.name);
    const body =
      typeof f.content === "string" ? enc.encode(f.content) : f.content;
    bodies.push(body);
    total += HEADER_SIZE + roundUp(body.length, BLOCK);
  }
  total += 2 * BLOCK; // trailing zero blocks

  const out = new Uint8Array(total);
  let off = 0;
  files.forEach((f, i) => {
    const body = bodies[i]!;
    writeHeader(out, off, f, body.length);
    off += HEADER_SIZE;
    out.set(body, off);
    off += roundUp(body.length, BLOCK);
  });
  // Two trailing zero blocks (already zero-initialized).
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
  const name = file.name;
  if (enc.encode(name).length > 100) {
    throw new Error(`tar: name too long (>100 bytes): ${name}`);
  }
  const mode = file.mode ?? 0o644;
  const mtime = file.mtime ?? 0;

  // 0-100   name
  buf.set(enc.encode(name), offset + 0);
  // 100-108 mode (octal, 7 digits + NUL)
  buf.set(enc.encode(octalField(mode, 7)), offset + 100);
  // 108-116 uid
  buf.set(enc.encode(octalField(0, 7)), offset + 108);
  // 116-124 gid
  buf.set(enc.encode(octalField(0, 7)), offset + 116);
  // 124-136 size (octal, 11 digits + NUL)
  buf.set(enc.encode(octalField(size, 11)), offset + 124);
  // 136-148 mtime
  buf.set(enc.encode(octalField(mtime, 11)), offset + 136);
  // 148-156 checksum — fill with spaces during compute, then patch
  for (let i = 0; i < 8; i++) buf[offset + 148 + i] = 0x20;
  // 156    typeflag — '0' = regular file
  buf[offset + 156] = 0x30;
  // 257-263 magic "ustar\0"
  buf.set(enc.encode("ustar"), offset + 257);
  buf[offset + 263] = 0;
  // 263-265 version "00"
  buf.set(enc.encode("00"), offset + 263);

  // Compute checksum (sum of bytes in header, treating cksum field
  // as spaces — which we did above).
  let cksum = 0;
  for (let i = 0; i < HEADER_SIZE; i++) cksum += buf[offset + i]!;
  // Write checksum: 6 octal digits, NUL, space (POSIX quirk).
  const cks = cksum.toString(8).padStart(6, "0");
  buf.set(enc.encode(cks), offset + 148);
  buf[offset + 148 + 6] = 0; // NUL
  buf[offset + 148 + 7] = 0x20; // space
}

function octalField(n: number, width: number): string {
  if (!Number.isSafeInteger(n) || n < 0 || n.toString(8).length > width) {
    throw new Error(`tar: invalid numeric field: ${n}`);
  }
  return n.toString(8).padStart(width, "0") + "\0";
}
