/**
 * 通用文件 API
 * 用于藏宝阁资源上传、文件库管理和公开下载
 */

import { api } from './client'

/** 后端通用文件记录 */
export interface UploadedFile {
  id: number
  filename: string
  original_name: string
  url: string
  file_size: number
  mime_type: string
  created_at: string
}

/** 文件分页列表响应 */
interface FileListResponse {
  items: UploadedFile[]
  total: number
}

/** 获取已上传文件列表 */
export async function fetchFiles(): Promise<UploadedFile[]> {
  const response = await api.get<FileListResponse>('/api/v1/files?page=1&page_size=200', true)
  return response.items
}

/** 删除已上传文件 */
export function deleteUploadedFile(fileId: number): Promise<void> {
  return api.delete<void>(`/api/v1/files/${fileId}`)
}

/** 上传任意类型文件，并报告浏览器侧上传进度 */
export function uploadFile(
  file: File,
  onProgress?: (percent: number) => void,
): Promise<UploadedFile> {
  return uploadFileDirectly(file, onProgress)
}

interface PresignResponse {
  key: string
  upload_url: string
  upload_headers: Record<string, string>
}

/** 先向 API 获取短期签名，再由浏览器直接把文件写入 R2。 */
async function uploadFileDirectly(
  file: File,
  onProgress?: (percent: number) => void,
): Promise<UploadedFile> {
  const presigned = await api.post<PresignResponse>('/api/v1/uploads/presign', {
    filename: file.name,
    content_type: file.type || 'application/octet-stream',
    size: file.size,
  }, true)
  await putToSignedUrl(presigned.upload_url, presigned.upload_headers, file, onProgress)
  return api.post<UploadedFile>('/api/v1/uploads/complete', {
    key: presigned.key,
    filename: file.name,
    content_type: file.type || 'application/octet-stream',
    size: file.size,
  }, true)
}

/** 使用 XMLHttpRequest 保留上传进度显示。 */
function putToSignedUrl(
  url: string,
  headers: Record<string, string>,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value)

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100))
      }
    })

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve()
        return
      }
      reject(new Error(`R2 上传失败 (${xhr.status})`))
    })
    xhr.addEventListener('error', () => reject(new Error('网络错误，上传失败')))
    xhr.addEventListener('abort', () => reject(new Error('上传已取消')))
    xhr.send(file)
  })
}

/** 按顺序批量上传文件，单个文件失败不会中断后续任务。 */
export async function uploadFiles(
  files: File[],
  onProgress?: (completed: number, total: number, current: string) => void,
): Promise<{ file: File; result?: UploadedFile; error?: string }[]> {
  const results: { file: File; result?: UploadedFile; error?: string }[] = []
  for (const [index, file] of files.entries()) {
    onProgress?.(index, files.length, file.name)
    try {
      const result = await uploadFile(file, (percent) => {
        onProgress?.(index + percent / 100, files.length, file.name)
      })
      results.push({ file, result })
    } catch (error: unknown) {
      results.push({ file, error: error instanceof Error ? error.message : '上传失败' })
    }
  }
  onProgress?.(files.length, files.length, '')
  return results
}
