import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { DARK, LIGHT, type Palette } from './theme';

export type ThemeName = 'dark' | 'light';

type ThemeValue = {
  t: Palette;
  name: ThemeName;
  setName: (name: ThemeName) => void;
  /** True when the OS asks for reduced motion. */
  reduced: boolean;
};

const ThemeCtx = createContext<ThemeValue>({
  t: DARK,
  name: 'dark',
  setName: () => {},
  reduced: false,
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [name, setName] = useState<ThemeName>('dark');
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

  const value = useMemo<ThemeValue>(
    () => ({ t: name === 'dark' ? DARK : LIGHT, name, setName, reduced }),
    [name, reduced],
  );

  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export const useTheme = () => useContext(ThemeCtx);
