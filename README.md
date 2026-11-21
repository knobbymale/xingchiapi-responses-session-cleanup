# xingchiapi Responses session cleanup

A standalone, toggleable DSH Host plugin. It rewrites only the final outgoing `POST https://api.xingchiapi.com/v1/responses` request, after the OpenAI SDK has merged model defaults, provider/profile headers, authentication, and pi-ai's session-affinity headers.

When enabled, it removes exactly these fields from the upstream request:

- `session-id` and `x-session-id` headers, matched case-insensitively
- the top-level JSON body property `prompt_cache_key` (including duplicate occurrences)

It does not touch `session_id` (underscore), `x-client-request-id`, authorization headers, the upstream URL, streaming responses, tool definitions or calls, or any other provider's requests. Other body fields keep their original JSON values; the body is edited in place instead of being reserialized. If the body is not a JSON object, only the targeted headers are removed.

The pi-ai Responses adapter in the current DSH build sends `session_id` and `x-client-request-id` (both derived from the DSH Session id). Those stay in place by design; the two hyphenated names are removed whenever a client or provider profile adds them.

The rewrite happens at the global `fetch` boundary used by the OpenAI SDK, which is the last point before network I/O. A later DSH plugin cannot put these fields back, because no header or body merging runs after this point.

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

Enable or disable the **xingchiapi Responses session cleanup** row in DSH's Plugins list. Disabling the row unloads the wrapper and restores the previous `fetch`. An explicit `enabled: false` in the row configuration has the same effect.

## Diagnostic trail

When a sanitized request is sent, the plugin appends one JSON line to the OS temp directory:

`%TEMP%\dsh-xingchiapi-responses-cleanup.log`

Each line records the URL, method, final header **names**, which targeted headers were removed, body byte counts, whether `prompt_cache_key` was removed, which session-related header names remain, the upstream HTTP status, and the response content type. It never records header values, prompts, credentials, or response content. The file rotates to `.1` at 512 KiB.

## Scope and limitations

- The endpoint match is exact: HTTPS host `api.xingchiapi.com`, path `/v1/responses`. Changing the route's `baseURL` or API mode requires updating `TARGET_HOSTNAME`/`TARGET_PATH`.
- The wrapper only matches `POST`; model discovery and other requests are untouched.
- If the request body is a non-readable stream rather than a string/buffer, the body is left unchanged while the targeted headers are still removed.

## Verification

Verified with a real DSH session (headless DSH process, xingchiapi route, `gpt-6.1-sol`): two consecutive upstream requests returned `200 text/event-stream`, a `read` tool call completed, and the final answer quoted the tool result. The diagnostic trail showed `prompt_cache_key` removed and the body exactly 66 bytes shorter (the removed fragment); `session_id`, `x-client-request-id`, and `authorization` remained. A second run added `session-id`/`x-session-id` through provider `headers`; both were removed at the final boundary while an unrelated probe header survived.

