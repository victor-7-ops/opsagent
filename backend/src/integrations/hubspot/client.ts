import { getValidAccessToken } from "./oauth";

const API_BASE = "https://api.hubapi.com";

export class HubspotApiError extends Error {
  constructor(public status: number, message: string) {
    super(`HubSpot API error (${status}): ${message}`);
    this.name = "HubspotApiError";
  }
}

async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  const accessToken = await getValidAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new HubspotApiError(res.status, text);
  }
  return res.json();
}

export async function hubspotGet(path: string): Promise<unknown> {
  return request("GET", path);
}

// Additive — v1 only had hubspotGet. Needed by the v2 executor's real tool
// implementations (hubspot.update_contact/create_deal/add_note).
export async function hubspotPatch(path: string, body: unknown): Promise<unknown> {
  return request("PATCH", path, body);
}

export async function hubspotPost(path: string, body: unknown): Promise<unknown> {
  return request("POST", path, body);
}
