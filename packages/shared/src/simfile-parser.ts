import { ChartInput } from './chart.js';
import type { DifficultySlot, PlayStyle } from './enums.js';

/**
 * `.sm`/`.ssc` metadata extraction — title, artist, difficulty, meter,
 * stepartist, description, the `noCmod` flag. See DESIGN.md, "Client-Side
 * Song Pack Parsing".
 *
 * This is deliberately *not* `simfile-parser` from npm. That package parses
 * arrows, freezes, and BPM/stop timing for rendering a stepchart — real work
 * this project never needs, since a tournament pack only cares about the
 * metadata a chart is drawn and displayed by. It also drops `#CREDIT` and
 * `#DESCRIPTION` entirely (its chart-tag allowlist is only
 * `stepstype`/`difficulty`/`meter`), which `ChartInput` requires. A metadata
 * scanner that stops at the first note line is both simpler and the only
 * one that produces what this pack model actually stores.
 *
 * Only `dance-single`/`dance-double` charts and the five named difficulty
 * slots are recognised — an `Edit` chart or a non-`dance-*` stepstype (e.g.
 * `pump-single`) has nowhere to go in this schema and is silently skipped,
 * the same way an organizer's later edit is a correction rather than a
 * failure DESIGN.md asks this layer to catch.
 */

const DIFFICULTY_SLOT: Record<string, DifficultySlot> = {
  beginner: 'NOVICE',
  easy: 'EASY',
  medium: 'MEDIUM',
  hard: 'HARD',
  challenge: 'EXPERT',
};

const PLAY_STYLE: Record<string, PlayStyle> = {
  'dance-single': 'SINGLE',
  'dance-double': 'DOUBLE',
};

interface SongMeta {
  title: string;
  titleTranslit: string | null;
  subtitle: string | null;
  subtitleTranslit: string | null;
  artist: string | null;
  artistTranslit: string | null;
}

interface RawChartBlock {
  stepsType: string | null;
  difficulty: string | null;
  meter: string | null;
  credit: string | null;
  description: string | null;
}

function blank(): RawChartBlock {
  return { stepsType: null, difficulty: null, meter: null, credit: null, description: null };
}

/** `null` for an empty tag value — StepMania writes `#TAG:;` for "no value", not an absent tag. */
function nullIfEmpty(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * "A case-insensitive search for `no cmod` across title and subtitle sets
 * the flag, which is how packs actually mark the restriction." Checked
 * against the raw fields only, per DESIGN.md's wording — not the
 * transliterations, which this pack convention doesn't use for it.
 */
function inferFlags(title: string, subtitle: string | null): ChartInput['flags'] {
  const haystack = `${title} ${subtitle ?? ''}`.toLowerCase();
  return haystack.includes('no cmod') ? ['noCmod'] : [];
}

function toChartInput(meta: SongMeta, block: RawChartBlock): ChartInput | null {
  if (!block.stepsType || !block.difficulty || !block.meter) return null;
  const playStyle = PLAY_STYLE[block.stepsType.toLowerCase()];
  const difficulty = DIFFICULTY_SLOT[block.difficulty.toLowerCase()];
  if (!playStyle || !difficulty) return null;

  return ChartInput.parse({
    title: meta.title,
    titleTranslit: meta.titleTranslit,
    subtitle: meta.subtitle,
    subtitleTranslit: meta.subtitleTranslit,
    artist: meta.artist,
    artistTranslit: meta.artistTranslit,
    playStyle,
    difficulty,
    meter: Math.round(Number(block.meter)),
    stepartist: block.credit,
    description: block.description,
    flags: inferFlags(meta.title, meta.subtitle),
  });
}

/**
 * Skips a note-data block without reading it — this parser only wants the
 * metadata that precedes `#NOTES:`. StepMania's grid rows never start with
 * `#`, and a lone `;` line is what actually closes the block in every file
 * this was built against; scanning for the first `#`-prefixed line after it
 * would also work but the `;` is unambiguous and matches the format.
 */
function skipNoteData(lines: string[], from: number): number {
  let i = from;
  while (i < lines.length && lines[i]!.trim() !== ';') i++;
  return i + 1;
}

function parseSsc(lines: string[]): ChartInput[] {
  const meta: SongMeta = {
    title: '',
    titleTranslit: null,
    subtitle: null,
    subtitleTranslit: null,
    artist: null,
    artistTranslit: null,
  };
  const charts: ChartInput[] = [];
  let current: RawChartBlock | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0 || line.startsWith('//')) continue;

    const match = /^#([A-Za-z]+):(.*?);?$/.exec(line);
    if (!match) continue;
    const tag = match[1]!.toUpperCase();
    const value = match[2]!;

    switch (tag) {
      case 'TITLE':
        meta.title = value.trim();
        break;
      case 'TITLETRANSLIT':
        meta.titleTranslit = nullIfEmpty(value);
        break;
      case 'SUBTITLE':
        meta.subtitle = nullIfEmpty(value);
        break;
      case 'SUBTITLETRANSLIT':
        meta.subtitleTranslit = nullIfEmpty(value);
        break;
      case 'ARTIST':
        meta.artist = nullIfEmpty(value);
        break;
      case 'ARTISTTRANSLIT':
        meta.artistTranslit = nullIfEmpty(value);
        break;
      case 'NOTEDATA':
        if (current) {
          const chart = toChartInput(meta, current);
          if (chart) charts.push(chart);
        }
        current = blank();
        break;
      case 'STEPSTYPE':
        if (current) current.stepsType = value.trim();
        break;
      case 'DIFFICULTY':
        if (current) current.difficulty = value.trim();
        break;
      case 'METER':
        if (current) current.meter = value.trim();
        break;
      case 'CREDIT':
        if (current) current.credit = nullIfEmpty(value);
        break;
      case 'DESCRIPTION':
        if (current) current.description = nullIfEmpty(value);
        break;
      case 'NOTES':
        i = skipNoteData(lines, i + 1) - 1;
        break;
    }
  }

  if (current) {
    const chart = toChartInput(meta, current);
    if (chart) charts.push(chart);
  }

  return charts;
}

