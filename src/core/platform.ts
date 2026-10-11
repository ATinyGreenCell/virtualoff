/**
 * Edge on Xbox starts every page in "browsing controls": the stick drives a cursor and B goes back a
 * page. Holding the Menu button and picking "Use game controls" hands both controllers to the game.
 */
export const IS_XBOX = typeof navigator !== 'undefined' && /\bXbox\b/i.test(navigator.userAgent);

export const XBOX_HINT =
  'XBOX: hold <b>☰ MENU</b> and choose <b>Use game controls</b> so the game gets both controllers · hold <b>⧉ VIEW</b> for full screen';

/** Edge on Xbox can lose focus (e.g. after the View button), and an unfocused page gets no controller input. */
export const XBOX_REFOCUS = 'controllers not responding? press the Xbox button twice to give the game focus again';
