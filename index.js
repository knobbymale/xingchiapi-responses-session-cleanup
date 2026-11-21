import { appendFileSync, renameSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const name = 'xingchiapi-responses-cleanup'

/** The configured xingchiapi Responses endpoint (baseURL `.../v1` + `/responses`). */
const TARGET_HOSTNAME = 'api.xingchiapi.com'
const TARGET_PATH = '/v1/responses'

/** Client-supplied session identifiers that must not reach the xingchiapi upstream. */
const REMOVED_HEADERS = ['session-id', 'x-session-id']

/** Top-level JSON body property removed from the final upstream request. */
const REMOVED_BODY_PROPERTY = 'prompt_cache_key'

/**
 * Diagnostic trail, one JSON line per sanitized request. It contains header
 * names and byte counts only: never header values, prompts, or credentials.
 */
const EVIDENCE_PATH = join(tmpdir(), 'dsh-xingchiapi-responses-cleanup.log')
const EVIDENCE_MAX_BYTES = 512 * 1024

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const byteLength = (text) => new TextEncoder().encode(text).byteLength

function isRequest(value) {
  const RequestCtor = globalThis.Request
  return RequestCtor !== undefined && value instanceof RequestCtor
}

function requestUrl(input) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (isRequest(input)) return input.url
  try {
    return String(input)
  } catch {
    return ''
  }
}

function isTargetResponsesUrl(raw) {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === TARGET_HOSTNAME
      && url.pathname.replace(/\/+/g, '/').replace(/\/+$/, '') === TARGET_PATH
  } catch {
    return false
  }
}

function requestMethod(input, init) {
  if (typeof init?.method === 'string') return init.method.toUpperCase()
  if (isRequest(input)) return input.method.toUpperCase()
  return 'GET'
}

function isTargetRequest(input, init) {
  return requestMethod(input, init) === 'POST' && isTargetResponsesUrl(requestUrl(input))
}

function mergedHeaders(input, init) {
  const HeadersCtor = globalThis.Headers
  const source = init?.headers !== undefined
    ? init.headers
    : isRequest(input)
      ? input.headers
      : undefined
  return new HeadersCtor(source)
}

async function bodyText(value) {
  if (typeof value === 'string') return value
  if (value instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(value))
  }
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
  }
  if (value !== null && typeof value === 'object' && typeof value.text === 'function') {
    try {
      return await value.text()
    } catch {
      return undefined
    }
  }
  return undefined
}

async function requestBodyText(input, init) {
  if (init !== undefined && hasOwn(init, 'body')) {
    return init.body === undefined || init.body === null ? undefined : bodyText(init.body)
  }
  if (!isRequest(input)) return undefined
  try {
    return await input.clone().text()
  } catch {
    return undefined
  }
}

function skipWhitespace(text, index) {
  while (index < text.length && /\s/.test(text[index])) index++
  return index
}

function stringEnd(text, start) {
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') index++
    else if (text[index] === '"') return index + 1
  }
  return -1
}

function valueEnd(text, start) {
  if (start >= text.length) return -1
  if (text[start] === '"') return stringEnd(text, start)
  if (text[start] !== '{' && text[start] !== '[') {
    let index = start
    while (index < text.length && !/[\s,}\]]/.test(text[index])) index++
    return index === start ? -1 : index
  }

  const closing = []
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (char === '"') {
      const end = stringEnd(text, index)
      if (end < 0) return -1
      index = end - 1
      continue
    }
    if (char === '{') closing.push('}')
    else if (char === '[') closing.push(']')
    else if (char === '}' || char === ']') {
      if (closing.pop() !== char) return -1
      if (closing.length === 0) return index + 1
    }
  }
  return -1
}

/** Scan the members of the outer JSON object without reserializing them. */
function topLevelMembers(text) {
  let index = skipWhitespace(text, 0)
  if (text[index] !== '{') return undefined
  const open = index
  index++
  const members = []

  for (;;) {
    index = skipWhitespace(text, index)
    if (index >= text.length) return undefined
    if (text[index] === '}') return { open, close: index, members }
    if (text[index] !== '"') return undefined

    const start = index
    const keyEnd = stringEnd(text, index)
    if (keyEnd < 0) return undefined
    let key
    try {
      key = JSON.parse(text.slice(index, keyEnd))
    } catch {
      return undefined
    }

    index = skipWhitespace(text, keyEnd)
    if (text[index] !== ':') return undefined
    index = skipWhitespace(text, index + 1)
    const end = valueEnd(text, index)
    if (end < 0) return undefined

    members.push({ key, start, end })
    index = skipWhitespace(text, end)

    if (text[index] === ',') {
      index++
      continue
    }
    if (text[index] === '}') return { open, close: index, members }
    return undefined
  }
}

/**
 * Remove every top-level occurrence of `propertyName` from an already
 * serialized JSON object. Values of all other members keep their raw bytes;
 * only inter-member whitespace is normalized to a single comma. Anything that
 * is not a JSON object, or does not own the property, is left untouched.
 */
