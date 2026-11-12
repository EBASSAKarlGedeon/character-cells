// Character Cells — internal-states block stripping (pure, no SillyTavern imports
// so it can be unit-tested in plain Node: node --test test/strip.test.mjs).

const CLOSE = '</internal_states>';
const GFX_END = '<!-- GFX_END -->';

/** How many <internal_states blocks a text contains. */
export function countStateBlocks(text) {
    return (String(text || '').match(/<internal_states/g) || []).length;
}

/**
 * Remove every FF5 internal-states block from a message text. Handles the
 * GFX-wrapped and bare forms; leaves prose, dialogue, the time/location
 * header, and non-state GFX (phone screens, letters) untouched.
 *
 * Where a block ends (never past the next block's start):
 *   1. at its </internal_states> closing tag, or at <!-- GFX_END --> (whichever
 *      comes first);
 *   2. with NEITHER present (model forgot the closing tag): at the next blank
 *      line or the next recognised state tag (<internal_inv / <internal_states)
 *      — NOT at end of message, which used to swallow all the prose after it;
 *   3. a GFX_START … GFX_END wrapper around a removed block is removed with it,
 *      and an orphan empty GFX_START/GFX_END pair left behind is cleaned up.
 * Exported for tests.
 */
export function stripInternalStates(text) {
    const s = String(text || '');
    let out = '';
    let pos = 0;
    for (;;) {
        const start = s.indexOf('<internal_states', pos);
        if (start < 0) { out += s.slice(pos); break; }
        out += s.slice(pos, start);

        const nextStart = s.indexOf('<internal_states', start + 1);
        const limit = nextStart < 0 ? s.length : nextStart;
        const close = s.indexOf(CLOSE, start);
        const gfx = s.indexOf(GFX_END, start);
        const closeOk = close >= 0 && close < limit;
        const gfxOk = gfx >= 0 && gfx < limit;

        let end;
        if (closeOk && (!gfxOk || close < gfx)) end = close + CLOSE.length;
        else if (gfxOk) end = gfx;
        else {
            const rest = s.slice(start + 1, limit);
            const blank = rest.search(/\r?\n[ \t]*\r?\n/);
            const tag = rest.search(/<(?:internal_inv|internal_states)\b/);
            const cuts = [blank, tag].filter(x => x >= 0).map(x => start + 1 + x);
            end = cuts.length ? Math.min(...cuts) : limit;
        }

        // a GFX wrapper around the removed block goes with it
        const head = out.match(/<!-- GFX_START -->\s*$/);
        if (head) {
            const tail = s.slice(end).match(/^\s*<!-- GFX_END -->/);
            if (tail) { out = out.slice(0, out.length - head[0].length); end += tail[0].length; }
        }
        pos = end;
    }
    return out
        .replace(/<!-- GFX_START -->\s*<!-- GFX_END -->/g, '') // C8: orphan empty pair
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
