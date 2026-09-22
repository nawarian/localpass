import { Sha256 } from "@aws-crypto/sha256-js";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SignatureV4 } from "@smithy/signature-v4";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  S3Error,
  objectUrl,
  s3Download,
  s3LastModified,
  s3ObjectExists,
  s3Upload,
  signRequest,
  type S3Config,
} from "./s3.js";

const AWS: S3Config = {
  region: "eu-central-1",
  bucket: "my-vaults",
  key: "localpass/vault.enc",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

const MINIO: S3Config = {
  ...AWS,
  endpoint: "http://127.0.0.1:9000/",
  region: "us-east-1",
  key: "dir/my vault (1)*.enc",
};

const NOW = new Date("2026-09-21T12:34:56.789Z");

afterEach(() => {
  vi.restoreAllMocks();
});

/** The Authorization header the AWS SDK's own signer produces for the same request. */
async function referenceAuthorization(config: S3Config, method: string, body: Uint8Array): Promise<string> {
  const url = objectUrl(config);
  const signer = new SignatureV4({
    service: "s3",
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    sha256: Sha256,
    uriEscapePath: false, // S3 signs the already-encoded path as-is
    applyChecksum: true,
  });
  const signed = await signer.sign(
    {
      method,
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      path: url.pathname,
      query: {},
      headers: { host: url.host },
      body,
    },
    { signingDate: NOW },
  );
  return signed.headers["authorization"];
}

describe("signRequest", () => {
  const cases: [string, S3Config, string, Uint8Array][] = [
    ["PUT with a body on AWS", AWS, "PUT", new TextEncoder().encode("ciphertext bytes")],
    ["GET on AWS", AWS, "GET", new Uint8Array(0)],
    ["HEAD on AWS", AWS, "HEAD", new Uint8Array(0)],
    ["PUT on a custom endpoint with a port and odd key", MINIO, "PUT", new Uint8Array([0, 1, 2, 255])],
  ];

  for (const [name, config, method, body] of cases) {
    it(`matches the AWS SDK signer: ${name}`, async () => {
      const ours = await signRequest(config, method, objectUrl(config), body, NOW);
      expect(ours["x-amz-date"]).toBe("20260921T123456Z");
      expect(ours.authorization).toBe(await referenceAuthorization(config, method, body));
    });
  }
});

describe("objectUrl", () => {
  /** Where the AWS SDK (the previous implementation) sends a GetObject. */
  async function sdkUrl(config: S3Config): Promise<string> {
    let captured: { protocol: string; hostname: string; port?: number; path: string } | undefined;
    const client = new S3Client({
      region: config.region,
      endpoint: config.endpoint || undefined,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      forcePathStyle: config.endpoint ? true : false,
      requestHandler: {
        handle: async (req: typeof captured) => {
          captured = req;
          throw new Error("captured");
        },
      } as never,
    });
    await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: config.key })).catch(() => {});
    const c = captured!;
    return `${c.protocol}//${c.hostname}${c.port ? `:${c.port}` : ""}${c.path}`;
  }

  it("matches the SDK's virtual-hosted URL on AWS", async () => {
    expect(objectUrl(AWS).href).toBe(await sdkUrl(AWS));
  });

  it("matches the SDK's path-style URL on a custom endpoint", async () => {
    expect(objectUrl(MINIO).href).toBe(await sdkUrl(MINIO));
  });

  it("uses path-style on AWS for dotted bucket names", async () => {
    const dotted = { ...AWS, bucket: "vaults.example.com" };
    expect(objectUrl(dotted).href).toBe(await sdkUrl(dotted));
  });
});

describe("requests", () => {
  function mockFetch(res: Response) {
    return vi.spyOn(globalThis, "fetch").mockResolvedValue(res);
  }

  it("uploads with PUT and signed headers", async () => {
    const f = mockFetch(new Response(null, { status: 200 }));
    await s3Upload(AWS, new Uint8Array([1, 2, 3]));
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe("https://my-vaults.s3.eu-central-1.amazonaws.com/localpass/vault.enc");
    expect(init?.method).toBe("PUT");
    expect((init?.headers as Record<string, string>).authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
  });

  it("downloads the body bytes", async () => {
    mockFetch(new Response(new Uint8Array([9, 8, 7]), { status: 200 }));
    expect(Array.from(await s3Download(AWS))).toEqual([9, 8, 7]);
  });

  it("turns S3 XML errors into S3Error with the error code", async () => {
    mockFetch(
      new Response("<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>", {
        status: 404,
      }),
    );
    const err = await s3Download(AWS).catch((e) => e);
    expect(err).toBeInstanceOf(S3Error);
    expect(err.name).toBe("NoSuchKey");
    expect(err.message).toBe("The specified key does not exist.");
  });

  it("reports existence and last-modified via HEAD", async () => {
    mockFetch(new Response(null, { status: 404 }));
    expect(await s3ObjectExists(AWS)).toBe(false);
    expect(await s3LastModified(AWS)).toBeUndefined();

    mockFetch(new Response(null, { status: 200, headers: { "last-modified": "Mon, 21 Sep 2026 12:00:00 GMT" } }));
    expect(await s3ObjectExists(AWS)).toBe(true);
    expect((await s3LastModified(AWS))?.toISOString()).toBe("2026-09-21T12:00:00.000Z");
  });

  it("re-throws non-404 HEAD failures from s3ObjectExists", async () => {
    mockFetch(new Response(null, { status: 403 }));
    await expect(s3ObjectExists(AWS)).rejects.toBeInstanceOf(S3Error);
  });
});
