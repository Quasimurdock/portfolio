/**
 * Runs the express app on Deno Deploy.
 *
 * The platform starts the entrypoint and waits for *an* HTTP server to appear,
 * but the only server it knows how to reach is the one registered through
 * `Deno.serve()`: that call is bound to the address the platform injects
 * (`DENO_SERVE_ADDRESS`) and it is what the build's warm-up phase probes. A
 * plain `app.listen()` opens an ordinary TCP port instead, which nothing ever
 * connects to — the process looks healthy in the logs while the warm-up spins
 * until it times out.
 *
 * So on Deploy `Deno.serve()` owns the listener and this module translates each
 * fetch `Request` into the `(req, res)` pair express expects, and the response
 * back into a `Response`. A real `ServerResponse` provides the express-facing
 * response (so `req.protocol`, `req.ip`, `res.setHeader`, `res.send`,
 * `res.sendFile` and the streaming used by the static middleware all behave
 * normally); only the two ends that would normally touch a TCP socket are
 * replaced.
 *
 * The request is a plain `Readable` over the already-buffered body rather than
 * a node `IncomingMessage`: on Deno 2.6 a hand-fed `IncomingMessage` loses
 * everything it buffered once the stream ends (a 600 KB upload arrives as its
 * first 323 bytes), which makes `req.headers['content-length']` disagree with
 * what the body parsers read.
 */
import { ServerResponse } from 'node:http'
import { Readable, Writable } from 'node:stream'

// Headers that describe this hop only; they must not be copied onto the fetch
// Response (fetch rejects some of them outright).
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const BODYLESS_STATUS = new Set([204, 304])

/**
 * Stands in for the socket the request and response expect. It is never written
 * to — the response side is captured directly — but express reads the address
 * off it (`req.ip`, `req.protocol`) and node attaches listeners to it.
 */
class InertSocket extends Writable {
  constructor() {
    super({ decodeStrings: true })
    this.readable = false
    this.writable = true
    this.encrypted = false
    this.connecting = false
    this.readyState = 'open'
    this.remoteAddress = '127.0.0.1'
    this.remotePort = 0
    this.localAddress = '127.0.0.1'
    this.localPort = 0
  }

  _write(_chunk, _encoding, callback) {
    callback()
  }

  _final(callback) {
    callback()
  }

  address() {
    return { address: this.localAddress, family: 'IPv4', port: this.localPort }
  }

  setTimeout() {
    return this
  }

  setNoDelay() {
    return this
  }

  setKeepAlive() {
    return this
  }

  unref() {
    return this
  }

  ref() {
    return this
  }
}

function toNodeRequest(request, parts) {
  const url = new URL(request.url)
  const socket = new InertSocket()

  const req = Readable.from(parts, { objectMode: false })

  req.method = request.method
  req.url = `${url.pathname}${url.search}`
  req.httpVersion = '1.1'
  req.httpVersionMajor = 1
  req.httpVersionMinor = 1

  const headers = Object.create(null)
  for (const [name, value] of request.headers) {
    const key = name.toLowerCase()
    headers[key] = key in headers ? `${headers[key]}, ${value}` : value
  }
  req.headers = headers
  req.complete = true
  req.socket = socket
  // `connection` is a getter for `socket` on some runtimes and a plain property
  // on others; express reads it for `req.protocol`.
  try {
    req.connection = socket
  } catch {
    /* getter-only on this runtime */
  }

  return { req, socket }
}

/**
 * Reads the whole request body up front. Everything downstream expects a node
 * request stream whose `content-length` matches what the parsers read, and the
 * bodies this app accepts are small (1 MB JSON, 25 MB database uploads), so
 * buffering is simpler and safer than pumping the fetch stream chunk by chunk.
 */
async function readBody(request) {
  if (!request.body) return []
  return [Buffer.from(await request.arrayBuffer())]
}

function toBuffer(chunk, encoding) {
  if (Buffer.isBuffer(chunk)) return chunk
  if (chunk instanceof Uint8Array) return Buffer.from(chunk)
  return Buffer.from(String(chunk), encoding || 'utf8')
}

