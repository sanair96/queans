import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const maxR2PresignExpiresSeconds = 7 * 24 * 60 * 60;

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint: string;
  region: string;
  presignExpiresSeconds: number;
}

export interface PresignedPut {
  objectKey: string;
  url: string;
  expiresAt: Date;
}

export interface StoredObjectHead {
  etag?: string | undefined;
  byteSize: number;
  contentType?: string | undefined;
}

export interface StoredObjectPut {
  objectKey: string;
  etag?: string | undefined;
}

export function loadR2ConfigFromEnv(env: NodeJS.ProcessEnv): R2Config {
  const accountId = requiredEnv(env, "R2_ACCOUNT_ID");
  return {
    accountId,
    accessKeyId: requiredEnv(env, "R2_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv(env, "R2_SECRET_ACCESS_KEY"),
    bucket: requiredEnv(env, "R2_BUCKET"),
    endpoint: r2EndpointForAccount(accountId, env.R2_ENDPOINT),
    region: env.R2_REGION?.trim() || "auto",
    presignExpiresSeconds: boundedPositiveIntegerEnv(
      env,
      "R2_PRESIGN_EXPIRES_SECONDS",
      900,
      maxR2PresignExpiresSeconds
    )
  };
}

export function r2EndpointForAccount(accountId: string, configuredEndpoint: string | undefined) {
  const endpoint = configuredEndpoint?.trim();
  if (!endpoint || endpoint.includes("<account-id>")) {
    return `https://${accountId}.r2.cloudflarestorage.com`;
  }

  return endpoint;
}

export class R2ObjectStore {
  private readonly client: S3Client;

  constructor(private readonly config: R2Config) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey
      },
      forcePathStyle: true
    });
  }

  async createPresignedPut(input: {
    objectKey: string;
    contentType: string;
    byteSize: number;
    checksumSha256?: string | undefined;
  }): Promise<PresignedPut> {
    const command = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: input.objectKey,
      ContentLength: input.byteSize,
      ContentType: input.contentType,
      ChecksumSHA256: input.checksumSha256
    });

    const url = await getSignedUrl(this.client, command, {
      expiresIn: this.config.presignExpiresSeconds
    });

    return {
      objectKey: input.objectKey,
      url,
      expiresAt: new Date(Date.now() + this.config.presignExpiresSeconds * 1000)
    };
  }

  async createPresignedRead(objectKey: string, expiresInSeconds = this.config.presignExpiresSeconds) {
    const command = new HeadObjectCommand({
      Bucket: this.config.bucket,
      Key: objectKey
    });
    await this.client.send(command);

    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: objectKey
      }),
      { expiresIn: expiresInSeconds }
    );
  }

  async headObject(objectKey: string): Promise<StoredObjectHead> {
    const response = await this.client.send(
      new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: objectKey
      })
    );

    if (response.ContentLength === undefined) {
      throw new Error(`R2 object ${objectKey} is missing ContentLength`);
    }

    return {
      etag: response.ETag,
      byteSize: response.ContentLength,
      contentType: response.ContentType
    };
  }

  async putObject(input: { objectKey: string; body: Uint8Array; contentType: string }): Promise<StoredObjectPut> {
    const response = await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: input.objectKey,
        Body: input.body,
        ContentType: input.contentType
      })
    );

    return {
      objectKey: input.objectKey,
      etag: response.ETag
    };
  }
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string) {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function boundedPositiveIntegerEnv(env: NodeJS.ProcessEnv, key: string, defaultValue: number, maxValue: number) {
  const value = env[key]?.trim();
  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maxValue) {
    throw new Error(`${key} must be an integer between 1 and ${maxValue}`);
  }

  return parsed;
}
