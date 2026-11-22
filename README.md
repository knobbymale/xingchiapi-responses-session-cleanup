# xingchiapi Responses session cleanup

A standalone, toggleable DSH Host plugin. It rewrites only the final outgoing `POST https://api.xingchiapi.com/v1/responses` request, after the OpenAI SDK has merged model defaults, provider/profile headers, authentication, and pi-ai's session-affinity headers.

When enabled, it removes exactly these fields from the upstream request:

- every session-affinity header: `session-id`, `x-session-id`, `session_id`, `x-client-request-id`, and `x-session-affinity`
- the top-level JSON body property `prompt_cache_key` (including duplicate occurrences)

It does not touch authorization headers, the upstream URL, streaming responses, tool definitions or calls, or any other provider's requests. Other JSON values are preserved; when the body is rewritten, it is serialized back as compact JSON. If the body is not a JSON object, only the targeted headers are removed.

## Automatic history trim

xingchiapi counts conversation turns from the `input` array, not from a header. When a request reaches **95 user turns** (95% of the provider's 100-turn limit), the plugin trims the history before sending:

- it keeps all leading system/developer items, the **first task turn**, and the **most recent 93 turns**;
- it replaces the omitted turns with one user-role digest message that lists the most recent 20 dropped user requests (160 characters each);
- whole turns are dropped, so a `function_call` and its `function_call_output` are never separated;
- previous digest messages are removed and carried forward, so they do not accumulate as extra turns;
- the resulting request has **95 user turns**, which is the maximum context that leaves a five-turn margin below the hard limit.

The trim is lossy: older tool outputs and discussion details are gone, and only a short digest of the dropped user requests remains. A session that already exceeds 100 turns is repaired on its next request. The defaults favour model quality; lower `targetTurns` if you want a smaller and cheaper request.

## Configuration

The bundle page in **Plugins** exposes a validated configuration form:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Enable the cleanup and automatic trim. The bundle-row toggle is the primary switch. |
| `autoTrim` | `true` | Trim history at the trigger. Set `false` to keep headers-only cleanup. |
| `turnLimit` | `100` | Provider turn limit, used for the trigger/target defaults and the digest text. |
| `triggerTurns` | `95` | Start trimming at this many user turns. |
| `targetTurns` | `95` | Keep at most this many user turns. The default is the maximum context under a 95% trigger. |
| `keepFirstTurn` | `true` | Keep the first task turn so the original goal survives. |
| `digestTurns` | `20` | How many dropped user turns the digest summarizes. |
| `digestChars` | `160` | Maximum characters per digest line. |

For example, to reduce cost while keeping 60 turns:

```yaml
config:
  triggerTurns: 80
  targetTurns: 60
```

To retain even more context, raise both up to `99`; values above the trigger are clamped to the trigger.

## Why remove `session_id` too?

xingchiapi enforces two different counters, and they need different fixes:

- `session_request_limit_exceeded`: **100 upstream requests per session identifier**. pi-ai sends the DSH Session id as `session_id` and `x-client-request-id`; removing only `prompt_cache_key` left those headers in place, so the proxy kept counting against the same upstream session. Stripping the affinity headers makes every request a fresh upstream session and resets this counter.
- `session_turn_limit_exceeded`: **100 turns in the conversation history carried by the request**. That count comes from the `input` messages, not from a header. The automatic history trim above reduces a request to 95 user turns by default before it is sent.

A real DSH session illustrates both: it reached `session_request_limit_exceeded` exactly at upstream request 100, then reached `session_turn_limit_exceeded` when its history contained more than 100 user-role turns. With `targetTurns: 80`, the same session resumed successfully: its next request was trimmed from 117 to 80 user turns and returned `200 text/event-stream`.

The trade-off of removing the affinity headers is intentional: no upstream session affinity or prompt-cache reuse. The rewrite happens at the global `fetch` boundary used by the OpenAI SDK, which is the last point before network I/O. A later DSH plugin cannot put these fields back, because no header or body merging runs after this point.

## Install from GitHub

The package is not published to npm; install it from its Git repository.

1. Create a public repository whose **root** contains this folder's `package.json`, `index.js`, `cordis.patch.yml`, `locale/`, and `icon.svg`. Upload the folder's contents, not an extra nested folder.
2. In DSH open **Plugins → Add plugin**, paste the repository URL, for example:

   ```text
   https://github.com/OWNER/xingchiapi-responses-cleanup
   ```

   The Host checks the Git host, installs the package with pnpm, and selects the bundle.
3. If the bundle is installed but not running, enable the **xingchiapi Responses session cleanup** row in Plugins.

From a terminal, the package can also be added with the profile's pnpm forwarder:

```sh
dsh plugin --profile <profile> add https://github.com/OWNER/xingchiapi-responses-cleanup
```

That command installs the package and selects its bundle; enable the **xingchiapi Responses session cleanup** row in Plugins if it is not running.

## Toggle

Enable or disable the **xingchiapi Responses session cleanup** row in DSH's Plugins list. Disabling the row unloads the wrapper and restores the previous `fetch`. The bundle page also renders the configuration form above; an explicit `enabled: false` has the same effect as disabling the row.

## Diagnostic trail

When a sanitized request is sent, the plugin appends one JSON line to the OS temp directory:

`%TEMP%\dsh-xingchiapi-responses-cleanup.log`

Each line records the URL, method, final header **names**, which targeted headers were removed, body byte counts, whether `prompt_cache_key` was removed, whether history was trimmed, the user-turn counts before/after the trim, how many turns were dropped, which session-related header names remain, the upstream HTTP status, and the response content type. It never records header values, prompts, credentials, or response content. The file rotates to `.1` at 512 KiB.

## Scope and limitations

- The endpoint match is exact: HTTPS host `api.xingchiapi.com`, path `/v1/responses`. Changing the route's `baseURL` or API mode requires updating `TARGET_HOSTNAME`/`TARGET_PATH`.
- The wrapper only matches `POST`; model discovery and other requests are untouched.
- If the request body is a non-readable stream rather than a string/buffer, the body is left unchanged while the targeted headers are still removed.
- The history trim is lossy and applies to this provider only. It drops whole turns, keeps the first task turn and the recent 93 turns by default, and preserves tool call/output pairing, but it cannot preserve every old detail. A large retained window still costs tokens; lower `targetTurns` to trade context for cost.

## Verification

Verified with real DSH sessions (headless DSH process, xingchiapi route, `gpt-6.1-sol`): consecutive upstream requests returned `200 text/event-stream`, a `read` tool call completed, and the final answer quoted the tool result. The diagnostic trail showed `prompt_cache_key` removed and every session-affinity header removed, including `session_id` and `x-client-request-id`; `authorization` remained. A separate run injected `session-id`/`x-session-id` through provider `headers`; all spellings were removed at the final boundary while an unrelated probe header survived.

The history trim was verified end-to-end with `targetTurns: 80` on the real failing session `session-39d0180c-...`: its next request had **117 user turns**, was trimmed to **80** (38 turns dropped), returned `200 text/event-stream`, and the model produced a coherent continuation of the prior audit. That request used 324,331 input tokens, so trimming reduces the turn count rather than the token bill. The default `targetTurns: 95` uses the same algorithm and was observed trimming **118 to 95** (24 turns dropped, five-turn margin); its end-to-end retest coincided with an upstream `503 Service temporarily unavailable`, so recheck it when the provider is healthy.