/**
 * Wraps a `ServerResponse` so the status line, headers and body express writes
 * are collected instead of serialised onto a socket, then turned into a fetch
 * `Response`. The `ServerResponse` is still real, so every method express calls
 * while building the response works unchanged.
 */
function createResponse(req) {
  const res = new ServerResponse(req)
  const headers = new Map()
  const chunks = []
  let settled = false
  let resolveResponse

  const response = new Promise((resolve) => {
    resolveResponse = resolve
  })

  const originalSetHeader = res.setHeader.bind(res)
  const originalRemoveHeader = res.removeHeader.bind(res)

  const remember = (name, value) => {
    const key = String(name).toLowerCase()
    headers.set(key, value)
  }

  res.setHeader = (name, value) => {
    remember(name, value)
    return originalSetHeader(name, value)
  }
  res.removeHeader = (name) => {
    headers.delete(String(name).toLowerCase())
    return originalRemoveHeader(name)
  }
  res.appendHeader = (name, value) => {
    const key = String(name).toLowerCase()
    const existing = headers.get(key)
    const list = existing === undefined ? [] : Array.isArray(existing) ? existing.slice() : [existing]
    list.push(value)
    remember(key, list)
    return originalSetHeader(key, list)
  }
  res.writeHead = (statusCode, statusMessage, extra) => {
    if (statusMessage && typeof statusMessage === 'object') {
      extra = statusMessage
      statusMessage = undefined
    }
    if (typeof statusCode === 'number') res.statusCode = statusCode
    if (typeof statusMessage === 'string') res.statusMessage = statusMessage
    if (extra) for (const [name, value] of Object.entries(extra)) res.setHeader(name, value)
    res._header = 'captured'
    return res
  }
  res.flushHeaders = () => {}
  res.write = (chunk, encoding, callback) => {
    if (typeof encoding === 'function') {
      callback = encoding
      encoding = undefined
    }
    res._header = 'captured'
    if (chunk !== undefined && chunk !== null && chunk !== '') chunks.push(toBuffer(chunk, encoding))
    if (typeof callback === 'function') callback()
    return true
  }
  res.end = (chunk, encoding, callback) => {
    if (typeof chunk === 'function') {
      callback = chunk
      chunk = undefined
      encoding = undefined
    } else if (typeof encoding === 'function') {
      callback = encoding
      encoding = undefined
    }
    res._header = 'captured'
    if (chunk !== undefined && chunk !== null && chunk !== '') {
      const buffer = toBuffer(chunk, encoding)
      if (buffer.length) chunks.push(buffer)
    }
    res.finished = true
    settle()
    if (typeof callback === 'function') callback()
    return res
  }

  function settle() {
    if (settled) return
    settled = true

    const out = new Headers()
    for (const [name, value] of headers) {
      if (value === undefined || value === null || HOP_BY_HOP.has(name)) continue
      if (Array.isArray(value)) for (const item of value) out.append(name, String(item))
      else out.append(name, String(value))
    }

    const status = res.statusCode || 200
    const bodyless = req.method === 'HEAD' || BODYLESS_STATUS.has(status)
    const body = bodyless || chunks.length === 0 ? null : Buffer.concat(chunks)

    // The app logs requests from `res.on('finish')`, which never fires now that
    // the response is not written by node; emit it so that keeps working.
    queueMicrotask(() => {
      try {
        res.emit('finish')
      } catch {
        /* a listener threw; the response itself is already settled */
      }
    })

    resolveResponse(new Response(body, { status, statusText: res.statusMessage || undefined, headers: out }))
  }

  return { res, response }
}

/**
 * Turns an express app (a node `(req, res)` handler) into a fetch handler that
 * `Deno.serve()` accepts. One `Request` in, one `Response` out.
 */
export function createFetchHandler(nodeHandler) {
  return async function fetchHandler(request) {
    let parts
    try {
      parts = await readBody(request)
    } catch {
      return Response.json(
        { error: { code: 'bad_request', message: 'The request body could not be read' } },
        { status: 400 },
      )
    }

    const { req } = toNodeRequest(request, parts)
    const { res, response } = createResponse(req)

    try {
      nodeHandler(req, res)
    } catch (error) {
      return Promise.reject(error)
    }

    return response
  }
}
