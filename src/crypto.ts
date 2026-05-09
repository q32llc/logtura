const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toB64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromB64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((value.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return toB64Url(new Uint8Array(sig));
}

export async function signCookie(
  payload: string,
  secret: string,
): Promise<string> {
  const encoded = toB64Url(encoder.encode(payload));
  const sig = await hmac(encoded, secret);
  return `${encoded}.${sig}`;
}

export async function verifyCookie(
  cookie: string | undefined,
  secret: string,
): Promise<string | null> {
  if (!cookie) return null;
  const [encoded, providedSig] = cookie.split(".");
  if (!encoded || !providedSig) return null;
  const expected = await hmac(encoded, secret);
  if (expected !== providedSig) return null;
  return decoder.decode(fromB64Url(encoded));
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = fromB64Url(secret);
  if (raw.length !== 32) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be 32 bytes (base64url)");
  }
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptSecret(
  plaintext: string,
  keyB64: string,
): Promise<Uint8Array> {
  const key = await aesKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext),
  );
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), iv.length);
  return out;
}

export async function decryptSecret(
  envelope: Uint8Array,
  keyB64: string,
): Promise<string> {
  const key = await aesKey(keyB64);
  const iv = envelope.slice(0, 12);
  const ct = envelope.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return decoder.decode(pt);
}

export function newId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}_${toB64Url(bytes)}`;
}

export function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toB64Url(bytes);
}
