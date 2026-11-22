# Changelog

## 1.5.0

- Expose the trim behavior through a validated plugin configuration form:
  `enabled`, `autoTrim`, `turnLimit`, `triggerTurns`, `targetTurns`,
  `keepFirstTurn`, `digestTurns`, and `digestChars`.
- Change the default target from 80 to 95 user turns so the default keeps the
  maximum context below the provider's 100-turn cap.
- Replace prior digest messages instead of accumulating them, and carry their
  summary forward into the new digest.
- Add `@deepseek-ai/schemastery` as a package dependency for the Config schema.

## 1.4.0

- Add automatic history trimming for xingchiapi Responses requests. At 95 user
  turns, keep the first task turn and the most recent 78 turns, replace the
  omitted turns with a compact digest, and send at most 80 user turns.
- Drop whole turns only, so function calls and their outputs stay paired.
- Verified on the real failing session `session-39d0180c-...`: 117 turns were
  trimmed to 80, the upstream returned `200 text/event-stream`, and the model
  produced a coherent continuation (324,331 input tokens).
- Document that trimming is lossy and does not reduce the token cost of a large
  retained window.

## 1.3.0

- Remove every session-affinity header for the xingchiapi Responses route:
  `session-id`, `x-session-id`, `session_id`, `x-client-request-id`, and
  `x-session-affinity`.
- Reset xingchiapi's `session_request_limit_exceeded` counter (100 requests per
  session identifier). Preserving `session_id` and `x-client-request-id` kept
  that counter attached to the original conversation even after
  `prompt_cache_key` was removed.
- Document that xingchiapi's separate `session_turn_limit_exceeded` counter
  (100 turns in the request history) is content-based and cannot be fixed by
  header removal; compact the session or start a new one.
- Trade-off: no upstream session affinity or prompt-cache reuse.

## 1.2.0

- Package the plugin for GitHub distribution: MIT license, changelog, install
  instructions, and a clean publish file list.
- Keep the final-boundary rewrite and diagnostic trail from 1.1.0.
- Handle an explicit `body: null` request without reading an inherited Request
  body.

## 1.1.0

- Move cleanup to the global `fetch` boundary used by the OpenAI SDK, after
  provider headers, authentication, and session affinity are merged.
- Remove `session-id`, `x-session-id`, and the top-level `prompt_cache_key`
  only for the xingchiapi Responses endpoint.
- Add the temp-directory diagnostic trail and the standalone bundle toggle.

## 1.0.0

- Initial Host-only bundle.
