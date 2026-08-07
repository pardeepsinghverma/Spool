/**
 * Design tokens — ported from "Browser Design System.dc.html".
 *
 * Two themes, identical token names. The bar reads the page's theme from the
 * WebView and swaps the set; nothing else in the system branches on theme.
 *
 * Constraint carried over from the source: React Native StyleSheet only —
 * flat fills, borders, opacity, transform. No gradients, no shadow spread,
 * no filters. Every value here is expressible in RN.
 */

export type Palette = {
  pageBg: string;
  chrome: string;
  border: string;
  hair: string;
  surface: string;
  text: string;
  textDim: string;
  icon: string;
  iconDisabled: string;
  accent: string;
  accentSurface: string;
  onAccent: string;
  success: string;
  successSurface: string;
  warn: string;
  warnSurface: string;
  ph: string;
  phText: string;
  ringTrack: string;
  navHandle: string;
};

export const DARK: Palette = {
  pageBg: '#0F0F0F',
  chrome: '#0F0F0F',
  border: '#272727',
  hair: '#1B1B1B',
  surface: '#212121',
  text: '#F1F1F1',
  textDim: '#909090',
  icon: '#E8E8E8',
  iconDisabled: '#4A4A4A',
  accent: '#3EA6FF',
  accentSurface: '#123047',
  onAccent: '#0F0F0F',
  success: '#4ADE80',
  successSurface: '#12341F',
  warn: '#F5A524',
  warnSurface: '#3A2A12',
  ph: '#272727',
  phText: '#909090',
  ringTrack: '#123047',
  navHandle: '#3A3A3A',
};

export const LIGHT: Palette = {
  pageBg: '#FFFFFF',
  chrome: '#FFFFFF',
  border: '#E5E5E5',
  hair: '#EFEFEF',
  surface: '#F2F2F2',
  text: '#0F0F0F',
  textDim: '#606060',
  icon: '#1F1F1F',
  iconDisabled: '#C4C4C4',
  accent: '#065FD4',
  accentSurface: '#DEF1FF',
  onAccent: '#FFFFFF',
  success: '#137333',
  successSurface: '#E3F5E9',
  warn: '#8A5300',
  warnSurface: '#FDF0D9',
  ph: '#EDEDED',
  phText: '#909090',
  ringTrack: '#DEF1FF',
  navHandle: '#C4C4C4',
};

/** Roboto is the platform face on Android, so weights map straight through. */
export const type = {
  screenTitle: { fontSize: 22, lineHeight: 28, fontWeight: '500' },
  rowTitle: { fontSize: 16, lineHeight: 22, fontWeight: '500' },
  itemTitle: { fontSize: 13.5, lineHeight: 18, fontWeight: '500' },
  body: { fontSize: 14, lineHeight: 20, fontWeight: '400' },
  pill: { fontSize: 13.5, fontWeight: '400' },
  meta: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
  label: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '500',
    letterSpacing: 0.66,
    textTransform: 'uppercase',
  },
} as const;

/** 4dp base. */
export const space = {
  iconToLabel: 4,
  insidePill: 8,
  barSide: 12,
  gutter: 16,
  sheetBlock: 24,
  emptyState: 32,
} as const;

export const size = {
  bar: 52,
  target: 48,
  navButton: 40,
  pillHeight: 36,
  ring: 40,
} as const;

export const radius = {
  pill: 18,
  sheet: 16,
  card: 8,
} as const;

/**
 * Durations in ms. The pulse count matters: three cycles then stop forever —
 * long enough to catch peripheral vision once, short enough that it never
 * becomes a thing to ignore.
 */
export const motion = {
  tap: 90,
  iconCrossfade: 180,
  pillSwap: 200,
  progressStep: 240,
  sheetIn: 280,
  sheetOut: 220,
  pulseCycle: 1600,
  pulseCycles: 3,
  spin: 900,
  breath: 2400,
  doneHold: 1600,
  doneDecay: 240,
  /** Pill borrows the line for this long when motion is suppressed. */
  reducedPillHold: 2500,
} as const;

export const bezier = {
  standard: [0.4, 0, 0.2, 1],
  decelerate: [0, 0, 0.2, 1],
  emphasized: [0.2, 0, 0, 1],
} as const;

/** Circumference of the r=16 progress ring: 2πr ≈ 100.5. */
export const RING_CIRCUMFERENCE = 100.5;
export const RING_RADIUS = 16;
