# Changelog

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
