import { describe, expect, it } from 'vitest';
import { parseZipEntries } from './parse-zip.js';

const encoder = new TextEncoder();

const MINIMAL_SM = `#TITLE:Test Song;
#SUBTITLE:;
#ARTIST:Test Artist;
#NOTES:
     dance-single:
     Test Stepartist:
     Challenge:
     12:
     0,0,0,0,0:
0000
0000
0000
0000
;
`;

function zipEntries(files: Record<string, string>): Record<string, Uint8Array> {
  return Object.fromEntries(Object.entries(files).map(([path, content]) => [path, encoder.encode(content)]));
}

describe('parseZipEntries', () => {
  it('parses a chart from a song folder inside the zip', () => {
    const entries = zipEntries({
      'MyPack/Test Song/test song.sm': MINIMAL_SM,
      'MyPack/Test Song/bg.png': '',
    });
    const charts = parseZipEntries(entries);
    expect(charts).toHaveLength(1);
    expect(charts[0]!.title).toBe('Test Song');
    expect(charts[0]!.stepartist).toBe('Test Stepartist');
  });

  it('prefers .ssc over .sm when a folder has both', () => {
    const entries = zipEntries({
      'MyPack/Test Song/test song.sm': MINIMAL_SM,
      'MyPack/Test Song/test song.ssc': MINIMAL_SM.replace('Test Song', 'SSC Wins'),
    });
    const charts = parseZipEntries(entries);
    expect(charts.every((c) => c.title === 'SSC Wins')).toBe(true);
  });

  it('parses multiple song folders independently', () => {
    const entries = zipEntries({
      'MyPack/Song A/a.sm': MINIMAL_SM.replace('Test Song', 'Song A'),
      'MyPack/Song B/b.sm': MINIMAL_SM.replace('Test Song', 'Song B'),
    });
    const charts = parseZipEntries(entries);
    expect(charts.map((c) => c.title).sort()).toEqual(['Song A', 'Song B']);
  });

  it('skips a folder with no .sm/.ssc file, and ignores non-simfile entries entirely', () => {
    const entries = zipEntries({
      'MyPack/Just Art/cover.png': '',
      'MyPack/Pack.ini': 'DisplayTitle=Test',
    });
    expect(parseZipEntries(entries)).toEqual([]);
  });

  it('does not fail the whole batch when one simfile is malformed', () => {
    const entries = zipEntries({
      'MyPack/Broken/broken.sm': 'not a valid simfile at all',
      'MyPack/Good/good.sm': MINIMAL_SM,
    });
    const charts = parseZipEntries(entries);
    expect(charts.map((c) => c.title)).toEqual(['Test Song']);
  });
});
