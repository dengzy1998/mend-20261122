// main.ts is mend, the CLI SPEC.md specifies: one command-line tool that applies
// the edits AI models write, in four formats (unified diff, SEARCH/REPLACE blocks,
// V4A patches, JSON edits), to a tree of text files. It finds the lines each edit
// names at the first of three matching tiers (exact, trailing whitespace ignored,
// leading and trailing whitespace ignored), and writes every change or none,
// printing what it changed or why it failed. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// The last lines hand a trial over to runner.ts when MAKEFUN_ENV_URL is set: keep
// that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, its lines, and whether it ends with a break. */
interface FileText {
  br: '\n' | '\r\n';
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileText {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function renderFile(ft: FileText): string {
  if (ft.lines.length === 0) return '';
  return ft.lines.join(ft.br) + (ft.final ? ft.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves an edit made, as [old, new] pairs, for the R lines of the output. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** One old line and one new line of a line edit. `ctx` lines are written as the file's own matched line. */
interface OLine {
  text: string;
  ctx: boolean;
}
interface NLine {
  text: string;
  ctx: boolean;
  /** For a context line, the index of its line in O. */
  oIndex: number;
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position at or after `from` where O's lines match the file's lines at a tier. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const on = o.map((l) => normLine(l, tier));
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (normLine(lines[i + k]!, tier) !== on[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once at or after `from`, with its positions. */
function firstTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** Replace the lines at `pos` with N, honouring context lines and tier-2 re-indentation. */
function applyLines(ft: FileText, pos: number, oLen: number, o: OLine[], n: NLine[], tier: number): FileText {
  const out = ft.lines.slice(0, pos);
  const F = leadWs(ft.lines[pos] ?? '');
  const P = o.length > 0 ? leadWs(o[0]!.text) : '';
  for (const nl of n) {
    if (nl.ctx) {
      out.push(ft.lines[pos + nl.oIndex]!);
    } else {
      let t = nl.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  out.push(...ft.lines.slice(pos + oLen));
  return { br: ft.br, lines: out, final: ft.final };
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    if (edits.length === 0) throw new Exit2('error: parse 1');
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---- Unified diffs (SPEC.md section 6) ---- */

interface Hunk {
  /** Old start line, 1-based, from the header. */
  a: number;
  o: OLine[];
  n: NLine[];
  /** Whether a `\` line follows the hunk's last context or `+` line. */
  lastCtxPlusBackslash: boolean;
  /** Whether the hunk has a `+` line, and whether its last one is followed by `\`. */
  lastPlusBackslash: boolean;
  hasPlus: boolean;
}

interface BodyLine {
  kind: ' ' | '-' | '+';
  text: string;
  backslash: boolean;
}

function parseHunkBody(raw: string[]): Hunk | null {
  const body: BodyLine[] = [];
  for (const l of raw) {
    if (l.startsWith('\\')) {
      if (body.length > 0) body[body.length - 1]!.backslash = true;
      continue;
    }
    if (l === '') body.push({ kind: ' ', text: '', backslash: false });
    else if (l[0] === ' ') body.push({ kind: ' ', text: l.slice(1), backslash: false });
    else if (l[0] === '-') body.push({ kind: '-', text: l.slice(1), backslash: false });
    else if (l[0] === '+') body.push({ kind: '+', text: l.slice(1), backslash: false });
  }
  const o: OLine[] = [];
  const n: NLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      const oi = o.length;
      o.push({ text: b.text, ctx: true });
      n.push({ text: b.text, ctx: true, oIndex: oi });
    } else if (b.kind === '-') {
      o.push({ text: b.text, ctx: false });
    } else {
      n.push({ text: b.text, ctx: false, oIndex: -1 });
    }
  }
  let lastCtxPlusBackslash = false;
  let lastPlusBackslash = false;
  let hasPlus = false;
  for (let i = body.length - 1; i >= 0; i--) {
    const b = body[i]!;
    if (b.kind === '+') {
      if (!hasPlus) {
        hasPlus = true;
        lastPlusBackslash = b.backslash;
      }
    }
  }
  for (let i = body.length - 1; i >= 0; i--) {
    const b = body[i]!;
    if (b.kind === ' ' || b.kind === '+') {
      lastCtxPlusBackslash = b.backslash;
      break;
    }
  }
  return { a: 0, o, n, lastCtxPlusBackslash, lastPlusBackslash, hasPlus };
}

function isBodyLine(l: string): boolean {
  return l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\');
}

function stripDiffPrefix(p: string): string {
  if (p === '/dev/null') return p;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function headerPath(line: string): string {
  const t = line.slice(4).split('\t')[0]!;
  return stripDiffPrefix(t.trim());
}

interface Section {
  diffX: string | null;
  diffY: string | null;
  dashOld: string | null;
  dashNew: string | null;
  renFrom: string | null;
  renTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let headerPathsSet = false;
  const push = (): void => {
    if (cur !== null) sections.push(cur);
    cur = null;
    headerPathsSet = false;
  };
  const fresh = (diffX: string | null, diffY: string | null): Section => ({
    diffX,
    diffY,
    dashOld: null,
    dashNew: null,
    renFrom: null,
    renTo: null,
    newFile: false,
    delFile: false,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      push();
      cur = fresh(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && (cur.hunks.length > 0 || headerPathsSet)) push();
      if (cur === null) cur = fresh(null, null);
      cur.dashOld = headerPath(line);
      cur.dashNew = headerPath(lines[i + 1]!);
      headerPathsSet = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      let j = i + 1;
      const raw: string[] = [];
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (!isBodyLine(l)) break;
        raw.push(l);
        j += 1;
      }
      while (raw.length > 0 && raw[raw.length - 1]!.trim() === '') raw.pop();
      const hunk = parseHunkBody(raw)!;
      hunk.a = a;
      cur.hunks.push(hunk);
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ') && cur.dashNew === null) cur.dashNew = headerPath(line);
      else if (line.startsWith('rename from ')) cur.renFrom = stripDiffPrefix(line.slice('rename from '.length).trim());
      else if (line.startsWith('rename to ')) cur.renTo = stripDiffPrefix(line.slice('rename to '.length).trim());
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
    i += 1;
  }
  push();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Apply one hunk to a file's lines; the section's running offset `d` shifts its target. */
function applyHunk(ft: FileText, h: Hunk, d: number, strict: boolean, path: string): FileText {
  const oTexts = h.o.map((l) => l.text);
  if (oTexts.length === 0) {
    const p = Math.max(0, Math.min(h.a + d, ft.lines.length));
    const ins = h.n.map((nl) => nl.text);
    const lines = [...ft.lines.slice(0, p), ...ins, ...ft.lines.slice(p)];
    let final = ft.final;
    if (p === ft.lines.length) final = !h.lastCtxPlusBackslash;
    return { br: ft.br, lines, final };
  }
  const found = firstTier(ft.lines, oTexts, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let pos = found.occ[0]!;
  for (const q of found.occ) {
    if (Math.abs(q - target) < Math.abs(pos - target)) pos = q;
  }
  const out = applyLines(ft, pos, oTexts.length, h.o, h.n, found.tier);
  let final = ft.final;
  if (pos + oTexts.length === ft.lines.length) final = !h.lastCtxPlusBackslash;
  return { br: out.br, lines: out.lines, final };
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  const oldRaw = sec.dashOld ?? sec.renFrom ?? sec.diffX;
  const newRaw = sec.dashNew ?? sec.renTo ?? sec.diffY;
  const oldPath = oldRaw ?? newRaw;
  const newPath = newRaw ?? oldRaw;
  if (oldPath === null || oldPath === undefined || newPath === null || newPath === undefined) throw new Exit2('error: parse 1');
  const kind = oldRaw === '/dev/null' || sec.newFile ? 'create' : newRaw === '/dev/null' || sec.delFile ? 'delete' : oldPath !== newPath ? 'move' : 'change';
  return (tree) => {
    const paths = kind === 'create' ? [newPath] : kind === 'delete' ? [oldPath] : kind === 'move' ? [oldPath, newPath] : [oldPath];
    for (const p of paths) if (!safe(p)) throw new Fail('unsafe', p);
    if (kind === 'create') {
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const lines: string[] = [];
      let final = false;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const h = sec.hunks[hi]!;
        if (h.hasPlus) {
          final = !h.lastPlusBackslash;
          break;
        }
      }
      for (const h of sec.hunks) for (const nl of h.n) if (!nl.ctx) lines.push(nl.text);
      tree.now.set(newPath, lines.length === 0 ? '' : lines.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (kind === 'delete') {
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    if (kind === 'move' && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    let ft = parseFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      ft = applyHunk(ft, h, d, strict, oldPath);
      d += h.n.length - h.o.length;
    }
    const after = renderFile(ft);
    if (kind === 'move') {
      tree.now.set(oldPath, null);
      tree.now.set(newPath, after);
      tree.moves.push([oldPath, newPath]);
    } else {
      tree.now.set(oldPath, after);
    }
  };
}

/* ---- SEARCH/REPLACE blocks (SPEC.md section 7) ---- */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevReplaceEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const ft = parseFile(before);
    const found = firstTier(ft.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const o: OLine[] = oldLines.map((t) => ({ text: t, ctx: false }));
    const n: NLine[] = newLines.map((t) => ({ text: t, ctx: false, oIndex: -1 }));
    const out = applyLines(ft, pos, oldLines.length, o, n, found.tier);
    tree.now.set(path, renderFile(out));
  };
}

/* ---- V4A patches (SPEC.md section 8) ---- */

interface Chunk {
  anchor: string | null;
  o: OLine[];
  n: NLine[];
  eof: boolean;
}

function chunkBody(raw: BodyLine[]): { o: OLine[]; n: NLine[] } {
  const o: OLine[] = [];
  const n: NLine[] = [];
  for (const b of raw) {
    if (b.kind === ' ') {
      const oi = o.length;
      o.push({ text: b.text, ctx: true });
      n.push({ text: b.text, ctx: true, oIndex: oi });
    } else if (b.kind === '-') {
      o.push({ text: b.text, ctx: false });
    } else {
      n.push({ text: b.text, ctx: false, oIndex: -1 });
    }
  }
  return { o, n };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const sectionStart = (l: string): string | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  let i = first + 1;
  while (i <= last) {
    while (i <= last && blank(lines[i]!)) i++;
    if (i > last) break;
    const line = lines[i]!;
    if (line.trimEnd() === '*** End Patch') break;
    const kind = sectionStart(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = line.slice(line.indexOf(': ') + 2).trim();
    const headerLine = i + 1;
    i += 1;
    // Collect the section's lines, up to the next section or the End Patch line.
    const raw: string[] = [];
    while (i <= last) {
      const l = lines[i]!;
      if (sectionStart(l) !== null) break;
      if (l.trimEnd() === '*** End Patch') break;
      raw.push(l);
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${headerLine + 1 + k}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (kind === 'delete') {
      for (let k = 0; k < raw.length; k++) {
        if (!blank(raw[k]!)) throw new Exit2(`error: parse ${headerLine + 1 + k}`);
      }
      edits.push(v4aDeleteEdit(path));
    } else {
      let moveTo: string | null = null;
      let at = 0;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.slice('*** Move to: '.length).trim();
        at = 1;
      }
      const chunks: Chunk[] = [];
      let curBody: BodyLine[] | null = null;
      let curAnchor: string | null = null;
      let curEof = false;
      const closeChunk = (): void => {
        if (curBody === null) return;
        const { o, n } = chunkBody(curBody);
        chunks.push({ anchor: curAnchor, o, n, eof: curEof });
        curBody = null;
        curAnchor = null;
        curEof = false;
      };
      for (let k = at; k < raw.length; k++) {
        const l = raw[k]!;
        const lineNo = headerLine + 1 + k;
        if (l.startsWith('@@')) {
          closeChunk();
          const anchor = l.slice(2).trim();
          curAnchor = anchor === '' ? null : anchor;
          curBody = [];
          curEof = false;
        } else if (l.trimEnd() === '*** End of File') {
          if (curBody === null) throw new Exit2(`error: parse ${lineNo}`);
          curEof = true;
          closeChunk();
        } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (curBody === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${lineNo}`);
            curAnchor = null;
            curBody = [];
            curEof = false;
          }
          if (l === '') curBody.push({ kind: ' ', text: '', backslash: false });
          else if (l[0] === ' ') curBody.push({ kind: ' ', text: l.slice(1), backslash: false });
          else if (l[0] === '-') curBody.push({ kind: '-', text: l.slice(1), backslash: false });
          else curBody.push({ kind: '+', text: l.slice(1), backslash: false });
        } else {
          throw new Exit2(`error: parse ${lineNo}`);
        }
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** The first line at or after `from` equal to the anchor at the first tier with one. */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === normLine(anchor, t)) return i;
    }
  }
  return null;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let ft = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const a = findAnchor(ft.lines, ch.anchor, strict, cursor);
        if (a === null) throw new Fail('no-match', path);
        cursor = a + 1;
      }
      const oTexts = ch.o.map((l) => l.text);
      if (oTexts.length === 0) {
        const p = ch.eof ? ft.lines.length : cursor;
        const ins = ch.n.map((nl) => nl.text);
        const lines = [...ft.lines.slice(0, p), ...ins, ...ft.lines.slice(p)];
        ft = { br: ft.br, lines, final: ft.final };
        cursor = p + ins.length;
      } else {
        const found = firstTier(ft.lines, oTexts, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        let pos: number | null = null;
        if (ch.eof) {
          for (const q of found.occ) {
            if (q + oTexts.length === ft.lines.length) {
              pos = q;
              break;
            }
          }
          if (pos === null) throw new Fail('no-match', path);
        } else {
          pos = found.occ[0]!;
        }
        const out = applyLines(ft, pos, oTexts.length, ch.o, ch.n, found.tier);
        ft = out;
        cursor = pos + ch.n.length;
      }
    }
    const after = renderFile(ft);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, after);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, after);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const rows: { key: string; text: string }[] = [];
  const used = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const oldC = changed.get(oldP);
    const newC = changed.get(newP);
    if (oldC !== undefined && newC !== undefined && oldC.was !== null && oldC.now === null && newC.was === null && newC.now !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      used.add(oldP);
      used.add(newP);
    }
  }
  for (const [p, c] of changed) {
    if (used.has(p)) continue;
    rows.push({ key: p, text: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const [p, c] of changed) {
      if (c.now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, c.now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
