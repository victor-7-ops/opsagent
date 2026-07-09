import { getValidAccessToken } from "./oauth";

const API_BASE = "https://api.hubapi.com";

export async function hubspotGet(path: string): Promise<unknown> {
  const accessToken = await getValidAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot API error (${res.status}): ${text}`);
  }
  return res.json();
}
