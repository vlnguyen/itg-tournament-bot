import { displayStepartistLine, displaySubtitle, displayTitle, playstylePrefix, type ChartFlag, type ChartSnapshot } from '@itg/shared';

/** `SX 12` — playstyle prefix, then the numeric meter. */
function difficultySuffix(chart: ChartSnapshot): string {
  return `${playstylePrefix(chart.playStyle, chart.difficulty)} ${chart.meter}`;
}

/**
 * The compact form — title, then the difficulty/meter, trailing rather
 * than leading. See DESIGN.md, "Presenting a chart", though as of this
 * pass the title leads and there's no `·` separator between it and the
 * difficulty/meter. A static-pool format's song leads with its shorthand
 * pool label (RD1, FT2, TB, ...) — the specific-song half of the
 * shorthand-vs-full-name rule; embeds render markdown, so this bolds it
 * the same way `fullChartDescription`/`buildDrawStatusLines` do.
 */
export function compactChartLabel(chart: ChartSnapshot): string {
  const prefix = chart.poolLabel ? `**${chart.poolLabel}** ` : '';
  return `${prefix}${displayTitle(chart)} ${difficultySuffix(chart)}`;
}

/** The title with the subtitle concatenated on, space-separated, then the difficulty/meter trailing. */
export function titleWithSubtitle(chart: ChartSnapshot): string {
  const subtitle = displaySubtitle(chart);
  const title = subtitle ? `${displayTitle(chart)} ${subtitle}` : displayTitle(chart);
  return `${title} ${difficultySuffix(chart)}`;
}

/**
 * The only flag that exists — see `ChartFlag` in `@itg/shared`. A general
 * label map is premature for a one-element set. `flags` is never rendered
 * via its raw string value anywhere in this file — every user-facing
 * surface goes through this, so "noCmod" itself is never shown.
 */
const FLAG_LABEL: Record<ChartFlag, string> = { noCmod: 'No CMOD' };

/**
 * The detailed view — an embed field on the Draw and the song-scoring
 * prompt. Title and subtitle share the compact form's line rather than
 * getting one each; the artist and source pack don't surface here at all.
 * A flag comes before the stepartist line — it's the more urgent fact.
 */
/**
 * `showPoolLabel: false` drops the shorthand prefix a static-pool chart
 * otherwise leads with — for a caller that already shows the label some
 * other way (the "Song Pool" embed's field name is the label itself), so
 * it isn't repeated in the field's own value.
 */
export function fullChartDescription(chart: ChartSnapshot, opts: { showPoolLabel?: boolean } = {}): string {
  // Same shorthand-first rule as `selectOptionLabel` — a specific song
  // always leads with RD1/FT2/TB/etc. when it has one.
  const showPoolLabel = opts.showPoolLabel ?? true;
  const title = chart.poolLabel && showPoolLabel ? `**${chart.poolLabel}** ${titleWithSubtitle(chart)}` : titleWithSubtitle(chart);
  const lines = [title];
  if (chart.flags.length > 0) lines.push(`⚠️ ${chart.flags.map((f) => FLAG_LABEL[f]).join(', ')}`);
  const stepLine = displayStepartistLine(chart);
  if (stepLine) lines.push(stepLine);
  return lines.join('\n');
}

const SELECT_FIELD_MAX = 100; // Discord's select-menu option label/description limit

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * A select-menu option's label — the compact form with the subtitle
 * concatenated on, truncated to fit Discord's 100-character limit. A
 * flagged chart gets its warning icon appended here too: "Flags surface at
 * all three points requirements demand" (DESIGN.md, "The Draw and
 * Protect/Veto") includes the Protect/Veto select menu, and a flag buried
 * in the description line would need expanding to see — the label is
 * what's visible without that.
 */
export function selectOptionLabel(chart: ChartSnapshot): string {
  // A static-pool format's song always leads with its shorthand label
  // (RD1, FT2, ...) — the specific-song half of the shorthand-vs-full-name
  // rule, and there's no room for the spelled-out category here anyway.
  const prefix = chart.poolLabel ? `${chart.poolLabel}: ` : '';
  const label = prefix + titleWithSubtitle(chart);
  const flagged = chart.flags.includes('noCmod') ? `${label} ⚠️` : label;
  return truncate(flagged, SELECT_FIELD_MAX);
}

/**
 * A select-menu option's description line — the metadata the label has no
 * room for, so the choice can be informed without cross-referencing the
 * Draw embed above. See DESIGN.md, "The Draw and Protect/Veto": "a select
 * menu holds twenty-five options, each with a label and a description
 * line, so the metadata sits with the choice." The subtitle lives on the
 * label now, not here; no artist either. `undefined` when there's nothing
 * to add — an empty description is worse than none.
 */
export function selectOptionDescription(chart: ChartSnapshot): string | undefined {
  const parts = [displayStepartistLine(chart)].filter((v): v is string => Boolean(v));
  if (chart.flags.length > 0) parts.push(`⚠️ ${chart.flags.map((f) => FLAG_LABEL[f]).join(', ')}`);
  return parts.length > 0 ? truncate(parts.join(' · '), SELECT_FIELD_MAX) : undefined;
}
