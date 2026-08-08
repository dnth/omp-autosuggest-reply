# Manual TUI smoke tests — next-prompt

Terminal-rendering and live-interaction behavior cannot be fully verified in
unit tests (the automated suite covers the editor/rendering contracts via real
pi-tui `Editor`/`CustomEditor` integration tests, but not a live terminal).
Before any release, run every check below in a real pi session (0.84.0+,
ideally on **at least two terminal emulators**) and record the result.

**Status legend:** `[ ]` not run · `[x]` passed · `[!]` failed (blocker: fix
before release, note the failure)

Record date, pi version, terminal emulators, and any failures at the bottom.

## Render modes

- [ ] `widget`, `ghost`, and `both` render correctly at narrow and wide
  terminal sizes; no border corruption, no overflow past the editor width.
- [ ] In `ghost`/`both`, the greyed ghost appears after the caret only when the
  editor is empty; with text present the editor is never clobbered.
- [ ] Switch terminal/app focus while a ghost is visible (unfocused editor):
  ghost still renders within the box, no overflow or corrupted styling.

## Input state machine (default key `Alt-/`)

Run each sequence in `widget`, `ghost`, and `both`:

- [ ] settle → show → non-accept printable key → all UI clears immediately;
- [ ] settle → show → Escape/arrow → clear with no later re-arm;
- [ ] settle → show → accept → editor fills exactly once, key is swallowed
  (no `/` typed);
- [ ] accept → edit but do not submit → delete back to empty → the last
  suggestion re-appears after `rearmDelayMs` (no new model call);
- [ ] accept → submit → next turn returns `NONE`/error → the old suggestion
  never re-arms;
- [ ] pending completion → type → delete-to-empty → resolve old completion →
  nothing renders;
- [ ] pending completion → session switch/shutdown → resolve → nothing
  renders (no consent persisted, no model call);
- [ ] delete-to-empty after dismissing with Escape does NOT re-arm.

## Autocomplete / conflicting keys

- [ ] Slash/path autocomplete still works (Tab, up/down, Enter) while a
  suggestion is showing or dismissed; accepting the suggestion never steals
  autocomplete input.
- [ ] Configure `"acceptKey": "tab"` → extension warns and ignores it;
  Tab continues to drive autocomplete and never fills the editor.

## Editor integration

- [ ] IME input and wide Unicode cursor placement (CJK/emoji) work with the
  ghost installed; the cursor block stays on the correct grapheme.
- [ ] History browsing (up/down), undo, kill-ring, and paste behave normally
  with the ghost editor installed.
- [ ] Run `/reload`, `/new`, `/resume`, `/fork`, and `/clone`; acceptance and
  rendering continue without duplicate listeners or double-installed editors
  (no double ghost/widgets, no doubled accept key).
- [ ] Run alongside another custom-editor extension; both behaviors remain
  available or next-prompt falls back to widget mode with a clear warning.

## Model / lifecycle error paths

- [ ] Model error, abort, `NONE`, length stop, slow completion, and provider
  switch behave: no stale suggestion renders, no spurious error notify on
  abort.
- [ ] First cross-destination request requires a clear consent dialog naming
  the destination and transcript size; denial results in **no** request and no
  re-prompt for the session; grant persists across sessions and a route change
  re-prompts.
- [ ] Run print/JSON/RPC modes and confirm no hidden suggestion request
  occurs.

## Record

- Date:
- pi version(s):
- Terminal emulators:
- Results / failures:
