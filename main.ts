// main.ts — mend, the CLI SPEC.md specifies (starter + sections 5-8 implemented).
// Node 22, standard library alone; run as `node main.ts [options] [PATCH]`.
//
// main.ts reads a patch from a file or stdin, applies it to the tree in its
// working directory, and reports what changed. It does all of the work
// itself: no file is read or written before the patch has been parsed and
// the tree has been walked (the order the spec states), and all of the
// patch's edits are applied to the tree's own copy, so it can change every
// file or none of them. The caller hands over to runner.ts for trials.
//
// Exit 2 means the invocation or the patch is unusable: one line, nothing
// written. Exit 1 means some edits failed: one line per failed edit, then a
// `failed:` line, nothing written. Exit 0 means every edit worked: one line
// per changed path, then an `ok:` line, and every change was written unless
// `--check` was given.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['unified', 'search-replace', 'v4a', 'json', 'auto'] as const;

// For flow control only: `code` is the message and the exit code at once.
class Exit2 extends Error {}
class Fail extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const blank = (line: string): boolean => line.trim() === '';

// The patch is text split at `\n`, each line with one trailing `\r`
// removed, without the empty piece after a final `\n`. Its lines are
// numbered from 1.
function patchLines(text: string): string[] {
  const parts = text.split('\n');
  const lines: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i === parts.length - 1 && parts[i] === '') continue;
    lines.push(parts[i].replace(/\r$/, ''));
  }
  return lines;
}

// A path is safe when it is not empty, does not start with `/`, and has no
// `\` and no `/`-separated segment that is empty, `.`, or `..`.
function safe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return !p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

// ---------------------------------------------------------------------------
// Files as lines. A file's line break is CRLF when its first LF follows a
// CR, else LF; its lines are the text split at that break, and it ends with
// a line break when its text ends with that break; the last empty piece is
// not a line, and an empty file has no lines and no final break.
// ---------------------------------------------------------------------------

interface FileModel { br: string; lines: string[]; final: boolean; }

function fileLines(text: string): FileModel {
  const firstLf = text.indexOf('\n');
  const break_ = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const final_ = text.length > 0 && text.endsWith(break_);
  if (text === '') return { br: break_, lines: [], final: false };
  const parts = text.split(break_);
  if (final_) parts.pop();
  return { br: break_, lines: parts, final: final_ };
}

function serializeFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// ---------------------------------------------------------------------------
// Line matching (spec section 5). An old block O is found at the first of
// three tiers at which it occurs at least once: tier 0 every line equal;
// tier 1 every line equal once trailing spaces/tabs are removed from both;
// tier 2 every line equal once leading and trailing spaces/tabs are removed
// from both. `--strict` tries tier 0 only. An occurrence is a position i
// where O's lines match file lines i, i+1, ...; occurrences may overlap.
// ---------------------------------------------------------------------------

function trimEndST(s: string): string { return s.replace(/[ \t]+$/, ''); }
function trimST(s: string): string { return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''); }
function leadST(s: string): string { const m = /^[ \t]*/.exec(s); return m ? m[0] : ''; }
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndST(a) === trimEndST(b);
  return trimST(a) === trimST(b);
}
function tiers(strict: boolean): number[] { return strict ? [0] : [0, 1, 2]; }

