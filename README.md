# next-prompt — inline ghost-text next-prompt suggestions for pi

A pi coding-agent extension that, after an agent turn fully settles and the input
editor is empty, computes the single most logical next instruction you'd type and
shows it as **inline greyed ghost text** after the caret.

- **Tab** (when the autocomplete dropdown is closed) → accept the suggestion.
- **Any other key** → dismiss the ghost immediately; it's re-armed from the last
  computed suggestion when you backspace down to empty (no new model call).
- **No ghost while streaming** — only when the agent is idle and the editor is empty.
- **No stale suggestions** — the ghost is cleared and any in-flight model call aborted
  the instant you submit, start a new turn, or the agent starts.

The built-in `addAutocompleteProvider` API only produces a dropdown; it cannot do inline
ghost text, so this extension replaces the editor via `setEditorComponent` + a thin
`CustomEditor` subclass that overlays the suggestion in `render(width)`.

## Install

This repo lives at `/home/gabi/Devel/Personal/next-prompt-extension/` and is wired into
pi via a symlink (no copy, no install):

```bash
ln -sfn /home/gabi/Devel/Personal/next-prompt-extension/next-prompt.ts \
        ~/.pi/agent/extensions/next-prompt.ts
```

Pi auto-discovers `~/.pi/agent/extensions/*.ts` globally. Restart `pi` (or start a new
session) and the extension loads.

To develop, just edit `next-prompt.ts` in place — the symlink picks up changes on the
next session start. Run the tests:

```bash
cd /home/gabi/Devel/Personal/next-prompt-extension
bun test
```

> The local `node_modules/@earendil-works/*` are symlinks to the globally-installed pi
> packages (so the TypeScript LSP resolves imports). They're git-ignored; nothing is
> downloaded.

## Config

All fields optional. Merged global + project (project overrides global on key
collisions):

- Global: `~/.pi/agent/next-prompt.json`
- Project: `<cwd>/.pi/next-prompt.json`

```json
{
  "model": { "provider": "anthropic", "model": "claude-haiku-4-5" },
  "systemPrompt": "...override the default extractor prompt...",
  "maxTranscriptChars": 12000,
  "maxSuggestionChars": 240,
  "debounceMs": 400,
  "allowCrossProvider": true
}
```

| Field | Default | Notes |
| --- | --- | --- |
| `model` | current model (`ctx.model`) | The model used to generate the suggestion. If the configured model isn't found, pi notifies once (`warning`) and falls back to the current model. |
| `systemPrompt` | built-in extractor | See `SYSTEM_PROMPT` in `next-prompt.ts`. |
| `maxTranscriptChars` | `12000` | Tail-truncation of the conversation transcript sent to the model. |
| `maxSuggestionChars` | `240` | Cap on the returned suggestion length. |
| `debounceMs` | `400` | Largely redundant with the `agent_settled` trigger; reserved. |
| `allowCrossProvider` | `true` | When `false`, fall back to the current model if the configured suggestion model is on a **different** provider than the active one. See Security below. |

## Security: cross-provider transcript disclosure

The extension sends the conversation transcript (user + assistant text only — tool
results, thinking blocks, and tool-call arguments are skipped) to the suggestion
model. This is **no more** than what the active model already saw **if** the
suggestion model is the same provider/model. If you configure a suggestion model on a
**different** provider (e.g. active = Claude, suggestion = OpenAI), the transcript is
sent to that second provider, which may have different data-handling terms.

Mitigations:

- `buildTranscript` redacts obvious high-entropy secrets (AWS `AKIA…`, OpenAI `sk-…`,
  GitHub `ghp_…`, Slack `xoxb-…`, PEM private key blocks) before sending. This is
  defense-in-depth, not a guarantee — the active model may already have seen secrets in
  the turn, and the model may quote file contents in its text.
- Set `"allowCrossProvider": false` to force same-provider suggestions silently.
- The redaction patterns are in `redactSecrets()`; extend them if you handle other
  secret formats.

## How it works

1. On `session_start`, `setEditorComponent` installs a `NextPromptEditor` that wraps
   the default editor.
2. On `agent_settled` (one event per user-initiated turn, after the agent is truly
   idle), if the editor is empty, the controller calls
   `ctx.modelRegistry.complete(model, { systemPrompt, messages }, { signal })` with the
   resolved model and the (redacted, tail-truncated) transcript.
3. The returned text is sanitized (trimmed, de-quoted, de-fenced, collapsed to one
   line, capped) and shown as ghost text via `setGhost`.
4. `decideInput` (a pure function — unit-tested in isolation) decides what each
   keystroke does: Tab-accept (only when autocomplete is closed), dismiss-on-any-other
   key, re-arm-on-backspace-to-empty.
5. `overlayGhost` (pure) inserts the ghost as raw ANSI dim text (`\x1b[2m…\x1b[22m`)
   immediately after the cursor block, preserving the `CURSOR_MARKER`→cursor offset for
   IME safety, and bails when the editor is unfocused (no marker emitted).

## Design doc

See [`PLAN.md`](./PLAN.md) for the full oracle-reviewed design, including the audit
trail of 9 blockers found and fixed during adversarial review.

## License

MIT.
