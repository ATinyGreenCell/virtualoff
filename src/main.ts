import '@fontsource/russo-one/latin-400.css';
import '@fontsource/chakra-petch/latin-400.css';
import '@fontsource/chakra-petch/latin-600.css';
import '@fontsource/chakra-petch/latin-700.css';
import './style.css';
import { App } from './app';
import { audio } from './audio/audio';
import { TouchControls } from './core/touch';
import { Flow } from './flow';

// iOS/Safari only let an AudioContext start or resume inside the gesture handler itself, and may
// suspend it again after the app is backgrounded — so keep these installed (unlock() is idempotent).
const unlockAudio = () => audio.unlock();
for (const type of ['pointerdown', 'keydown', 'touchend'] as const) {
  window.addEventListener(type, unlockAudio, { capture: true, passive: true });
}

async function loadFonts() {
  if (!document.fonts) return;
  const fonts = Promise.all([document.fonts.load('64px "Russo One"'), document.fonts.load('700 32px "Chakra Petch"')]);
  // canvas-painted floor lettering needs the font ready; never block boot for long
  await Promise.race([fonts, new Promise((r) => setTimeout(r, 1500))]).catch(() => undefined);
}

async function boot() {
  const root = document.getElementById('app')!;
  await loadFonts();
  let app: App;
  try {
    app = new App(root);
  } catch (err) {
    console.error(err);
    root.innerHTML = `<div class="fatal"><b>VIRTUAL-OFF</b><p>WebGL is not available in this browser, so the arena can't be rendered.</p></div>`;
    return;
  }
  app.touch = new TouchControls(root, app.input);
  const flow = new Flow(app);
  // invite links look like …/#vs=K7QX — drop straight into joining that room
  const invite = /(?:^|[#&])vs=([A-Za-z0-9]{4})/.exec(location.hash);
  if (invite) {
    history.replaceState(null, '', location.pathname + location.search);
    flow.versus({ joinCode: invite[1].toUpperCase() });
  } else {
    flow.title();
  }
  app.start();
  if (import.meta.env.DEV) Object.assign(window, { __vo: { app, flow, audio } });
}

void boot();
