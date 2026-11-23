# makefun-mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sichyo03/makefun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sichyo03/makefun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Entry for the make.fun bounty **"Build mend, one patch tool for every AI
edit format"** (`hidden-spec-cli-01-run-20261122`, $100 total, places 1–10
get $10 each). Deadline **2026-11-24T14:00:00Z (24 November 21:00 WIB)**.

`main.ts` is a CLI that applies AI-written edits in all four formats to a
tree of files, exactly as `SPEC.md` (version 1, in the kit's `starter/`)
says: unified diffs (often with wrong line numbers), SEARCH/REPLACE
blocks, V4A patches, and JSON text-editor tool calls. It finds lines an
edit names even when whitespace/indentation drifted, and it changes every
file or none of them (all-or-nothing).

Node 22, standard library alone, no installs, no network, no WASM, no
model calls. Deterministic: no times or randomness in the output.

## Run it

```sh
node main.ts [options] [PATCH]
```

## Files

Submission (the public GitHub repo should contain exactly these):

| File | What it is |
| --- | --- |
| `main.ts` | The entry. Run as `node main.ts [options] [PATCH]`. |
| `runner.ts` | The kit's trial runner, copied unchanged. In a trial the grader runs `node /bot/main.ts` with `MAKEFUN_ENV_URL` set and `main.ts` hands over to it. |
| `README.md` | This file. |
| `LICENSE` | MIT, from the kit starter. |

Local-only (kept in the work directory, not part of the submission):

| File | What it is |
| --- | --- |
| `check.ts` | The kit's practice-check runner, copied unchanged. |
| `test-edge.mjs` | My own edge-case suite (123 cases) for sentences the practice set does not show. |
| `hidden-spec-cli-01-run-20261122-kit/` | The unpacked kit (SPEC.md, practice set, generator, scorer). |
| `kit.tar.gz` | The kit as downloaded. |

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is a path relative to the tree root; absent or `-` means stdin.
- `--format` is `unified`, `search-replace`, `v4a`, `json`, or `auto`
  (default). A named format is read as that format whatever the text
  holds; `auto` detects in the order v4a, json, search-replace, unified.
- `--check` does everything but write. `--strict` matches exactly
  (tier 0 only). Options and `PATCH` may come in any order; `--` ends
  options.

Exit codes and stdout, per SPEC.md:

- Exit 2, one line, nothing written: `error: usage`, `error: no-patch`,
  `error: format`, or `error: parse <N>`.
- Exit 1, nothing written: one line `error: <code> <path>` per failed
  edit in patch order, then `failed: <k> of <n> edits`. Codes:
  `no-match`, `ambiguous`, `missing`, `exists`, `unsafe`.
- Exit 0, every change written (unless `--check`): one line per changed
  path in byte order (UTF-8) — `A <path>`, `D <path>`, `M <path>`,
  `R <old> -> <new>` for a successful move — then `ok: <n> files`
  (or `ok: 1 file`).

## How it works

- **Line matching (SPEC §5).** An old block is found at the first of
  three tiers at which it occurs at least once: tier 0 every line equal,
  tier 1 every line equal once trailing spaces/tabs are removed, tier 2
  every line equal once leading and trailing spaces/tabs are removed.
  `--strict` tries tier 0 only. A context line is written as the file's
  own matched line, never the patch's; at tier 2 every other new line is
  re-indented from the old block's first-line indent to the file's.
- **Unified diffs (SPEC §6).** Sections start at `diff --git` or at a
  `--- ` line followed by a `+++ ` line. Paths come from the `---`/`+++`
  pair, else `rename from`/`rename to`, else the `diff --git` paths.
  Hunks apply in order to the result of the ones before them; a hunk
  takes the occurrence nearest to `A - 1 + d`, where `d` is the net line
  shift of the hunks applied so far, ties going to the earlier. An empty
  old block inserts after the first `A + d` lines. Creation, deletion and
  moves are handled; a created file ends with a line break unless a `\`
  line follows its last `+` line.
- **SEARCH/REPLACE (SPEC §7).** The path is the nearest non-blank,
  non-fence line before the SEARCH line; a block with no such line takes
  the previous block's path. Old lines must occur exactly once at their
  tier, else `ambiguous`; empty old lines create the file.
- **V4A (SPEC §8).** Sections are `*** Add File:`, `*** Delete File:`,
  `*** Update File:` (with an optional `*** Move to:` first line).
  Chunks apply in order with a cursor: an `@@` anchor moves the cursor
  past its first occurrence at or after the cursor, and each chunk takes
  the first occurrence of its old lines at or after the cursor. An
  `*** End of File` chunk takes only an occurrence ending at the file's
  last line.
- **JSON (SPEC §9).** One JSON array of edit objects, or JSON Lines.
  `create` writes `file_text` byte for byte; `str_replace` needs exactly
  one occurrence (positions may overlap); `insert` inserts after line
  `insert_line` (0 is the top). In a CRLF file, text and both strings are
  read with every `\r\n` as `\n` and written back with `\r\n`.
- **Order and atomicity (SPEC §10).** Edits apply in patch order to the
  tree as earlier edits left it; a failed edit changes nothing and the
  edits after it still run; when any edit failed, no file is written. A
  move is reported as `R` only when the old path existed before the patch
  and does not after it, and the new path did not exist before it and
  does after it.

## How to test locally

From this directory:

```sh
# Kit practice checks (100 checks: unified 30, search-replace 20,
# v4a 20, json 15, cli 15):
node check.ts hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json

# My edge-case suite (123 cases: fuzzy matching, wrong line numbers,
# whitespace drift, ambiguous matches, multi-file atomicity, malformed
# input, exit codes, stdout exactness):
node test-edge.mjs
```

## Test results

- **Practice checks: 100 of 100 passed — practice score 1000.**
  (Starter baseline was 24 of 100, score 240.)
- **Edge-case suite: 123 of 123 passed.**

## Spec ambiguities resolved

Judgment calls made where SPEC.md left room, each covered by a case in
`test-edge.mjs`:

1. **V4A end-of-file chunk.** "Takes only an occurrence that ends at
   the file's last line" is read as a search for such an occurrence (per
   tier, at or after the cursor), so an earlier occurrence of the same
   text does not block the tail match.
2. **`diff --git` line form.** The two paths are single tokens
   (`a/<X> b/<Y>`); a line with spaces in the paths is a parse error at
   its line.
3. **Tier-2 re-indentation when the old block's first line has no
   leading whitespace.** `P` is empty, so a new line "starts with" it
   and gets `F` (the file's first matched line's indent) prepended.
4. **Detection before parsing.** A patch whose format cannot be
   detected is `error: format`, not a parse error: a lone hunk (no
   `diff --git`, no `---`/`+++` pair) and a V4A patch whose first line
   is not `*** Begin Patch` are format errors under auto-detect; the
   parse rules for those cases apply once the format is fixed (for
   example with `--format=unified` / `--format=v4a`).
5. **Blank lines at the end of a V4A section.** They are stripped from
   the last chunk, unless it is an end-of-file chunk — its lines sit
   before the `*** End of File` line, not before the next section or
   `*** End Patch`.
6. **Move reporting.** `R` replaces the pair's `D` and `A` lines only
   when the move qualifies (old existed before and not after, new did
   not exist before and does after). A move followed by deleting the new
   file is just `D <old>`; a move followed by moving back is
   `ok: 0 files`.
7. **Empty-old hunk inserted at the end of a file with no final break.**
   The result ends with a line break unless a `\` line follows the
   hunk's last `+` line.
8. **SEARCH/REPLACE path line.** A fence line (even with a language
   tag, e.g. ```` ```py ````) is skipped when looking for the path.
