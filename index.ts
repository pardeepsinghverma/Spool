// First, and it has to stay first: this installs the crash captures and the
// console bridge as a side effect of being imported. Imports are evaluated in
// source order, so anything above this line runs unwatched. See bootstrap.ts.
import './src/core/bootstrap';

import { registerRootComponent } from 'expo';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
