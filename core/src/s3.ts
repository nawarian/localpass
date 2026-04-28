/**
 * S3 client for LocalPass – port of cli/internal/s3/s3.go
 *
 * Uses the AWS SDK v3 for JavaScript.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";

export interface S3Config {
  endpoint?: string;
  region: string;
  bucket: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Upload data to S3.
 */
export async function s3Upload(
  config: S3Config,
  data: Uint8Array
): Promise<void> {
  const client = createClient(config);
  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: config.key,
      Body: data,
    })
  );
}

/**
 * Download data from S3.
 */
export async function s3Download(config: S3Config): Promise<Uint8Array> {
  const client = createClient(config);
  const response = await client.send(
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: config.key,
    })
  );

  const body = response.Body;
  if (!body) {
    throw new Error("S3 response body is empty");
  }

  // Body is a Readable | ReadableStream | Blob – convert to Uint8Array
  const bytes = await body.transformToByteArray();
  return bytes;
}

/**
 * Check whether the S3 object exists.
 */
export async function s3ObjectExists(config: S3Config): Promise<boolean> {
  const client = createClient(config);
  try {
    await client.send(
      new HeadObjectCommand({
        Bucket: config.bucket,
        Key: config.key,
      })
    );
    return true;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err as { name?: string }).name === "NotFound"
    ) {
      return false;
    }
    // Re-throw other errors
    throw err;
  }
}

/**
 * Get the LastModified timestamp of the S3 object, or undefined if not found.
 */
export async function s3LastModified(
  config: S3Config
): Promise<Date | undefined> {
  const client = createClient(config);
  try {
    const result = await client.send(
      new HeadObjectCommand({
        Bucket: config.bucket,
        Key: config.key,
      })
    );
    return result.LastModified;
  } catch {
    return undefined;
  }
}

function createClient(config: S3Config): S3Client {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint || undefined,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.endpoint ? true : false,
  });
}