9. **JSON parse lines.** In array form any fault is
   `error: parse <line where the array starts>`; in JSON Lines form a
   line that does not hold one valid edit object is
   `error: parse <that line>`.
10. **Bare `-`.** It is the stdin patch, not an option; `--` ends the
    options.

## Submission steps (for the owner)

1. Create a **new public GitHub repo** (created after 2026-11-22) on
   the account that will enter — the repo must be owned by the
   entrant's GitHub account, carry an OSI-approved licence, and hold
   `main.ts` at its root. Copy into it only `main.ts`, `runner.ts`,
   `README.md`, and `LICENSE` from this directory (not the kit, not the
   test helpers).
2. Have a make.fun account and a **Solana keypair created on your own
   machine** (the keypair file contains the private key — never paste
   it into any chat). Link the keypair to the make.fun account.
3. From a **recorded agent session on your own computer**, run the kit
   CLI to bundle the build (this includes the transcripts of the AI
   coding-agent sessions that built it) and submit the repo URL and
   commit SHA. At most 5 submissions a day, 10 in all; the last
   submission before the deadline is the final entry.
4. If the entry places in the top 10, claim the USDC on Solana to your
   own Solana wallet within the claim window (at least 7 days); the
   wallet needs a small SOL balance for the network fee and about
   0.0025 SOL rent on the first claim.

## Honest note

The scored set is **100 checks drawn after the deadline from a sealed
pool of 300** that no kit carries, including check kinds the practice
set does not show. A house strict applier (exact line matching only)
enters in the last hours, and a reward needs a mean score **strictly
above** it with the 90% paired t-interval of the per-instance lead above
0 — a statistical tie does not beat it. Many entries already score 1000
on practice. **No prize is guaranteed.**

---

Entered on [make.fun](https://make.fun/?ref=p3gwn12d&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards
