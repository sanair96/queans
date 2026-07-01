import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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

export function loadR2ConfigFromEnv(env: NodeJS.ProcessEnv): R2Config {
  const accountId = requiredEnv(env, "R2_ACCOUNT_ID");
  const endpoint = env.R2_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`;
  return {
    accountId,
    accessKeyId: requiredEnv(env, "R2_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv(env, "R2_SECRET_ACCESS_KEY"),
    bucket: requiredEnv(env, "R2_BUCKET"),
    endpoint,
    region: env.R2_REGION?.trim() || "auto",
    presignExpiresSeconds: Number.parseInt(env.R2_PRESIGN_EXPIRES_SECONDS ?? "900", 10)
  };
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
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string) {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}
