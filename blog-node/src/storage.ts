/** Cloudflare R2 的 S3 兼容存储适配层。 */
import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { config, r2Enabled } from './config.js'

let client: S3Client | undefined

function getClient(): S3Client {
  if (!r2Enabled()) throw new Error('R2 未配置')
  client ??= new S3Client({
    region: 'auto',
    endpoint: `https://${config.r2AccountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey,
    },
  })
  return client
}

export function normalizeKey(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\/+/, '')
}

export function publicUrl(key: string): string {
  return `${config.r2PublicUrl.replace(/\/+$/, '')}/${normalizeKey(key)}`
}

export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<string> {
  const normalized = normalizeKey(key)
  await getClient().send(
    new PutObjectCommand({
      Bucket: config.r2BucketName,
      Key: normalized,
      Body: body,
      ContentType: contentType || 'application/octet-stream',
    }),
  )
  return publicUrl(normalized)
}

/** 为浏览器直传 R2 创建短期 PUT 地址，避免大文件经过 Serverless 函数。 */
export async function createUploadUrl(
  key: string,
  contentType: string,
  expiresIn = 600,
): Promise<string> {
  const normalized = normalizeKey(key)
  return getSignedUrl(
    getClient(),
    new PutObjectCommand({
      Bucket: config.r2BucketName,
      Key: normalized,
      ContentType: contentType || 'application/octet-stream',
    }),
    { expiresIn },
  )
}

/** 确认浏览器直传已经在 R2 中生成对象。 */
export async function objectExists(key: string): Promise<boolean> {
  if (!key || !r2Enabled()) return false
  try {
    await getClient().send(new HeadObjectCommand({ Bucket: config.r2BucketName, Key: normalizeKey(key) }))
    return true
  } catch {
    return false
  }
}

export async function deleteObject(key: string): Promise<void> {
  if (!key || !r2Enabled()) return
  await getClient().send(new DeleteObjectCommand({ Bucket: config.r2BucketName, Key: normalizeKey(key) }))
}