function removeTopLevelProperty(text, propertyName) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  if (!hasOwn(parsed, propertyName)) return undefined

  const object = topLevelMembers(text)
  if (object === undefined) return undefined
  const kept = object.members
    .filter((member) => member.key !== propertyName)
    .map((member) => text.slice(member.start, member.end))
  return text.slice(0, object.open + 1) + kept.join(',') + text.slice(object.close)
}

function contentLengthAdjusted(headers, text) {
  if (!headers.has('content-length')) return false
  headers.set('content-length', String(byteLength(text)))
  return true
}

function recordEvidence(entry) {
  try {
    try {
      if (statSync(EVIDENCE_PATH).size > EVIDENCE_MAX_BYTES) {
        renameSync(EVIDENCE_PATH, `${EVIDENCE_PATH}.1`)
      }
    } catch {}
    appendFileSync(EVIDENCE_PATH, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {}
}

/** Origin and path only: a logged URL never carries a query or fragment. */
function safeLoggedUrl(raw) {
  try {
    const url = new URL(raw)
    return `${url.origin}${url.pathname}`
  } catch {
    return ''
  }
}

function remainingSessionHeaderNames(headers) {
  const names = []
  for (const name of headers.keys()) {
    if (/session|client-request-id/i.test(name)) names.push(name)
  }
  return names.sort()
}

/**
 * Rewrite only the already-built xingchiapi Responses request. The OpenAI SDK
 * has merged model defaults, profile headers, authentication, and session
 * affinity before this fetch boundary is reached, so nothing above can add the
 * removed fields back.
 */
async function sanitizeRequest(input, init) {
  const headers = mergedHeaders(input, init)
  const removedHeaders = []
  for (const headerName of REMOVED_HEADERS) {
    if (headers.has(headerName)) {
      headers.delete(headerName)
      removedHeaders.push(headerName)
    }
  }

  const text = await requestBodyText(input, init)
  let nextBody
  let removedBodyProperty = false
  if (text !== undefined) {
    let candidate = text
    for (;;) {
      const cleaned = removeTopLevelProperty(candidate, REMOVED_BODY_PROPERTY)
      if (cleaned === undefined || cleaned === candidate) break
      candidate = cleaned
      removedBodyProperty = true
    }
    if (removedBodyProperty) nextBody = candidate
  }

  const adjustedContentLength = removedBodyProperty
    ? contentLengthAdjusted(headers, nextBody)
    : false

  return {
    changed: removedHeaders.length > 0 || removedBodyProperty,
    init: {
      ...(init ?? {}),
      headers,
      ...(removedBodyProperty ? { body: nextBody } : {}),
    },
    evidence: {
      at: new Date().toISOString(),
      url: safeLoggedUrl(requestUrl(input)),
      method: requestMethod(input, init),
      headerNames: [...headers.keys()].sort(),
      removedHeaders,
      bodyReadable: text !== undefined,
      bodyBytesBefore: text === undefined ? null : byteLength(text),
      bodyBytesAfter: nextBody === undefined ? null : byteLength(nextBody),
      promptCacheKeyRemoved: removedBodyProperty,
      contentLengthAdjusted: adjustedContentLength,
      preservedSessionHeaders: remainingSessionHeaderNames(headers),
    },
  }
}

export function apply(ctx, config) {
  const enabled = config?.enabled !== false
  if (!enabled) {
    ctx.logger?.info?.('xingchiapi Responses cleanup disabled by configuration')
    return
  }

  ctx.effect(() => {
    const originalFetch = globalThis.fetch
    if (typeof originalFetch !== 'function') {
      throw new Error('xingchiapi Responses cleanup requires global fetch')
    }

    let active = true
    const wrappedFetch = async function xingchiapiResponsesFetch(input, init) {
      if (!active || !isTargetRequest(input, init)) {
        return originalFetch.call(this, input, init)
      }

      const rewritten = await sanitizeRequest(input, init)
      if (!rewritten.changed) {
        return originalFetch.call(this, input, init)
      }

      try {
        const response = await originalFetch.call(this, input, rewritten.init)
        recordEvidence({
          ...rewritten.evidence,
          status: response.status,
          contentType: response.headers.get('content-type'),
        })
        return response
      } catch (error) {
        recordEvidence({
          ...rewritten.evidence,
          status: null,
          error: error instanceof Error ? error.name : typeof error,
          errorCode: error instanceof Error && error.cause !== null && typeof error.cause === 'object'
            ? error.cause.code
            : undefined,
        })
        throw error
      }
    }

    globalThis.fetch = wrappedFetch
    ctx.logger?.info?.('xingchiapi Responses cleanup enabled')

    return () => {
      active = false
      if (globalThis.fetch === wrappedFetch) {
        globalThis.fetch = originalFetch
      } else {
        ctx.logger?.warn?.('xingchiapi Responses cleanup left a later fetch wrapper installed')
      }
    }
  })
}
