/**
 * graphql-codegen currently re-emits input types and enums in a second
 * section when several documents reference them (TS2300 duplicate
 * identifiers). This script keeps the first declaration of each
 * `export type` / `export enum` block and drops later duplicates.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('../src/generated/graphql.ts', import.meta.url).pathname;
const src = readFileSync(FILE, 'utf8');
const lines = src.split('\n');

const seen = new Set();
const out = [];
let i = 0;

while (i < lines.length) {
  const line = lines[i];
  const m = line.match(/^export (type|enum) (\w+)/);
  if (!m) {
    out.push(line);
    i++;
    continue;
  }

  if (!seen.has(m[2])) {
    seen.add(m[2]);
    out.push(line);
    i++;
    continue;
  }

  // Duplicate block: skip exactly this block. Determine its end by
  // brace balance (objects/enums) or a trailing `;` (string unions).
  let depth = 0;
  let started = false;
  let end = i;
  for (let j = i; j < lines.length; j++) {
    const l = lines[j];
    for (const ch of l) {
      if (ch === '{') {
        depth++;
        started = true;
      } else if (ch === '}') {
        depth--;
      }
    }
    const isUnionEnd = /^\s*\|.*;$/.test(l.trim()) && !l.trim().startsWith('export');
    if ((started && depth <= 0) || (!started && isUnionEnd) || (j > i && /^\};?$/.test(l.trim()))) {
      end = j;
      break;
    }
    if (j > i && /^\s*\|[^;]*$/.test(l) === false && l.trim().endsWith(';') && !started) {
      // single-line union block like `= 'USD';`
      end = j;
      break;
    }
    end = j;
  }

  // skip through the block end, plus one following blank line if doubled
  i = end + 1;
  if (lines[i] !== undefined && lines[i].trim() === '' && out[out.length - 1] !== '') {
    i++;
  }
}

writeFileSync(FILE, out.join('\n'));
const dropped = lines.length - out.length;
console.log(`dedupe-generated: dropped ${dropped} duplicate lines`);
