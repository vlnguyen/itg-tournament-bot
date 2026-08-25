import { describe, expect, it } from 'vitest';
import { parseSimfile, pickPreferredSimfile } from './simfile-parser.js';

/**
 * The header tags and a truncated note block from a real `.ssc` chart in a
 * tournament pack — every tag line is verbatim from the source file, only
 * the note grid is cut down to a couple of measures. Per DESIGN.md's
 * Testing Strategy table: "Simfile parser | Golden-file tests over a small
 * corpus of real `.sm` and `.ssc` files."
 */
const SPEED_DATING_SSC = `#VERSION:0.83;
#TITLE:[11] Speed Dating (Hard);
#SUBTITLE:;
#ARTIST:DJ Sugarush, Jai Piccone, Hotel Rubio;
#TITLETRANSLIT:;
#SUBTITLETRANSLIT:;
#ARTISTTRANSLIT:;
#GENRE:Speeddatingcore;
#CREDIT:;
#MUSIC:speed dating.ogg;
#BANNER:bn.jpg;
#BACKGROUND:;
#CDTITLE:;
#SAMPLESTART:98.897;
#SAMPLELENGTH:13.241;
#SELECTABLE:YES;
#OFFSET:-0.005;
#BPMS:0.000=145.000;
#STOPS:;
#BGCHANGES:;
#FGCHANGES:;
//--------------- dance-single - BR+ JU+ FS XO ----------------
#NOTEDATA:;
#STEPSTYPE:dance-single;
#DESCRIPTION:BR+ JU+ FS XO;
#DIFFICULTY:Challenge;
#METER:11;
#RADARVALUES:0,0,0,0,0;
#CREDIT:midtown;
#CHARTNAME:;
#NOTES:
0000
0000
0000
0000
,
0000
0000
0000
0000
;
`;

/** Real `.ssc` excerpt — `(No CMOD)` lives in `#SUBTITLE`, not the title. */
const IN_THE_MUSEUM_SSC = `#VERSION:0.83;
#TITLE:[10] In the Museum;
#SUBTITLE:(No CMOD);
#ARTIST:Sta;
#TITLETRANSLIT:;
#SUBTITLETRANSLIT:;
#ARTISTTRANSLIT:;
#NOTEDATA:;
#STEPSTYPE:dance-single;
#DESCRIPTION:;
#DIFFICULTY:Challenge;
#METER:10;
#CREDIT:;
#NOTES:
0000
0000
;
`;

/** Real `.ssc` excerpt with a Japanese title and populated translit fields. */
const HIGASHI_SSC = `#VERSION:0.83;
#TITLE:[U] [13] 東;
#SUBTITLE:;
#ARTIST:かたぎり;
#TITLETRANSLIT:[U] [13] Higashi;
#SUBTITLETRANSLIT:;
#ARTISTTRANSLIT:katagiri;
#NOTEDATA:;
#STEPSTYPE:dance-single;
#DESCRIPTION:Mirin;
#DIFFICULTY:Challenge;
#METER:13;
#CREDIT:;
#NOTES:
0000
0000
;
`;

/** A pack that also carries a Doubles chart and an Edit — both meaningful cases for skip/keep. */
const MULTI_CHART_SSC = `#TITLE:Two Charts;
#SUBTITLE:;
#ARTIST:Someone;
#TITLETRANSLIT:;
#SUBTITLETRANSLIT:;
#ARTISTTRANSLIT:;
#NOTEDATA:;
#STEPSTYPE:dance-double;
#DESCRIPTION:;
#DIFFICULTY:Hard;
#METER:15;
#CREDIT:Author A;
#NOTES:
00000000
00000000
;
#NOTEDATA:;
#STEPSTYPE:dance-single;
#DESCRIPTION:;
#DIFFICULTY:Edit;
#METER:20;
#CREDIT:Author B;
#NOTES:
0000
0000
;
`;

/**
 * A hand-written `.sm` fixture — the pack used for the other fixtures here
 * is entirely `.ssc`, so this exercises the older colon-delimited
 * `#NOTES:` grammar directly against the stepmania.com spec instead of a
 * real file. "A `.sm` chart has only the one field: it becomes the
 * stepartist, and description is left empty." — DESIGN.md.
 */
const SYNTHETIC_SM = `#TITLE:Old School Jam;
#SUBTITLE:;
#ARTIST:Retro Artist;
#NOTES:
     dance-single:
     Some Stepper:
     Challenge:
     9:
     0.100,0.200,0.300,0.000,5.000:
0000
0000
;
`;

describe('parseSimfile — .ssc', () => {
  it('extracts title, artist, difficulty, meter, stepartist, and description', () => {
    const charts = parseSimfile('speed dating.ssc', SPEED_DATING_SSC);
    expect(charts).toHaveLength(1);
    expect(charts[0]).toMatchObject({
      title: '[11] Speed Dating (Hard)',
      titleTranslit: null,
      artist: 'DJ Sugarush, Jai Piccone, Hotel Rubio',
      playStyle: 'SINGLE',
      difficulty: 'EXPERT',
      meter: 11,
      stepartist: 'midtown',
      description: 'BR+ JU+ FS XO',
      flags: [],
    });
  });

  it('infers noCmod from the subtitle, not just the title', () => {
    const charts = parseSimfile('In the Museum.ssc', IN_THE_MUSEUM_SSC);
    expect(charts[0]).toMatchObject({
      subtitle: '(No CMOD)',
      flags: ['noCmod'],
    });
  });

  it('keeps title and titleTranslit separate, and reads artistTranslit', () => {
    const charts = parseSimfile('chart.ssc', HIGASHI_SSC);
    expect(charts[0]).toMatchObject({
      title: '[U] [13] 東',
      titleTranslit: '[U] [13] Higashi',
      artist: 'かたぎり',
      artistTranslit: 'katagiri',
      description: 'Mirin',
      stepartist: null,
    });
  });

  it('parses every #NOTEDATA block, skipping stepstypes and difficulties this schema has no slot for', () => {
    const charts = parseSimfile('multi.ssc', MULTI_CHART_SSC);
    // The Doubles Hard chart survives; the Edit is dropped — no DifficultySlot for it.
    expect(charts).toHaveLength(1);
    expect(charts[0]).toMatchObject({ playStyle: 'DOUBLE', difficulty: 'HARD', meter: 15, stepartist: 'Author A' });
  });
});

describe('parseSimfile — .sm', () => {
  it("reads the second #NOTES field as stepartist, and leaves description blank", () => {
    const charts = parseSimfile('old school jam.sm', SYNTHETIC_SM);
    expect(charts).toHaveLength(1);
    expect(charts[0]).toMatchObject({
      title: 'Old School Jam',
      artist: 'Retro Artist',
      playStyle: 'SINGLE',
      difficulty: 'EXPERT',
      meter: 9,
      stepartist: 'Some Stepper',
      description: null,
    });
  });
});

describe('pickPreferredSimfile', () => {
  it('prefers .ssc over .sm for the same song', () => {
    expect(pickPreferredSimfile(['song.sm', 'song.ssc'])).toBe('song.ssc');
  });

  it('falls back to .sm when no .ssc exists', () => {
    expect(pickPreferredSimfile(['song.sm'])).toBe('song.sm');
  });

  it('returns null when neither exists', () => {
    expect(pickPreferredSimfile(['banner.png', 'song.ogg'])).toBeNull();
  });
});
