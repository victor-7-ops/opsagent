import { prisma } from "../../db/client";
import { encrypt, decrypt } from "../crypto";

const AUTH_URL = "https://app.hubspot.com/oauth/authorize";
const TOKEN_URL = "https://api.hubapi.com/oauth/v1/token";

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function buildAuthorizeUrl(): string {
  const params = new URLSearchParams({
    client_id: requiredEnv("HUBSPOT_CLIENT_ID"),
    redirect_uri: requiredEnv("HUBSPOT_REDIRECT_URI"),
    scope: requiredEnv("HUBSPOT_SCOPES"),
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function requestToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot token request failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<TokenResponse>;
}

async function storeToken(token: TokenResponse): Promise<void> {
  const expiresAt = new Date(Date.now() + token.expires_in * 1000);
  const data = {
    accessTokenCipher: encrypt(token.access_token),
    refreshTokenCipher: encrypt(token.refresh_token),
    expiresAt,
  };

  const existing = await prisma.hubspotToken.findFirst();
  if (existing) {
    await prisma.hubspotToken.update({ where: { id: existing.id }, data });
  } else {
    await prisma.hubspotToken.create({ data });
  }
}

export async function exchangeCodeForToken(code: string): Promise<void> {
  const token = await requestToken({
    grant_type: "authorization_code",
    client_id: requiredEnv("HUBSPOT_CLIENT_ID"),
    client_secret: requiredEnv("HUBSPOT_CLIENT_SECRET"),
    redirect_uri: requiredEnv("HUBSPOT_REDIRECT_URI"),
    code,
  });
  await storeToken(token);
}

async function refreshToken(refreshTokenValue: string): Promise<void> {
  const token = await requestToken({
    grant_type: "refresh_token",
    client_id: requiredEnv("HUBSPOT_CLIENT_ID"),
    client_secret: requiredEnv("HUBSPOT_CLIENT_SECRET"),
    refresh_token: refreshTokenValue,
  });
  await storeToken(token);
}

const EXPIRY_BUFFER_MS = 60_000;

export async function getValidAccessToken(): Promise<string> {
  const record = await prisma.hubspotToken.findFirst();
  if (!record) throw new Error("No HubSpot token stored. Complete OAuth flow first.");

  if (record.expiresAt.getTime() - EXPIRY_BUFFER_MS < Date.now()) {
    await refreshToken(decrypt(record.refreshTokenCipher));
    const refreshed = await prisma.hubspotToken.findFirst();
    if (!refreshed) throw new Error("HubSpot token missing after refresh");
    return decrypt(refreshed.accessTokenCipher);
  }

  return decrypt(record.accessTokenCipher);
}