/**
 * `.sm`'s single `#NOTES:` tag packs six colon-delimited fields on their own
 * lines: StepsType, Description, DifficultyClass, DifficultyMeter,
 * RadarValues, NoteData. "A `.sm` chart has only the one field: it becomes
 * the stepartist, and description is left empty" — DESIGN.md, "Client-Side
 * Song Pack Parsing".
 */
function parseSm(lines: string[]): ChartInput[] {
  const meta: SongMeta = {
    title: '',
    titleTranslit: null,
    subtitle: null,
    subtitleTranslit: null,
    artist: null,
    artistTranslit: null,
  };
  const charts: ChartInput[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0 || line.startsWith('//')) continue;

    if (line.toUpperCase() === '#NOTES:') {
      const fields: string[] = [];
      let j = i + 1;
      while (j < lines.length && fields.length < 5) {
        const fieldLine = lines[j]!.trim();
        if (fieldLine.length > 0) fields.push(fieldLine.replace(/:$/, ''));
        j++;
      }
      const [stepsType, description, difficulty, meterRaw] = fields;
      const chart = toChartInput(meta, {
        stepsType: stepsType ?? null,
        difficulty: difficulty ?? null,
        meter: meterRaw ?? null,
        credit: nullIfEmpty(description ?? ''),
        description: null,
      });
      if (chart) charts.push(chart);
      i = skipNoteData(lines, j) - 1;
      continue;
    }

    const match = /^#([A-Za-z]+):(.*?);?$/.exec(line);
    if (!match) continue;
    const tag = match[1]!.toUpperCase();
    const value = match[2]!;

    switch (tag) {
      case 'TITLE':
        meta.title = value.trim();
        break;
      case 'TITLETRANSLIT':
        meta.titleTranslit = nullIfEmpty(value);
        break;
      case 'SUBTITLE':
        meta.subtitle = nullIfEmpty(value);
        break;
      case 'SUBTITLETRANSLIT':
        meta.subtitleTranslit = nullIfEmpty(value);
        break;
      case 'ARTIST':
        meta.artist = nullIfEmpty(value);
        break;
      case 'ARTISTTRANSLIT':
        meta.artistTranslit = nullIfEmpty(value);
        break;
    }
  }

  return charts;
}

/**
 * One simfile can hold several charts — one `#NOTEDATA` block per
 * difficulty in `.ssc`, one `#NOTES:` tag per difficulty in `.sm`.
 * `sourcePack` is not set here; the pack this file lives in is knowledge
 * the caller has and this function does not.
 */
export function parseSimfile(filename: string, content: string): ChartInput[] {
  const lines = content.split(/\r?\n/);
  if (/\.ssc$/i.test(filename)) return parseSsc(lines);
  if (/\.sm$/i.test(filename)) return parseSm(lines);
  throw new Error(`parseSimfile: unrecognized extension on "${filename}" — expected .sm or .ssc`);
}

/**
 * Within one song folder, `.ssc` is "the newer authored form" and wins over
 * `.sm` where both exist for the same song. Pure — the directory walk that
 * calls this owns all filesystem access, per "a parser that assumes fs...
 * needs its I/O layer wrapped rather than used directly."
 */
export function pickPreferredSimfile(filenames: readonly string[]): string | null {
  const ssc = filenames.find((f) => /\.ssc$/i.test(f));
  if (ssc) return ssc;
  return filenames.find((f) => /\.sm$/i.test(f)) ?? null;
}
