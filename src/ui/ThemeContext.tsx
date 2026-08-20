import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { NEUTRAL, fixed, type Theme, type Tint } from './theme';

/**
 * The live theme: six fixed colours plus whatever the current artwork lent us.
 *
 * See docs/UI.md. The v1 palette had two fixed themes that followed the web
 * page; v2 has one dark ground whose surfaces borrow from the cover of what is
 * playing. Screens with nothing playing sit on NEUTRAL.
 *
 * `compose` also fills in the v1 token names so screens that have not been
 * restyled still render — and render in v2 colours rather than the old palette.
 * Delete each alias as its screen moves over; nothing new should reach for them.
 */

export type { Theme };

function compose(t: Tint): Theme {
  return {
    ...fixed,
    ...t,
    chrome: t.deep,
    pageBg: fixed.base,
    surface: t.tint,
    border: fixed.line,
    hair: fixed.line,
    icon: t.on,
    iconDisabled: fixed.mute,
    textDim: t.onDim,
    accentSurface: t.tint,
    success: fixed.saved,
    successSurface: t.tint,
    warnSurface: t.tint,
    ph: fixed.raised,
    phText: fixed.mute,
    ringTrack: t.tint,
    navHandle: fixed.mute,
  };
}

type ThemeValue = {
  t: Theme;
  /** The raw artwork tint, for surfaces that need it without the aliases. */
  tint: Tint;
  /** Null returns the app to the neutral ground. */
  setTint: (tint: Tint | null) => void;
  /** True when the OS asks for reduced motion. */
  reduced: boolean;
};

const ThemeCtx = createContext<ThemeValue>({
  t: compose(NEUTRAL),
  tint: NEUTRAL,
  setTint: () => {},
  reduced: false,
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [tint, setTintState] = useState<Tint>(NEUTRAL);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (alive) setReduced(v);
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  const setTint = useCallback((next: Tint | null) => setTintState(next ?? NEUTRAL), []);

  const value = useMemo<ThemeValue>(
    () => ({ t: compose(tint), tint, setTint, reduced }),
    [tint, setTint, reduced],
  );

  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export const useTheme = () => useContext(ThemeCtx);
