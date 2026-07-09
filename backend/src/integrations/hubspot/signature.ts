import crypto from "crypto";

const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

export function verifyHubspotSignatureV3(
  method: string,
  requestUri: string,
  rawBody: Buffer,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
): boolean {
  const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;
  if (!clientSecret || !timestampHeader || !signatureHeader) return false;

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > MAX_TIMESTAMP_SKEW_MS) {
    return false;
  }

  const sourceString = method + requestUri + rawBody.toString("utf8") + timestampHeader;
  const expected = crypto
    .createHmac("sha256", clientSecret)
    .update(sourceString)
    .digest("base64");

  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}
