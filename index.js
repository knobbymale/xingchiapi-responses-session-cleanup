import { appendFileSync, renameSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

export const name = 'xingchiapi-responses-cleanup'

/**
 * Configuration defaults favour model quality: keep as much history as the
 * provider's 100-turn cap allows. Trimming starts at 95% and the target is the
 * same 95 turns, leaving five turns of headroom.
 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true)
    .description('Enable the cleanup and automatic history trim.'),
  autoTrim: Schema.boolean().default(true)
    .description('Trim conversation history when it reaches the trigger.'),
  turnLimit: Schema.natural().min(10).default(100)
    .description('Provider turn limit (xingchiapi: 100).'),
  triggerTurns: Schema.natural().min(1).default(95)
    .description('Start trimming at this many user turns (default 95%).'),
  targetTurns: Schema.natural().min(1).default(95)
    .description('Keep at most this many user turns after trimming (default: maximum context).'),
  keepFirstTurn: Schema.boolean().default(true)
    .description('Keep the first task turn so the original goal survives trimming.'),
  digestTurns: Schema.natural().default(20)
    .description('How many dropped user turns the digest summarizes.'),
  digestChars: Schema.natural().default(160)
    .description('Maximum characters per digest line.'),
})

/** The configured xingchiapi Responses endpoint (baseURL `.../v1` + `/responses`). */
const TARGET_HOSTNAME = 'api.xingchiapi.com'
const TARGET_PATH = '/v1/responses'

/**
 * Session identifiers that must not reach the xingchiapi upstream.
 *
 * pi-ai's Responses adapter sends the DSH Session id as `session_id` and
 * `x-client-request-id`; a client or provider profile may also add the
 * hyphenated spellings. xingchiapi counts upstream requests against whichever
 * of these it sees and rejects the 101st with `session_turn_limit_exceeded`,
 * so every spelling has to go.
 */
const REMOVED_HEADERS = [
  'session-id',
  'x-session-id',
  'session_id',
  'x-client-request-id',
  'x-session-affinity',
]

/** Top-level JSON body property removed from the final upstream request. */
const REMOVED_BODY_PROPERTY = 'prompt_cache_key'

/**
 * xingchiapi's history limit is 100 conversation turns. The default settings
 * start trimming at 95% and keep 95 turns, which is the most context the
 * provider accepts with a safe margin. Every value is configurable.
 */
const DIGEST_PREFIX = '[DSH xingchiapi history cleanup:'

function resolveSettings(config) {
  const turnLimit = Math.max(2, Math.trunc(config?.turnLimit ?? 100))
  const triggerTurns = Math.min(
    turnLimit - 1,
    Math.max(1, Math.trunc(config?.triggerTurns ?? Math.floor(turnLimit * 0.95))),
  )
  const targetTurns = Math.min(
    triggerTurns,
    Math.max(1, Math.trunc(config?.targetTurns ?? triggerTurns)),
  )
  const keepFirstTurn = config?.keepFirstTurn !== false
  return {
    autoTrim: config?.autoTrim !== false,
    turnLimit,
    triggerTurns,
    // The digest always occupies one turn; keeping the first task turn needs
    // one more. A target below that is clamped to the two fixed turns.
    targetTurns: Math.max(targetTurns, 1 + (keepFirstTurn ? 1 : 0)),
    keepFirstTurn,
    digestTurns: Math.max(0, Math.trunc(config?.digestTurns ?? 20)),
    digestChars: Math.max(0, Math.trunc(config?.digestChars ?? 160)),
  }
}

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

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

function inputText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part !== null && typeof part === 'object' && (part.type === 'input_text' || part.type === 'text'))
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('\n')
}

/**
 * Split the Responses input array into leading non-user items (system prompt,
 * tool declarations) and complete turns. A turn starts at a user-role item and
 * includes every following assistant/tool item until the next user item, so
 * dropping whole turns cannot orphan a function call from its output.
 */
function splitTurns(input) {
  const leading = []
  let index = 0
  while (index < input.length && input[index]?.role !== 'user') {
    leading.push(input[index])
    index++
  }
  const turns = []
  while (index < input.length) {
    const start = index
    index++
    while (index < input.length && input[index]?.role !== 'user') index++
    turns.push(input.slice(start, index))
  }
  return { leading, turns }
}

