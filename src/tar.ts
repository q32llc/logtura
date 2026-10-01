export { buildTar, type TarFile } from "@logtura/core";

/**
 * gzip a byte array using Workers' built-in CompressionStream.
 * Returns the gzipped bytes ready to be sent as application/gzip.
 */
export async function gzipBytes(input: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  // Cast: workers-types' `Uint8Array<ArrayBufferLike>` doesn't narrow
  // to BufferSource cleanly under TS 5.7+. The runtime accepts it.
  void writer.write(input as BufferSource);
  void writer.close();
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  let totalLen = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      totalLen += value.length;
    }
  }
  const out = new Uint8Array(totalLen);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
