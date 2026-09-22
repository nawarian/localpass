/**
 * S3 client for LocalPass – port of cli/internal/s3/s3.go
 *
 * A minimal `fetch` + AWS Signature V4 client for the four single-object calls
 * LocalPass needs (PUT, GET, HEAD). Hand-rolled on WebCrypto so it runs in any
 * context — including the extension's background script, where the AWS SDK's
 * dynamic imports aren't allowed — with zero dependencies.
 *
 * Addressing mirrors the SDK config it replaces: path-style for a custom
 * endpoint (MinIO, R2, …), virtual-hosted style on AWS itself.
 */

export interface S3Config {
  endpoint?: string;
  region: string;
  bucket: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Thrown for any non-2xx response; `name` is the S3 error code when known. */
export class S3Error extends Error {
  constructor(
    public readonly status: number,
    name: string,
    message: string,
  ) {
    super(message);
    this.name = name;
  }
}

/**
 * Upload data to S3.
 */
export async function s3Upload(config: S3Config, data: Uint8Array): Promise<void> {
  await s3Request(config, "PUT", data);
}

/**
 * Download data from S3.
 */
export async function s3Download(config: S3Config): Promise<Uint8Array> {
  const res = await s3Request(config, "GET");
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Check whether the S3 object exists.
 */
export async function s3ObjectExists(config: S3Config): Promise<boolean> {
  try {
    await s3Request(config, "HEAD");
    return true;
  } catch (err: unknown) {
    if (err instanceof S3Error && err.name === "NotFound") return false;
    // Re-throw other errors
    throw err;
  }
}

/**
 * Get the LastModified timestamp of the S3 object, or undefined if not found.
 */
export async function s3LastModified(config: S3Config): Promise<Date | undefined> {
  try {
    const res = await s3Request(config, "HEAD");
    const lm = res.headers.get("last-modified");
    return lm ? new Date(lm) : undefined;
  } catch {
    return undefined;
  }
}

// ---------- request + signing ----------

async function s3Request(config: S3Config, method: "GET" | "PUT" | "HEAD", body?: Uint8Array): Promise<Response> {
  const url = objectUrl(config);
  const headers = await signRequest(config, method, url, body ?? new Uint8Array(0), new Date());
  const res = await fetch(url, { method, headers, body: body as BodyInit | undefined });
  if (!res.ok) throw await toS3Error(res, method);
  return res;
}

/**
 * The object URL: path-style `<endpoint>/<bucket>/<key>` for a custom
 * endpoint, virtual-hosted `https://<bucket>.s3.<region>.amazonaws.com/<key>`
 * on AWS (path-style there too for dotted bucket names, which would break
 * the wildcard TLS certificate).
 */
export function objectUrl(config: S3Config): URL {
  const key = config.key.split("/").map(uriEncode).join("/");
  if (config.endpoint) {
    const base = config.endpoint.replace(/\/+$/, "");
    return new URL(`${base}/${uriEncode(config.bucket)}/${key}`);
  }
  if (config.bucket.includes(".")) {
    return new URL(`https://s3.${config.region}.amazonaws.com/${config.bucket}/${key}`);
  }
  return new URL(`https://${config.bucket}.s3.${config.region}.amazonaws.com/${key}`);
}

/**
 * SigV4 headers for a request with no query string. Signs host, the payload
 * hash and the timestamp. `host` itself is derived by `fetch` from the URL,
 * so it's signed but not returned.
 */
export async function signRequest(
  config: S3Config,
  method: string,
  url: URL,
  body: Uint8Array,
  now: Date,
): Promise<Record<string, string>> {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); // 20130524T000000Z
  const date = amzDate.slice(0, 8);
  const payloadHash = hex(await sha256(body));

  const signed: [string, string][] = [
    ["host", url.host],
    ["x-amz-content-sha256", payloadHash],
    ["x-amz-date", amzDate],
  ];
  const signedHeaders = signed.map(([k]) => k).join(";");
  const canonicalRequest = [
    method,
    url.pathname,
    "", // no query string
    signed.map(([k, v]) => `${k}:${v}\n`).join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${date}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    hex(await sha256(new TextEncoder().encode(canonicalRequest))),
  ].join("\n");

  let key = await hmac(new TextEncoder().encode(`AWS4${config.secretAccessKey}`), date);
  for (const part of [config.region, "s3", "aws4_request"]) key = await hmac(key, part);
  const signature = hex(await hmac(key, stringToSign));

  return {
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

async function toS3Error(res: Response, method: string): Promise<S3Error> {
  // HEAD responses carry no body; name a missing object like the SDK did.
  if (method === "HEAD") {
    return res.status === 404
      ? new S3Error(404, "NotFound", "Not Found")
      : new S3Error(res.status, `HTTP${res.status}`, `S3 request failed with HTTP ${res.status}`);
  }
  const text = await res.text().catch(() => "");
  const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1];
  const message = /<Message>([^<]*)<\/Message>/.exec(text)?.[1];
  return new S3Error(
    res.status,
    code || `HTTP${res.status}`,
    message || code || `S3 request failed with HTTP ${res.status}`,
  );
}

/** RFC 3986 encoding as SigV4 expects: everything but A–Z a–z 0–9 - _ . ~ */
function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

async function hmac(key: Uint8Array, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