function digestText(dropped, priorDigests, settings) {
  const snippets = []
  for (const turn of dropped) {
    const text = inputText(turn[0]?.content).replace(/\s+/g, ' ').trim()
    if (text.length > 0) snippets.push(text)
  }
  const shown = settings.digestTurns === 0 ? [] : snippets.slice(-settings.digestTurns)
  const lines = []
  for (const text of shown) {
    const line = text.slice(0, settings.digestChars)
    if (line.length > 0) lines.push(`- ${line}`)
  }
  const header = dropped.length === 0
    ? `${DIGEST_PREFIX} earlier cleanup summary retained; newer turns follow.]`
    : `${DIGEST_PREFIX} ${dropped.length} older turns were omitted to stay under the provider's ${settings.turnLimit}-turn limit.`
  const parts = [header]
  if (lines.length > 0) {
    parts.push(`The most recent omitted user requests were:\n${lines.join('\n')}`)
  }
  if (priorDigests.length > 0) {
    const carried = priorDigests.join('\n').slice(-2000)
    parts.push(`Earlier cleanup summary carried forward:\n${carried}`)
  }
  parts.push('Continue from the first task message and the recent turns below.]')
  return parts.join('\n')
}

/**
 * Keep the first task turn and as many recent turns as the configured target
 * allows when the request reaches the trigger. Whole turns are dropped, so a
 * function call and its output stay together. Previous digest messages are
 * replaced and carried forward instead of accumulating as extra turns.
 */
function trimHistory(input, settings) {
  const { leading, turns: rawTurns } = splitTurns(input)
  const before = rawTurns.length
  if (!settings.autoTrim) {
    return { input, trimmed: false, before, after: before, dropped: 0 }
  }
  if (before < settings.triggerTurns) {
    return { input, trimmed: false, before, after: before, dropped: 0 }
  }

  const priorDigests = []
  const turns = []
  for (const turn of rawTurns) {
    const text = inputText(turn[0]?.content).trim()
    if (text.startsWith(DIGEST_PREFIX)) priorDigests.push(text)
    else turns.push(turn)
  }

  const first = settings.keepFirstTurn && turns.length > 0 ? turns[0] : undefined
  const bodyTurns = settings.keepFirstTurn ? turns.slice(1) : turns
  const fixed = (first === undefined ? 0 : 1) + 1
  const recentCount = Math.max(0, settings.targetTurns - fixed)
  const recent = recentCount === 0 ? [] : bodyTurns.slice(-recentCount)
  const dropped = bodyTurns.slice(0, Math.max(0, bodyTurns.length - recentCount))

  if (dropped.length === 0 && priorDigests.length === 0) {
    return { input, trimmed: false, before, after: before, dropped: 0 }
  }

  const digest = {
    role: 'user',
    content: [{ type: 'input_text', text: digestText(dropped, priorDigests, settings) }],
  }
  return {
    input: [...leading, ...(first === undefined ? [] : first), digest, ...recent.flat()],
    trimmed: true,
    before,
    after: fixed + recent.length,
    dropped: dropped.length,
  }
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
async function sanitizeRequest(input, init, settings) {
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
  let history = { before: null, after: null, trimmed: false, dropped: 0 }
  if (text !== undefined) {
    const parsed = parseJsonObject(text)
    if (parsed !== undefined) {
      if (hasOwn(parsed, REMOVED_BODY_PROPERTY)) {
        delete parsed[REMOVED_BODY_PROPERTY]
        removedBodyProperty = true
      }
      if (Array.isArray(parsed.input)) {
        const result = trimHistory(parsed.input, settings)
        if (result.trimmed) parsed.input = result.input
        history = {
          before: result.before,
          after: result.after,
          trimmed: result.trimmed,
          dropped: result.dropped,
        }
      }
      if (removedBodyProperty || history.trimmed) nextBody = JSON.stringify(parsed)
    }
  }

  const bodyChanged = removedBodyProperty || history.trimmed
  const adjustedContentLength = bodyChanged ? contentLengthAdjusted(headers, nextBody) : false

  return {
    changed: removedHeaders.length > 0 || bodyChanged,
    init: {
      ...(init ?? {}),
      headers,
      ...(bodyChanged ? { body: nextBody } : {}),
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
      historyTrimmed: history.trimmed,
      userTurnsBefore: history.before,
      userTurnsAfter: history.after,
      droppedTurns: history.dropped,
      historyTriggerTurns: settings.triggerTurns,
      historyTargetTurns: settings.targetTurns,
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
  const settings = resolveSettings(config)

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

      const rewritten = await sanitizeRequest(input, init, settings)
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
