/**
 * The last thing between a render fault and a white screen.
 *
 * React unmounts the whole tree when a render throws and nothing catches it,
 * which in a release build leaves the app on a blank ground with no message,
 * no way back, and — until now — nothing written down. That is the single worst
 * failure this app can present, because it is indistinguishable from a freeze
 * and the user's only move is to kill it.
 *
 * So: record it with the flight recorder, show what happened, and offer the one
 * action that is honest here. Re-mounting the same tree with the same state is
 * a coin flip, but it costs nothing and it is what a user would try anyway; the
 * alternative is a screen whose only affordance is force-stopping the app.
 *
 * This deliberately does **not** style itself from the theme. The theme is
 * React context, and a boundary that needs a working provider above it to draw
 * its own error message has a second failure mode built in.
 */

import { Component, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { describe, error as logError, flush } from '../core/log';
import { fixed } from './theme';

type Props = { children: ReactNode };
type State = { crashed: boolean; message: string; attempt: number };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { crashed: false, message: '', attempt: 0 };

  static getDerivedStateFromError(e: unknown): Partial<State> {
    return { crashed: true, message: e instanceof Error ? e.message : String(e) };
  }

  componentDidCatch(e: unknown, info: { componentStack?: string }) {
    logError('crash', 'render failed', {
      ...describe(e),
      // The component stack names the screen, which the JS stack does not: a
      // bundle offset says where the throw was, not which surface was drawing.
      componentStack: info?.componentStack?.split('\n').slice(0, 12).join('\n'),
      attempt: this.state.attempt,
    });
    void flush();
  }

  private retry = () => {
    this.setState((s) => ({ crashed: false, message: '', attempt: s.attempt + 1 }));
  };

  render() {
    if (!this.state.crashed) return this.props.children;

    return (
      <View style={{ flex: 1, backgroundColor: fixed.base, padding: 24, justifyContent: 'center' }}>
        <Text style={{ color: fixed.text, fontSize: 20, marginBottom: 8 }}>
          Spool hit a problem
        </Text>
        <Text style={{ color: fixed.dim, fontSize: 14, marginBottom: 16 }}>
          It has been written to the diagnostic log. Profile → Export diagnostics
          will save it as a file.
        </Text>
        <ScrollView style={{ maxHeight: 180, marginBottom: 20 }}>
          <Text style={{ color: fixed.warn, fontSize: 12, fontFamily: 'IBMPlexMono_400Regular' }}>
            {this.state.message}
          </Text>
        </ScrollView>
        <Pressable
          onPress={this.retry}
          style={{
            backgroundColor: fixed.raised,
            borderColor: fixed.line,
            borderWidth: 1,
            borderRadius: 12,
            paddingVertical: 14,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: fixed.text, fontSize: 15 }}>Try again</Text>
        </Pressable>
      </View>
    );
  }
}
