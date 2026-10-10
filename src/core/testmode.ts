/**
 * Dev-only switches for the end-to-end tests, read from the URL. Each is guarded by
 * import.meta.env.DEV, so production builds fold them to constants and drop the code entirely —
 * players can't toggle them.
 *
 *   ?fast     non-gameplay waits — intros, round banners, KO slow-mo, result screens, menu lead-ins —
 *             run 5× quicker (fights themselves are untouched)
 *   ?noaudio  skip synthesizing the sound library (for tests that don't listen)
 *   ?grace=N  versus reconnect grace period in seconds (default 20)
 */
const query = () => (typeof location !== 'undefined' ? location.search : '');

export const FAST = import.meta.env.DEV && /[?&]fast\b/.test(query());
export const NO_AUDIO = import.meta.env.DEV && /[?&]noaudio\b/.test(query());
export const GRACE_S = import.meta.env.DEV ? Number(/[?&]grace=(\d+)/.exec(query())?.[1] ?? 0) : 0;

/** Step for a ceremony timer (anything the player waits through rather than plays). */
export const ceremony = (dt: number) => (FAST ? dt * 5 : dt);