function occurrences(O: string[], lines: string[], tier: number, start: number): number[] {
  const out: number[] = [];
  if (O.length === 0 || O.length > lines.length) return out;
  for (let i = Math.max(0, start); i + O.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (!lineEq(O[k], lines[i + k], tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(O: string[], lines: string[], strict: boolean, start: number): { tier: number; positions: number[] } | null {
  for (const tier of tiers(strict)) {
    const positions = occurrences(O, lines, tier, start);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

// One line equal to `anchor` at the first tier where one is, at or after
// `cursor`, or null.
function findAnchor(anchor: string, lines: string[], strict: boolean, cursor: number): number | null {
  for (const tier of tiers(strict)) {
    for (let i = cursor; i < lines.length; i++) {
      if (lineEq(anchor, lines[i], tier)) return i;
    }
  }
  return null;
}

// A line of N that is not a context line is re-indented at tier 2: F is the
// leading spaces/tabs of the file's first matched line, P those of O's
// first line; a line that is not empty and not only whitespace, and starts
// with P, has that P replaced by F; any other line is written as it is.
// At tiers 0 and 1, N lines are written as they are.
function reindentNew(text: string, O: string[], fileFirst: string): string {
  if (text === '' || text.trim() === '') return text;
  const F = leadST(fileFirst);
  const P = leadST(O[0]);
  if (!text.startsWith(P)) return text;
  return F + text.slice(P.length);
}

// A line of N is either a context line, written as the file's own matched
// line, or a new line, written as it is (tier 0/1) or re-indented (tier 2).
interface NItem { text: string; ctx: number | null; }
function buildNewLines(N: NItem[], fileLinesArr: string[], pos: number, tier: number, O: string[]): string[] {
  const out: string[] = [];
  for (const it of N) {
    if (it.ctx !== null) out.push(fileLinesArr[pos + it.ctx]);
    else if (tier === 2) out.push(reindentNew(it.text, O, fileLinesArr[pos]));
    else out.push(it.text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Edits. Every edit runs against a Tree: the files on disk as they were,
// plus the changes earlier edits made. A failed edit changes nothing, and
// the edits after it still run. Every path an edit names is checked for
// safety before anything else about it.
// ---------------------------------------------------------------------------

class Tree {
  // The files on disk as they were when the patch started.
  private orig: Map<string, string | null> = new Map();
  // The working copy the edits change, as it stands now.
  now: Map<string, string | null> = new Map();
  // Moves made, in order, as (old path, new path).
  moves: Array<[string, string]> = [];

  get(path: string): string | null {
    if (this.now.has(path)) return this.now.get(path) ?? null;
    return this.original(path);
  }
  original(path: string): string | null {
    if (this.orig.has(path)) return this.orig.get(path) ?? null;
    let text: string | null = null;
    try {
      if (statSync(path).isFile()) text = readFileSync(path, 'utf8');
    } catch {
      text = null;
    }
    this.orig.set(path, text);
    return text;
  }
  set(path: string, text: string | null): void {
    this.now.set(path, text);
  }
}

type Edit = (tree: Tree) => void;

type Op =
  | { kind: 'create'; path: string; text: string }
  | { kind: 'delete'; path: string }
  | { kind: 'change'; path: string; apply: (cur: string) => string }
  | { kind: 'move'; old: string; nw: string; apply: (cur: string) => string };

function opToEdit(op: Op): Edit {
  return (tree: Tree): void => {
    const paths = op.kind === 'move' ? [op.old, op.nw] : [op.path];
    for (const p of paths) {
      if (!safe(p)) throw new Fail('unsafe', p);
    }
    if (op.kind === 'create') {
      if (tree.get(op.path) !== null) throw new Fail('exists', op.path);
      tree.set(op.path, op.text);
    } else if (op.kind === 'delete') {
      if (tree.get(op.path) === null) throw new Fail('missing', op.path);
      tree.set(op.path, null);
    } else if (op.kind === 'change') {
      const cur = tree.get(op.path);
      if (cur === null) throw new Fail('missing', op.path);
      tree.set(op.path, op.apply(cur));
    } else {
      const cur = tree.get(op.old);
      if (cur === null) throw new Fail('missing', op.old);
      if (tree.get(op.nw) !== null) throw new Fail('exists', op.nw);
      const out = op.apply(cur);
      tree.set(op.old, null);
      tree.set(op.nw, out);
      tree.moves.push([op.old, op.nw]);
    }
  };
}

// A body line of a unified hunk or a V4A chunk: context, old, new, or the
// `\` line that follows one of them.
interface BodyItem { kind: 'ctx' | 'old' | 'new' | 'backslash'; text: string; }

// Split a body into O (context + old lines) and N (context lines, written
// as the file's own matched line, and new lines).
function splitON(items: BodyItem[]): { O: string[]; N: NItem[] } {
  const O: string[] = [];
  const N: NItem[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') { N.push({ text: it.text, ctx: O.length }); O.push(it.text); }
    else if (it.kind === 'old') { O.push(it.text); }
    else if (it.kind === 'new') { N.push({ text: it.text, ctx: null }); }
  }
  return { O, N };
}

// Whether a `\` line follows the body's last context or `+` line.
function bodyNoBreak(items: BodyItem[]): boolean {
  for (let k = items.length - 1; k >= 0; k--) {
    if (items[k].kind === 'ctx' || items[k].kind === 'new') {
      return k + 1 < items.length && items[k + 1].kind === 'backslash';
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Unified diffs (spec section 6).
// ---------------------------------------------------------------------------

interface Hunk { A: number; C: number; items: BodyItem[]; O: string[]; N: NItem[]; noBreak: boolean; }

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/;
const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

// A `--- ` or `+++ ` line names a path: the text after the first four
// characters, up to the first tab, its surrounding spaces removed;
// `/dev/null` means no file; a leading `a/` or `b/` is removed from either.
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0].trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

// A hunk body: lines after the header starting with ` ` (context), `-`
// (old), `+` (new) or `\`, or empty (an empty line is a context line whose
// text is empty). The body ends at the first other line, at a `diff --git`
// line, at a `--- ` line followed by a `+++ ` line, or at the end of the
// patch. Empty lines at the end of a body are not part of it.
function parseHunkBody(lines: string[], start: number): { hunk: Hunk; next: number } {
  const items: BodyItem[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith(' ')) { items.push({ kind: 'ctx', text: l.slice(1) }); i++; continue; }
    if (l.startsWith('-')) { items.push({ kind: 'old', text: l.slice(1) }); i++; continue; }
    if (l.startsWith('+')) { items.push({ kind: 'new', text: l.slice(1) }); i++; continue; }
    if (l.startsWith('\\')) { items.push({ kind: 'backslash', text: l }); i++; continue; }
    if (l === '') { items.push({ kind: 'ctx', text: '' }); i++; continue; }
    break;
  }
  while (items.length > 0) {
    const last = items[items.length - 1];
    if (last.kind === 'ctx' && last.text === '') items.pop();
    else break;
  }
  const { O, N } = splitON(items);
  return { hunk: { A: 0, C: 0, items, O, N, noBreak: bodyNoBreak(items) }, next: i };
}

interface Section {
  pairOld: string | null; pairNew: string | null; hasPair: boolean;
  renameFrom: string | null; renameTo: string | null;
  diffOld: string | null; diffNew: string | null;
  newFile: boolean; deletedFile: boolean;
  hunks: Hunk[]; seenHunk: boolean;
}

function newSection(): Section {
  return {
    pairOld: null, pairNew: null, hasPair: false,
    renameFrom: null, renameTo: null,
    diffOld: null, diffNew: null,
    newFile: false, deletedFile: false,
    hunks: [], seenHunk: false,
  };
}

// `rename from`/`rename to` name the old and new path when no `---`/`+++`
// pair does; the `diff --git` paths are used when nothing else names one.
function effectiveOld(s: Section): string | null {
  return s.hasPair ? s.pairOld : (s.renameFrom ?? s.diffOld);
}
function effectiveNew(s: Section): string | null {
  return s.hasPair ? s.pairNew : (s.renameTo ?? s.diffNew);
}

function applyUnifiedHunks(hunks: Hunk[], strict: boolean, path: string): (cur: string) => string {
  return (cur: string): string => {
    let fm = fileLines(cur);
    let d = 0; // sum of (N's length minus O's length) over hunks applied so far
    for (const h of hunks) {
      if (h.O.length === 0) {
        // N is inserted after the first A + d lines (all of them when the
        // file has fewer).
        const pos = Math.min(h.A + d, fm.lines.length);
        const ins = h.N.map((it) => it.text);
        if (ins.length > 0) {
          const atEnd = pos === fm.lines.length;
          fm.lines.splice(pos, 0, ...ins);
          if (atEnd) fm.final = !h.noBreak;
        }
        d += h.N.length;
        continue;
      }
      const found = findTier(h.O, fm.lines, strict, 0);
      if (!found) throw new Fail('no-match', path);
      // Of the occurrences at the tier where O is found, the hunk takes
      // the one whose 0-based position is nearest to A - 1 + d; ties go
      // to the earlier.
      const target = h.A - 1 + d;
      let best = found.positions[0];
      for (const p of found.positions) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const pos = best;
      const nlines = buildNewLines(h.N, fm.lines, pos, found.tier, h.O);
      // When a hunk's matched lines run to the end of the file, the
      // result ends with a line break unless a `\` line follows the
      // hunk's last context or `+` line; when they do not, the file's
      // final break stays as it was.
      const atEnd = pos + h.O.length === fm.lines.length;
      fm.lines.splice(pos, h.O.length, ...nlines);
      if (atEnd) fm.final = !h.noBreak;
      d += h.N.length - h.O.length;
    }
    return serializeFile(fm);
  };
}

function sectionToEdit(sec: Section, strict: boolean): Edit {
  const oldP = effectiveOld(sec);
  const newP = effectiveNew(sec);
  const isCreate = oldP === null || sec.newFile;
  if (isCreate) {
    // A creation's file is the `+` lines of all its hunks, in order. It
    // ends with a line break unless a `\` line follows its last `+` line.
    if (newP === null) return (): void => {};
    const plus: string[] = [];
    let lastPlus: { hunk: Hunk; idx: number } | null = null;
    for (const h of sec.hunks) {
      for (let k = 0; k < h.items.length; k++) {
        if (h.items[k].kind === 'new') { plus.push(h.items[k].text); lastPlus = { hunk: h, idx: k }; }
      }
    }
    const noBreak = lastPlus !== null
      && lastPlus.idx + 1 < lastPlus.hunk.items.length
      && lastPlus.hunk.items[lastPlus.idx + 1].kind === 'backslash';
    const text = plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n');
    return opToEdit({ kind: 'create', path: newP, text });
  }
  const isDelete = newP === null || sec.deletedFile;
  if (isDelete) {
    if (oldP === null) return (): void => {};
    return opToEdit({ kind: 'delete', path: oldP });
  }
  if (oldP !== null && newP !== null && oldP !== newP) {
    return opToEdit({ kind: 'move', old: oldP, nw: newP, apply: applyUnifiedHunks(sec.hunks, strict, oldP) });
  }
  return opToEdit({ kind: 'change', path: oldP ?? '', apply: applyUnifiedHunks(sec.hunks, strict, oldP ?? '') });
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  const startSection = (s: Section): void => {
    if (sec !== null) sections.push(sec);
    sec = s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      // A `diff --git` line not of the form `diff --git a/<X> b/<Y>` is a
      // parse fault at its line.
      const m = DIFF_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.diffOld = m[1];
      s.diffNew = m[2];
      startSection(s);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const parsed = parseHunkBody(lines, i + 1);
      parsed.hunk.A = parseInt(m[1], 10);
      parsed.hunk.C = parseInt(m[3], 10);
      sec.hunks.push(parsed.hunk);
      sec.seenHunk = true;
      i = parsed.next;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        // A section starts at a `--- ` line followed by a `+++ ` line.
        if (sec === null || sec.seenHunk || sec.hasPair) {
          const s = newSection();
          s.hasPair = true;
          s.pairOld = headerPath(line);
          s.pairNew = headerPath(next);
          startSection(s);
        } else {
          sec.hasPair = true;
          sec.pairOld = headerPath(line);
          sec.pairNew = headerPath(next);
        }
        i += 2;
        continue;
      }
      // A `--- ` line not followed by a `+++ ` line, inside a section's
      // header, is a parse fault at the line after it.
      if (sec !== null && !sec.seenHunk) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (sec !== null && !sec.seenHunk) {
      if (line.startsWith('rename from ')) {
        if (sec.renameFrom === null) sec.renameFrom = stripAB(line.slice('rename from '.length).trim());
      } else if (line.startsWith('rename to ')) {
        if (sec.renameTo === null) sec.renameTo = stripAB(line.slice('rename to '.length).trim());
      } else if (line.startsWith('new file mode')) {
        sec.newFile = true;
      } else if (line.startsWith('deleted file mode')) {
        sec.deletedFile = true;
      }
      // `index`, `old mode`, `new mode`, `similarity index`,
      // `dissimilarity index`, `Index:` and any other line are ignored.
    }
    // Outside bodies, lines not part of a section header are ignored
    // (prose, code fences).
    i++;
  }
  if (sec !== null) sections.push(sec);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => sectionToEdit(s, strict));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (spec section 7). A block is a path line,
// `<<<<<<< SEARCH`, old lines, `=======`, new lines, `>>>>>>> REPLACE`.
// Marker lines are matched with their trailing whitespace removed.
// ---------------------------------------------------------------------------

function applySearch(O: string[], N: string[], strict: boolean, path: string): (cur: string) => string {
  return (cur: string): string => {
    const fm = fileLines(cur);
    const found = findTier(O, fm.lines, strict, 0);
    if (!found) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0];
    const nlines = N.map((t) => (found.tier === 2 ? reindentNew(t, O, fm.lines[pos]) : t));
    const lines = [...fm.lines.slice(0, pos), ...nlines, ...fm.lines.slice(pos + O.length)];
    return serializeFile({ br: fm.br, lines, final: fm.final });
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1; // index of the previous block's `>>>>>>> REPLACE` line
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const searchLine = i;
    // The path is the nearest line before the SEARCH line, and after the
    // previous block's `>>>>>>> REPLACE` line (or the start of the patch),
    // that is not blank and, its surrounding whitespace removed, does not
    // start with three backticks.
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    // A SEARCH line with no `=======` and then `>>>>>>> REPLACE` after it
    // is a parse fault at the SEARCH line.
    let sep = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      const t = lines[j].trimEnd();
      if (t === '=======') { sep = j; break; }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (sep === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') { end = j; break; }
    }
    if (end === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    if (oldLines.length === 0) {
      // Old lines empty: the file is created with the new lines.
      const text = newLines.length === 0 ? '' : newLines.join('\n') + '\n';
      edits.push(opToEdit({ kind: 'create', path, text }));
    } else {
      edits.push(opToEdit({ kind: 'change', path, apply: applySearch(oldLines, newLines, strict, path) }));
    }
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (spec section 8).
// ---------------------------------------------------------------------------

interface Chunk { anchor: string | null; items: BodyItem[]; eof: boolean; O: string[]; N: NItem[]; }

const isV4aSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function applyV4a(chunks: Chunk[], strict: boolean, path: string): (cur: string) => string {
  return (cur: string): string => {
    const fm = fileLines(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        // The anchor is found at the first line at or after the cursor
        // equal to it, at the first tier where one is; the cursor moves
        // past it.
        const a = findAnchor(ch.anchor, fm.lines, strict, cursor);
        if (a === null) throw new Fail('no-match', path);
        cursor = a + 1;
      }
      if (ch.eof) {
        if (ch.O.length === 0) {
          const nlines = ch.N.map((it) => it.text);
          fm.lines.push(...nlines);
          cursor = fm.lines.length;
        } else {
          // An end-of-file chunk takes only an occurrence that ends at
          // the file's last line, at the first tier with one.
          let hit: { tier: number; pos: number } | null = null;
          for (const tier of tiers(strict)) {
            const positions = occurrences(ch.O, fm.lines, tier, cursor)
              .filter((p) => p + ch.O.length === fm.lines.length);
            if (positions.length > 0) { hit = { tier, pos: positions[0] }; break; }
          }
          if (hit === null) throw new Fail('no-match', path);
          const nlines = buildNewLines(ch.N, fm.lines, hit.pos, hit.tier, ch.O);
          fm.lines.splice(hit.pos, ch.O.length, ...nlines);
          cursor = hit.pos + nlines.length;
        }
        continue;
      }
      if (ch.O.length === 0) {
        const nlines = ch.N.map((it) => it.text);
        fm.lines.splice(cursor, 0, ...nlines);
        cursor = cursor + nlines.length;
      } else {
        const found = findTier(ch.O, fm.lines, strict, cursor);
        if (!found) throw new Fail('no-match', path);
        const pos = found.positions[0];
        const nlines = buildNewLines(ch.N, fm.lines, pos, found.tier, ch.O);
        fm.lines.splice(pos, ch.O.length, ...nlines);
        cursor = pos + nlines.length;
      }
    }
    return serializeFile(fm);
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  // The first non-blank line must be `*** Begin Patch`, else a parse fault
  // at that line; the last non-blank line must be `*** End Patch`, else a
  // parse fault at the number of patch lines plus 1.
  if (lines[first].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k])) { last = k; break; }
  }
  if (lines[last].trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i])) { i++; continue; }
    const line = lines[i];
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i++;
      const content: string[] = [];
      while (i < last) {
        const l = lines[i];
        if (isV4aSectionStart(l)) break;
        if (l.startsWith('+')) { content.push(l.slice(1)); i++; }
        else if (l === '') { content.push(''); i++; }
        else throw new Exit2(`error: parse ${i + 1}`);
      }
      // Blank lines at the end of a section are not part of it.
      while (content.length > 0 && content[content.length - 1] === '') content.pop();
      const text = content.length === 0 ? '' : content.join('\n') + '\n';
      edits.push(opToEdit({ kind: 'create', path, text }));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i++;
      edits.push(opToEdit({ kind: 'delete', path }));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i].startsWith('*** Move to: ')) {
        moveTo = lines[i].slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: Chunk[] = [];
      let chunk: Chunk | null = null;
      let seenBody = false;
      let afterEof = false;
      while (i < last) {
        const l = lines[i];
        if (isV4aSectionStart(l)) break;
        if (afterEof) {
          // Blank lines at the end of a section are not part of it.
          if (l === '') { i++; continue; }
          if (l.startsWith('@@')) {
            const anchor = l.slice(2).trim();
            chunk = { anchor: anchor === '' ? null : anchor, items: [], eof: false, O: [], N: [] };
            afterEof = false;
            seenBody = true;
            i++;
            continue;
          }
          throw new Exit2(`error: parse ${i + 1}`);
        }
        if (l.trimEnd() === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${i + 1}`);
          chunk.eof = true;
          chunks.push(chunk);
          chunk = null;
          afterEof = true;
          i++;
          continue;
        }
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          if (chunk !== null) chunks.push(chunk);
          chunk = { anchor: anchor === '' ? null : anchor, items: [], eof: false, O: [], N: [] };
          seenBody = true;
          i++;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (chunk === null) {
            if (seenBody) throw new Exit2(`error: parse ${i + 1}`);
            chunk = { anchor: null, items: [], eof: false, O: [], N: [] };
            seenBody = true;
          }
          chunk.items.push(
            l === '' ? { kind: 'ctx', text: '' }
            : l.startsWith(' ') ? { kind: 'ctx', text: l.slice(1) }
            : l.startsWith('-') ? { kind: 'old', text: l.slice(1) }
            : { kind: 'new', text: l.slice(1) },
          );
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (chunk !== null) chunks.push(chunk);
      // Blank lines at the end of a section are not part of it: strip
      // trailing empty context lines from the last chunk, unless it is an
      // end-of-file chunk (its lines sit before the `*** End of File`
      // line, not before the next section or `*** End Patch`).
      const tail = chunks[chunks.length - 1];
      if (tail !== undefined && !tail.eof) {
        while (tail.items.length > 0) {
          const lastItem = tail.items[tail.items.length - 1];
          if (lastItem.kind === 'ctx' && lastItem.text === '') tail.items.pop();
          else break;
        }
      }
      // Drop chunks left with no body lines.
      const kept = chunks.filter((c) => c.items.length > 0);
      for (const c of kept) {
        const { O, N } = splitON(c.items);
        c.O = O;
        c.N = N;
      }
      if (kept.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      if (moveTo === null) {
        edits.push(opToEdit({ kind: 'change', path, apply: applyV4a(kept, strict, path) }));
      } else {
        edits.push(opToEdit({ kind: 'move', old: path, nw: moveTo, apply: applyV4a(kept, strict, path) }));
      }
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// JSON (spec section 9). The patch is either one JSON array of edit
// objects, or JSON Lines (one edit object a line, blank lines ignored).
// ---------------------------------------------------------------------------

function jsonEdit(value: unknown): Edit | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.path !== 'string' || typeof obj.command !== 'string') return null;
  const path = obj.path;
  const command = obj.command;
  if (command === 'create') {
    if (typeof obj.file_text !== 'string') return null;
    const text = obj.file_text;
    return opToEdit({ kind: 'create', path, text });
  }
  if (command === 'str_replace') {
    if (typeof obj.old_str !== 'string' || obj.old_str === '') return null;
    if (obj.new_str !== undefined && typeof obj.new_str !== 'string') return null;
    const oldStr = obj.old_str;
    const newStr = (obj.new_str ?? '') as string;
    return opToEdit({
      kind: 'change',
      path,
      apply: (cur: string): string => {
        // In a CRLF file, the file text and both strings are read with
        // every `\r\n` as `\n`, and the result is written back with
        // `\r\n`.
        const fm = fileLines(cur);
        const isCrlf = fm.br === '\r\n';
        const text = isCrlf ? cur.replace(/\r\n/g, '\n') : cur;
        const oldN = isCrlf ? oldStr.replace(/\r\n/g, '\n') : oldStr;
        const newN = isCrlf ? newStr.replace(/\r\n/g, '\n') : newStr;
        const first = text.indexOf(oldN);
        if (first < 0) throw new Fail('no-match', path);
        if (text.indexOf(oldN, first + 1) >= 0) throw new Fail('ambiguous', path);
        const out = text.slice(0, first) + newN + text.slice(first + oldN.length);
        return isCrlf ? out.replace(/\n/g, '\r\n') : out;
      },
    });
  }
  if (command === 'insert') {
    if (typeof obj.insert_line !== 'number' || !Number.isInteger(obj.insert_line)) return null;
    if (typeof obj.new_str !== 'string') return null;
    const line = obj.insert_line;
    const newStr = obj.new_str;
    return opToEdit({
      kind: 'change',
      path,
      apply: (cur: string): string => {
        const fm = fileLines(cur);
        if (line < 0 || line > fm.lines.length) throw new Fail('no-match', path);
        const ins = patchLines(newStr);
        const lines = [...fm.lines.slice(0, line), ...ins, ...fm.lines.slice(line)];
        // The file's final break stays as it was.
        return serializeFile({ br: fm.br, lines, final: fm.final });
      },
    });
  }
  return null;
}

function jsonEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first].trimStart().startsWith('[')) {
    // One JSON array of edit objects. Any fault is a parse fault at the
    // line where the array starts.
    let value: unknown;
    try {
      value = JSON.parse(lines.slice(first).join('\n'));
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(value)) throw new Exit2(`error: parse ${first + 1}`);
    const edits: Edit[] = [];
    for (const item of value) {
      const edit = jsonEdit(item);
      if (edit === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(edit);
    }
    if (edits.length === 0) throw new Exit2('error: parse 1');
    return edits;
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (blank(lines[i])) continue;
    let value: unknown;
    try {
      value = JSON.parse(lines[i]);
    } catch {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const edit = jsonEdit(value);
    if (edit === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(edit);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// Format detection (spec section 4), in order: v4a, json, search-replace,
// unified. A named `--format` is read as that format whatever the text
// holds.
// ---------------------------------------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const firstChar = lines[first].trimStart()[0];
  if (firstChar === '[' || firstChar === '{') return 'json';
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimEnd() === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && lines[i + 1] !== undefined && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Command line, exit codes, output, and the all-or-nothing write.
// ---------------------------------------------------------------------------

interface RunResult { code: number; out: string[]; }

function run(argv: string[]): RunResult {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('--format=')) {
      const value = a.slice('--format='.length);
      if (format !== null) throw new Exit2('error: usage');
      if (!FORMATS.includes(value as (typeof FORMATS)[number])) throw new Exit2('error: usage');
      format = value;
    } else if (!ended && a === '--check') {
      if (check) throw new Exit2('error: usage');
      check = true;
    } else if (!ended && a === '--strict') {
      if (strict) throw new Exit2('error: usage');
      strict = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      throw new Exit2('error: usage');
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) throw new Exit2('error: usage');
  let text: string;
  if (pos.length === 0 || pos[0] === '-') {
    text = readFileSync(0, 'utf8');
  } else {
    try {
      text = readFileSync(pos[0], 'utf8');
    } catch {
      throw new Exit2('error: no-patch');
    }
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) throw new Exit2('error: format');
  let edits: Edit[];
  if (kind === 'json') edits = jsonEdits(lines);
  else if (kind === 'unified') edits = parseUnified(lines, strict);
  else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
  else edits = parseV4a(lines, strict);
  if (edits.length === 0) throw new Exit2('error: parse 1');
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    const out = fails.map((f) => `error: ${f.code} ${f.path}`);
    out.push(`failed: ${fails.length} of ${edits.length} edits`);
    return { code: 1, out };
  }
  // One line per changed path, in byte order (UTF-8): `A <path>`, `D
  // <path>`, `M <path>`, and `R <old> -> <new>` for a successful move,
  // which replaces that pair's `D` and `A` lines and sorts by `<new>`.
  // A move qualifies only when the old path existed before the patch and
  // does not after it, and the new path did not exist before it and does
  // after it.
  const rPairs: Array<[string, string]> = [];
  for (const [oldP, newP] of tree.moves) {
    if (
      tree.original(oldP) !== null && tree.get(oldP) === null
      && tree.original(newP) === null && tree.get(newP) !== null
    ) {
      rPairs.push([oldP, newP]);
    }
  }
  const movedOld = new Set(rPairs.map(([o]) => o));
  const movedNew = new Set(rPairs.map(([, n]) => n));
  const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  const rows: Array<{ key: string; line: string }> = [];
  for (const p of [...tree.now.keys()].sort(byBytes)) {
    const was = tree.original(p);
    const now = tree.now.get(p) ?? null;
    if (was === now) continue;
    if (movedOld.has(p) || movedNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of rPairs) {
    rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
  }
  rows.sort((a, b) => byBytes(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p) ?? null;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

try {
  const result = run(process.argv.slice(2));
  if (result.out.length > 0) writeSync(1, result.out.join('\n') + '\n');
  process.exitCode = result.code;
} catch (e) {
  if (e instanceof Exit2) {
    writeSync(1, e.message + '\n');
    process.exitCode = 2;
  } else {
    throw e;
  }
}

// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and main.ts hands over to runner.ts (which must be copied beside it in
// the submission).
if (process.env.MAKEFUN_ENV_URL) {
  const { runTrial } = await import('./runner.ts');
  await runTrial();
}
