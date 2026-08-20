import { View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  useFonts,
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
} from '@expo-google-fonts/manrope';
import {
  IBMPlexMono_400Regular,
  IBMPlexMono_500Medium,
} from '@expo-google-fonts/ibm-plex-mono';
import { BrowserScreen } from './src/browser/BrowserScreen';
import { PlayerProvider } from './src/player/PlayerContext';
import { ThemeProvider } from './src/ui/ThemeContext';
import { fixed } from './src/ui/theme';

export default function App() {
  // The type scale names these families directly, so rendering before they load
  // would flash the system face at the wrong metrics on every launch.
  const [fontsReady] = useFonts({
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    IBMPlexMono_400Regular,
    IBMPlexMono_500Medium,
  });

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        {/* Playback outlives any one screen — it has to keep going while the
            user is in another tab, or with the app closed entirely. */}
        <PlayerProvider>
          {fontsReady ? <Root /> : <Splash />}
        </PlayerProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

/** The base ground, so the hold before fonts land reads as the app, not a gap. */
function Splash() {
  return (
    <>
      <StatusBar style="light" />
      <View style={{ flex: 1, backgroundColor: fixed.base }} />
    </>
  );
}

function Root() {
  // v2 has one dark ground whose surfaces borrow from the artwork, so the
  // status bar no longer follows the page — it is always light-on-dark.
  return (
    <>
      <StatusBar style="light" />
      <BrowserScreen />
    </>
  );
}
