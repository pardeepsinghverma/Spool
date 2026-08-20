/**
 * Design tokens — Spool v2. See docs/UI.md before changing anything here.
 *
 * The system has two halves. Six colours are fixed and describe the app when no
 * artwork is current. Three more — tintDeep, tint and accent — are extracted
 * from the cover of whatever is playing and pushed in at runtime, so the app
 * reads as a frame around the art rather than chrome sitting on top of it.
 *
 * Constraint carried over from the source: React Native StyleSheet only — flat
 * fills, borders, opacity, transform. Tints are flat colours computed at decode
 * time, never live filters or gradients.
 */

/** The half that never moves. */
export const fixed = {
  base: '#0B0B0C',
  raised: '#1A1A1D',
  line: '#2B2B30',
  text: '#F5F2EE',
  dim: '#A5A09A',
  mute: '#5C5852',
  /** The completed-download tick, and only that. */
  saved: '#7FD8A6',
  /** Stalled and failed text. Never a colour flood. */
  warn: '#F0A868',
} as const;

/**
 * The half borrowed from the artwork.
 *
 * `deep` is the screen behind everything, `tint` the raised surface on top of
 * it, `accent` the active/selected colour. Text warms with the tint rather than
 * staying neutral — pure white on a sepia ground reads as a bug.
 */
export type Tint = {
  deep: string;
  tint: string;
  accent: string;
  /** Primary text on `deep`/`tint`. */
  on: string;
  /** Secondary text on `deep`/`tint`. */
  onDim: string;
  /** Text on top of `accent` itself. */
  onAccent: string;
};

/** The neutral fallback: what every screen shows with nothing playing. */
export const NEUTRAL: Tint = {
  deep: fixed.base,
  tint: fixed.raised,
  accent: '#F0C08A',
  on: fixed.text,
  onDim: fixed.dim,
  onAccent: '#241C15',
};

/**
 * Worked examples from the design, used as fixtures until real palette
 * extraction lands. Each was checked to clear 4.5:1 for `on` over `deep`.
 */
export const TINTS = {
  sepia: {
    deep: '#241C15',
    tint: '#3A2E22',
    accent: '#F0C08A',
    on: '#F5EFE7',
    onDim: '#B5A899',
    onAccent: '#241C15',
  },
  teal: {
    deep: '#0F2224',
    tint: '#1D3A3D',
    accent: '#78D6C6',
    on: '#EAF3F1',
    onDim: '#9DB8B4',
    onAccent: '#0F2224',
  },
  violet: {
    deep: '#1D1528',
    tint: '#33264A',
    accent: '#BFA3F0',
    on: '#F1EBFA',
    onDim: '#B0A3C4',
    onAccent: '#1D1528',
  },
} as const satisfies Record<string, Tint>;

export type TintName = keyof typeof TINTS;

/* --------------------------------------------------------------------------
 * Building a tint from real artwork
 * ------------------------------------------------------------------------ */

/**
 * The cover gives one thing: a hue. Everything else is fixed.
 *
 * This is how the three fixtures above were built, and reproducing that recipe
 * rather than sampling more colours out of the image is the whole point. A
 * palette taken wholesale from artwork is unreadable roughly as often as it is
 * beautiful — one dark album cover and the body text is grey on grey. Pinning
 * lightness and clamping saturation means the contrast the fixtures were
 * checked for holds for every cover, including the ones nobody tested.
 *
 * So the artwork moves the hue and, within limits, the intensity. It never gets
 * to decide how dark the ground is or how bright the text is.
 */
const RAMP = {
  deep: { l: 11, s: [18, 42] },
  tint: { l: 19, s: [16, 36] },
  accent: { l: 72, s: [45, 70] },
  on: { l: 94, s: [8, 30] },
  onDim: { l: 67, s: [8, 20] },
} as const;

/** Text on `deep` must clear this. The fixtures were all checked against it. */
const MIN_CONTRAST = 4.5;

