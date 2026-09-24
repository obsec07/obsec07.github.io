// /admin/vault.json — the GitHub token the admin page uses to save posts, encrypted with the admin's username + password.
// Built by the Pages workflow from repo secrets (ADMIN_TOKEN, ADMIN_PASSWORD; ADMIN_USERNAME defaults to t0b!).
// Only ciphertext is published: PBKDF2-SHA256 (600k iterations) -> AES-256-GCM, decrypted in the browser at login.
// Anyone can download it and try passwords offline, so the password's strength is what protects it.
export const ITERATIONS = 600_000;

export async function GET() {
  const token = process.env.ADMIN_TOKEN, password = process.env.ADMIN_PASSWORD;
  const user = process.env.ADMIN_USERNAME || 't0b!';
  if (import.meta.env.PUBLIC_STATIC_SITE !== 'true' || !token || !password) return Response.json({ configured: false });
  const { subtle } = globalThis.crypto;
  const enc = new TextEncoder(), b64 = (u8) => Buffer.from(u8).toString('base64');
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await subtle.importKey('raw', enc.encode(`${user}\n${password}`), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify({ token, user }))));
  return Response.json({ configured: true, v: 1, iter: ITERATIONS, salt: b64(salt), iv: b64(iv), ct: b64(ct) });
}
