/**
 * The first thing in the bundle that runs.
 *
 * This exists as its own module because of an ordering rule that is easy to get
 * wrong: ES imports are hoisted and evaluated *before* any statement in the
 * importing module's body. Calling `installDiagnostics()` from `index.ts` would
 * therefore run it after the whole app tree had already been imported — and a
 * module-level throw anywhere in that tree is exactly the crash with no
 * evidence that these captures exist to explain.
 *
 * Imports are evaluated in source order, so a side-effect module listed first
 * is the one lever that does work. Keep this import at the top of `index.ts`.
 */

import { installDiagnostics } from './crash';
import { info, restore } from './log';

installDiagnostics();

// Moves the previous run's tail aside before this one starts writing over it.
// Not awaited: nothing about registering the root component should wait on
// storage, and entries recorded before it lands are still kept in memory.
void restore();

info('boot', 'bundle loaded');