export function tintFromDominant(hex: string): Tint {
  const rgb = parseHex(hex);
  if (!rgb) return NEUTRAL;
  const { h, s } = rgbToHsl(rgb);

  /**
   * A near-grey cover has no hue worth borrowing, and it must bypass the
   * saturation floors entirely rather than merely arriving at them with s=0:
   * clamping 0 into [45,70] is how a black-and-white photograph came out pink.
   * Grey artwork gets a grey app, which is the honest answer.
   */
  const grey = s < 6;
  const saturationFor = (step: { s: readonly [number, number] }) =>
    grey ? 0 : clamp(s, step.s[0], step.s[1]);

  const build = (step: { l: number; s: readonly [number, number] }) =>
    hslToHex(h, saturationFor(step), step.l);

  const deep = build(RAMP.deep);
  let on = build(RAMP.on);
  let onDim = build(RAMP.onDim);

  // Computed rather than assumed. The lightness targets make this hold for every
  // hue, but a ratio that is merely believed to be fine is how unreadable text
  // ships — so it is measured, and lifted if it ever comes up short.
  on = ensureContrast(on, deep, h, saturationFor(RAMP.on), RAMP.on.l);
  onDim = ensureContrast(onDim, deep, h, saturationFor(RAMP.onDim), RAMP.onDim.l);

  return {
    deep,
    tint: build(RAMP.tint),
    accent: build(RAMP.accent),
    on,
    onDim,
    // The ground itself, exactly as every fixture does it — accent is light, so
    // its ink is the darkest colour in the set.
    onAccent: deep,
  };
}

/** Lightens in 4% steps until the ratio clears, giving up rather than looping. */
function ensureContrast(
  colour: string,
  against: string,
  h: number,
  s: number,
  startL: number,
): string {
  let l = startL;
  let out = colour;
  for (let i = 0; i < 12 && contrast(out, against) < MIN_CONTRAST; i++) {
    l = Math.min(100, l + 4);
    out = hslToHex(h, s, l);
  }
  return out;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl([r, g, b]: [number, number, number]) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s: s * 100, l: l * 100 };
}

function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100;
  const ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = ln - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  const byte = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/** WCAG relative luminance and ratio — the same measure the fixtures were held to. */
function luminance(hex: string): number {
  const rgb = parseHex(hex) ?? [0, 0, 0];
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The composed runtime theme: fixed colours, the current tint, and the v1 names
 * still referenced by screens that have not been restyled. See ThemeContext.
 */
export type Theme = typeof fixed &
  Tint & {
    chrome: string;
    pageBg: string;
    surface: string;
    border: string;
    hair: string;
    icon: string;
    iconDisabled: string;
    textDim: string;
    accentSurface: string;
    success: string;
    successSurface: string;
    warnSurface: string;
    ph: string;
    phText: string;
    ringTrack: string;
    navHandle: string;
  };

/** @deprecated v1 name for Theme. */
export type Palette = Theme;

/**
 * Manrope throughout, IBM Plex Mono for anything measured.
 *
 * Mono is reserved for facts the user could check — bitrates, sizes, durations,
 * percentages. Never for prose. It is the difference between a claim and a
 * measurement, and the app makes a lot of both.
 */
export const type = {
  nowPlaying: { fontFamily: 'Manrope_700Bold', fontSize: 24, lineHeight: 30, letterSpacing: -0.5 },
  screenTitle: { fontFamily: 'Manrope_600SemiBold', fontSize: 20, lineHeight: 25, letterSpacing: -0.3 },
  rowTitle: { fontFamily: 'Manrope_600SemiBold', fontSize: 15, lineHeight: 20 },
  body: { fontFamily: 'Manrope_400Regular', fontSize: 13, lineHeight: 18 },
  section: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 0.77,
    textTransform: 'uppercase',
  },
  mono: { fontFamily: 'IBMPlexMono_400Regular', fontSize: 11.5, lineHeight: 15 },
  monoStrong: { fontFamily: 'IBMPlexMono_500Medium', fontSize: 11.5, lineHeight: 15 },
  /** Tab bar labels and chips, which sit below the body scale. */
  tab: { fontFamily: 'Manrope_500Medium', fontSize: 10, lineHeight: 13 },
  tabActive: { fontFamily: 'Manrope_600SemiBold', fontSize: 10, lineHeight: 13 },
  chip: { fontFamily: 'Manrope_500Medium', fontSize: 12.5, lineHeight: 16 },
  chipActive: { fontFamily: 'Manrope_600SemiBold', fontSize: 12.5, lineHeight: 16 },

  /** @deprecated v1 list-row title, between rowTitle and body. */
  itemTitle: { fontFamily: 'Manrope_600SemiBold', fontSize: 13.5, lineHeight: 18 },
  /** @deprecated v1 pill label. */
  pill: { fontFamily: 'Manrope_400Regular', fontSize: 13.5, lineHeight: 18 },
} as const;

