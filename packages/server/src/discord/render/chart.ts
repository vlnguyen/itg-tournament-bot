import { displayArtist, displaySubtitle, displayTitle, playstylePrefix, type ChartSnapshot } from '@itg/shared';

/**
 * "Compact — `SX 12 · Vertex^` — for select-menu labels, inline references,
 * and the results feed." See DESIGN.md, "Presenting a chart". The
 * playstyle prefix always leads, since it's the fastest way to tell a
 * Singles chart from a Doubles one in a pack that may hold both.
 */
export function compactChartLabel(chart: ChartSnapshot): string {
  return `${playstylePrefix(chart.playStyle, chart.difficulty)} ${chart.meter} · ${displayTitle(chart)}`;
}

/**
 * "Full — compact, plus stepartist, source pack, length and any flags —
 * for embed fields and the Draw." No `length` field exists on a chart
 * anywhere in this system (`ChartSnapshot`/`Chart` never captured one), so
 * it's omitted here rather than faked.
 */
export function fullChartDescription(chart: ChartSnapshot): string {
  const lines = [compactChartLabel(chart)];
  const subtitle = displaySubtitle(chart);
  const artist = displayArtist(chart);
  if (subtitle || artist) {
    lines.push([subtitle, artist].filter((v): v is string => Boolean(v)).join(' — '));
  }
  if (chart.stepartist) lines.push(`Steps: ${chart.stepartist}`);
  if (chart.sourcePack) lines.push(`Pack: ${chart.sourcePack}`);
  if (chart.flags.length > 0) lines.push(`⚠️ ${chart.flags.join(', ')}`);
  return lines.join('\n');
}

const SELECT_FIELD_MAX = 100; // Discord's select-menu option label/description limit

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A select-menu option's label — the compact form, truncated to fit Discord's 100-character limit. */
export function selectOptionLabel(chart: ChartSnapshot): string {
  return truncate(compactChartLabel(chart), SELECT_FIELD_MAX);
}

/**
 * A select-menu option's description line — the metadata the compact label
 * has no room for, so the choice can be informed without cross-referencing
 * the Draw embed above. See DESIGN.md, "The Draw and Protect/Veto": "a
 * select menu holds twenty-five options, each with a label and a
 * description line, so the metadata sits with the choice." `undefined`
 * when there's nothing to add — an empty description is worse than none.
 */
export function selectOptionDescription(chart: ChartSnapshot): string | undefined {
  const parts = [displaySubtitle(chart), displayArtist(chart), chart.stepartist].filter(
    (v): v is string => Boolean(v),
  );
  if (chart.flags.length > 0) parts.push(`⚠️ ${chart.flags.join(', ')}`);
  return parts.length > 0 ? truncate(parts.join(' · '), SELECT_FIELD_MAX) : undefined;
}
