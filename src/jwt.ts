export interface DecodedJwt {
  raw: string;
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  const full = pad ? padded + "=".repeat(4 - pad) : padded;
  return Buffer.from(full, "base64").toString("utf8");
}

export function decodeJwt(token: string): DecodedJwt | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p] = parts as [string, string, string];
  try {
    const header = JSON.parse(base64UrlDecode(h)) as Record<string, unknown>;
    const payload = JSON.parse(base64UrlDecode(p)) as Record<string, unknown>;
    return { raw: token, header, payload };
  } catch {
    return null;
  }
}

export function extractBearer(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return match?.[1] ?? null;
}