/**
 * 4dp base.
 *
 * The `*Legacy` entries are v1 names kept so unmigrated screens still compile.
 * They resolve to the same numbers under v2 names; delete each as its screen
 * moves over.
 */
export const space = {
  iconToLabel: 4,
  insideChip: 8,
  row: 12,
  gutter: 16,
  section: 24,
  header: 32,

  /** @deprecated v1 name for insideChip. */
  insidePill: 8,
  /** @deprecated v1 name for row. */
  barSide: 12,
  /** @deprecated v1 name for section. */
  sheetBlock: 24,
  /** @deprecated v1 name for header. */
  emptyState: 32,
} as const;

export const size = {
  tabBar: 60,
  miniPlayer: 58,
  target: 48,
  /** Mini player artwork: square for audio, 16:9 for video. */
  miniArt: 40,
  miniArtVideoW: 62,
  miniArtVideoH: 36,
  rowArt: 46,
  cardArt: 124,
  fab: 56,

  /** @deprecated v1 names, kept until the browser chrome is restyled. */
  bar: 52,
  ring: 40,
  pillHeight: 36,
  navButton: 40,
} as const;

export const radius = {
  art: 10,
  chip: 18,
  sheet: 20,
  fab: 28,

  /** @deprecated v1 name for chip. */
  pill: 18,
  /** @deprecated v1 card corner. */
  card: 8,
} as const;

/**
 * The art transition is the only long one. Everything the finger causes
 * resolves under 300ms; the tint follows the artwork on its own schedule.
 *
 * `tabSwitch: 0` is deliberate — a tab that animates feels slower than one that
 * does not, and there is nothing to explain between two lists.
 */
export const motion = {
  tap: 90,
  tabSwitch: 0,
  tintRecolour: 420,
  miniToFull: 340,
  fullToMini: 260,
  playerSwap: 200,
  sheetIn: 280,
  sheetOut: 220,
  progressStep: 240,
  /** FAB wake: three pulses on a watch page, then never again. */
  fabPulse: 1800,
  fabPulses: 3,
  spin: 900,

  /** @deprecated v1 names, kept until the browser chrome is restyled. */
  pulseCycle: 1800,
  pulseCycles: 3,
  pillSwap: 200,
  iconCrossfade: 180,
  breath: 2400,
  doneHold: 1600,
  doneDecay: 240,
  reducedPillHold: 2500,
} as const;

export const bezier = {
  standard: [0.4, 0, 0.2, 1],
  emphasized: [0.2, 0, 0, 1],

  /** @deprecated v2 has two curves; this maps onto standard. */
  decelerate: [0, 0, 0.2, 1],
} as const;

/** Circumference of the r=14 download ring: 2πr ≈ 88. */
export const RING_CIRCUMFERENCE = 88;
export const RING_RADIUS = 14;
