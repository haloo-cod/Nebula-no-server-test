/** Cloudflare R2 的 S3 兼容存储适配层。 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type GetObjectCommandOutput,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { config, r2Enabled } from './config.js'

let client: S3Client | undefined

/** AWS SDK 的运行时客户端支持 send；部分 Vercel 构建器解析的 SDK 类型未暴露继承成员。 */
interface S3CommandClient {
  send<TOutput = unknown>(command: object): Promise<TOutput>
}

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

function sendS3Command<TOutput = unknown>(command: object): Promise<TOutput> {
  // 运行时对象仍是 AWS SDK S3Client；此窄化只兼容 Vercel 的类型解析差异。
  return (getClient() as unknown as S3CommandClient).send<TOutput>(command)
}

export function normalizeKey(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\/+/, '')
}

export function publicUrl(key: string): string {
  return `${config.r2PublicUrl.replace(/\/+$/, '')}/${normalizeKey(key)}`
}

export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<string> {
  const normalized = normalizeKey(key)
  await sendS3Command(
    new PutObjectCommand({
      Bucket: config.r2BucketName,
      Key: normalized,
      Body: body,
      ContentType: contentType || 'application/octet-stream',
    }),
  )
  return publicUrl(normalized)
}

/** 从 R2 读取对象内容，供服务端解析 EPUB 等需要二次处理的文件。 */
export async function getObject(key: string): Promise<Uint8Array> {
  const result = await sendS3Command<GetObjectCommandOutput>(
    new GetObjectCommand({ Bucket: config.r2BucketName, Key: normalizeKey(key) }),
  )
  if (!result.Body) throw new Error('R2 对象没有内容')
  return new Uint8Array(await result.Body.transformToByteArray())
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
    await sendS3Command(new HeadObjectCommand({ Bucket: config.r2BucketName, Key: normalizeKey(key) }))
    return true
  } catch {
    return false
  }
}

export async function deleteObject(key: string): Promise<void> {
  if (!key || !r2Enabled()) return
  await sendS3Command(new DeleteObjectCommand({ Bucket: config.r2BucketName, Key: normalizeKey(key) }))
}
