import { protocol } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'

export const APP_SCHEME = 'app'
export const APP_ORIGIN = `${APP_SCHEME}://bundle`
export const DICOM_BASE_URL = `${APP_ORIGIN}/dicom/`

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.dcm': 'application/dicom'
}

/** Must run before app 'ready'. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        codeCache: true
      }
    }
  ])
}

function isInside(root: string, p: string): boolean {
  const r = resolve(root)
  const abs = resolve(p)
  return abs === r || abs.startsWith(r + sep)
}

async function fileResponse(filePath: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  try {
    const st = await stat(filePath)
    if (!st.isFile()) return new Response('Not found', { status: 404 })
    const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    const body = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': type,
        'Content-Length': String(st.size),
        'Cache-Control': 'no-cache',
        ...extraHeaders
      }
    })
  } catch {
    return new Response('Not found', { status: 404 })
  }
}

/**
 * Serves the renderer bundle (app://bundle/index.html …) and DICOM files from the archive
 * (app://bundle/dicom/<relative path>). Called after app 'ready'.
 */
export function handleAppScheme(rendererDir: string, getArchiveDir: () => string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname.startsWith('/dicom/')) {
      const archive = getArchiveDir()
      const file = normalize(join(archive, ...pathname.slice('/dicom/'.length).split('/')))
      if (!isInside(archive, file)) return new Response('Forbidden', { status: 403 })
      // CORS header so the dev server (http://localhost) can also load images.
      return fileResponse(file, { 'Access-Control-Allow-Origin': '*' })
    }
    if (pathname === '/' || pathname === '') pathname = '/index.html'
    const file = normalize(join(rendererDir, ...pathname.split('/').filter(Boolean)))
    if (!isInside(rendererDir, file)) return new Response('Forbidden', { status: 403 })
    return fileResponse(file)
  })
}
