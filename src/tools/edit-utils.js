// Edit helpers: fuzzy-match fallback and multi-edit planning.
//
// Fuzzy-match: when the model's old_string doesn't appear in the file byte-
// for-byte, normalize both sides (NFKC, smart quotes → ASCII, unicode dashes
// → '-', unicode spaces → ' ', trim trailing whitespace on each line) and
// try to locate the span in the *normalized* projection of the file. Then
// map the hit back to the original byte range and splice the ORIGINAL bytes
// around it — so the rest of the file is never silently renormalized.

const SMART_QUOTES = /[‘’‚‛′]/g; // ‘ ’ ‚ ‛ ′
const SMART_DQUOTES = /[“”„‟″]/g; // “ ” „ ‟ ″
const UNICODE_DASHES = /[‐‑‒–—―−]/g;
const UNICODE_SPACES = /[  -​  　]/g;

// Returns { norm, map } where norm is the normalized string and map[i] is
// the original index corresponding to normalized index i, plus map[norm.length]
// = original.length so callers can compute end positions. NFKC can expand
// one char into several, which is why we need the index map at all.
function normalizeWithMap(s) {
  let norm = "";
  const map = [];
  for (let i = 0; i < s.length; i++) {
    let piece = s[i]
      .normalize("NFKC")
      .replace(SMART_QUOTES, "'")
      .replace(SMART_DQUOTES, '"')
      .replace(UNICODE_DASHES, "-")
      .replace(UNICODE_SPACES, " ");
    for (let j = 0; j < piece.length; j++) {
      norm += piece[j];
      map.push(i);
    }
  }
  map.push(s.length);
  return { norm, map };
}

// Normalized-space indexOf with original-range mapping.
// Returns { start, end } byte offsets into `original` or null.
export function fuzzyLocate(original, needle) {
  const { norm: haystack, map } = normalizeWithMap(original);
  const { norm: pat } = normalizeWithMap(needle);
  if (!pat) return null;
  const first = haystack.indexOf(pat);
  if (first === -1) return null;
  const second = haystack.indexOf(pat, first + pat.length);
  if (second !== -1) return { ambiguous: true };
  return { start: map[first], end: map[first + pat.length] };
}

// Given the original file and an array of {old_string, new_string, replace_all}
// edits, validate and apply them to produce the new file contents. oldText is
// matched against the ORIGINAL (pre-edit) contents, never against a partially
// edited buffer, to keep the semantics predictable and match pi-mono.
//
// Returns { ok: true, updated, appliedDiffs } or { ok: false, error }.
export function planMultiEdit(original, edits) {
  const spans = []; // { start, end, replacement, index, fuzzy }
  const appliedDiffs = [];

  for (let idx = 0; idx < edits.length; idx++) {
    const e = edits[idx] || {};
    const { old_string, new_string, replace_all } = e;
    if (typeof old_string !== "string" || typeof new_string !== "string") {
      return { ok: false, error: `edits[${idx}]: old_string and new_string must be strings` };
    }
    if (old_string === "") {
      return { ok: false, error: `edits[${idx}]: old_string must not be empty` };
    }

    if (replace_all) {
      if (!original.includes(old_string)) {
        return { ok: false, error: `edits[${idx}]: old_string not found (replace_all)` };
      }
      let from = 0;
      while (true) {
        const at = original.indexOf(old_string, from);
        if (at === -1) break;
        spans.push({ start: at, end: at + old_string.length, replacement: new_string, index: idx });
        from = at + old_string.length;
      }
      appliedDiffs.push({ index: idx, old: old_string, new: new_string });
      continue;
    }

    const first = original.indexOf(old_string);
    if (first !== -1) {
      const second = original.indexOf(old_string, first + old_string.length);
      if (second !== -1) {
        return {
          ok: false,
          error: `edits[${idx}]: old_string matches ${
            original.split(old_string).length - 1
          } times. Provide a longer unique snippet or set replace_all=true.`,
        };
      }
      spans.push({ start: first, end: first + old_string.length, replacement: new_string, index: idx });
      appliedDiffs.push({ index: idx, old: old_string, new: new_string });
      continue;
    }

    // Fuzzy fallback for smart-quote / unicode-dash / nbsp drift.
    const loc = fuzzyLocate(original, old_string);
    if (!loc) {
      return { ok: false, error: `edits[${idx}]: old_string not found (also tried unicode-normalized match)` };
    }
    if (loc.ambiguous) {
      return { ok: false, error: `edits[${idx}]: old_string not unique after unicode normalization; provide a longer snippet` };
    }
    spans.push({ start: loc.start, end: loc.end, replacement: new_string, index: idx, fuzzy: true });
    appliedDiffs.push({ index: idx, old: original.slice(loc.start, loc.end), new: new_string, fuzzy: true });
  }

  // Overlap detection. Sort by start; fail if any span starts before the
  // previous one ends. Equal endpoints (back-to-back) are fine.
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start < spans[i - 1].end) {
      return {
        ok: false,
        error: `edits[${spans[i].index}] overlaps edits[${spans[i - 1].index}]. Each oldText must not overlap any other (matched against the original file).`,
      };
    }
  }

  // Splice: walk the original once, emitting unchanged regions + replacements.
  let out = "";
  let cursor = 0;
  for (const s of spans) {
    out += original.slice(cursor, s.start);
    out += s.replacement;
    cursor = s.end;
  }
  out += original.slice(cursor);

  return { ok: true, updated: out, appliedDiffs };
}
