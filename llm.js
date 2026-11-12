// Character Cells — shared cheap-call doorway.
// All background model calls (bookkeeper, backfill, digests) go through here.
// When a Connection Manager profile is selected (settings.bookkeeperProfileId),
// the call rides that profile — its API, key, model and preset — WITHOUT
// switching the narrator's live connection (ConnectionManagerRequestService
// sends a one-off request). When no profile is selected (''), the call falls
// back to generateRaw() on the active connection, exactly as before.

import { generateRaw } from '../../../../script.js';
import { ConnectionManagerRequestService } from '../../shared.js';
import { getSettings } from './settings.js';
import { LOG_PREFIX } from './config.js';

// A1: the profile gets this long. If it hasn't answered by then (slow reasoning
// model, long max_tokens), the call moves to the active connection instead of
// failing — the state update must never be lost to a slow profile.
const PROFILE_DEADLINE_MS = 90000;

const DEADLINE_HIT = Symbol('deadline');

/** Is a Connection Manager profile selected for the cheap calls? */
export function hasCheapProfile() {
    return !!getSettings().bookkeeperProfileId;
}

/** Is the Connection Manager extension itself available? */
function cmAvailable() {
    try {
        const ctx = SillyTavern.getContext();
        return !ctx.extensionSettings.disabledExtensions.includes('connection-manager');
    } catch {
        return false;
    }
}

// Strip reasoning-model thinking blocks. Thinking models (GLM, DeepSeek-R1,
// …) spend REASONING tokens out of the SAME max_tokens budget as the answer —
// a 400-token cap can be fully consumed by reasoning, leaving content empty or
// truncated mid-command. Ported from lorebook-forge's llmData.js: prefers ST's
// own utility (public/scripts/reasoning.js), falls back to a regex.
async function stripReasoning(text) {
    try {
        const mod = await import('../../../../reasoning.js');
        if (typeof mod.removeReasoningFromString === 'function') {
            return mod.removeReasoningFromString(text);
        }
    } catch { /* older builds — regex fallback below */ }
    return String(text).replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
}

/**
 * One isolated background call. Never throws into the caller's turn: errors
 * are logged and rethrown only if the caller wants them (bookkeeper/backfill/
 * digest each already wrap their calls in try/catch).
 * Flow: profile attempt (if selected) → if it errors, comes back empty, or runs
 * past the deadline, the call goes to the active connection via generateRaw().
 * A late profile reply after the deadline is discarded.
 * IMPORTANT: responseLength maps onto max_tokens, and thinking models spend
 * reasoning from that SAME budget — callers must budget for reasoning + answer
 * (referee 1024, bookkeeper 2048; lorebook-forge uses 32k+ for the same reason).
 * @param {string} systemPrompt
 * @param {string} prompt
 * @param {number} responseLength max tokens
 * @param {{timeoutMs?:number}} [opts] if given, a HARD deadline: on expiry the call throws
 *   (the referee passes 15 s and treats that as "no task"). Omitted → the profile gets
 *   90 s, then the fallback runs with no deadline. 0 = no deadline at all.
 * @returns {Promise<string>} the reply text (reasoning stripped, trimmed)
 */
export async function cheapCall(systemPrompt, prompt, responseLength, opts = {}) {
    const hard = opts?.timeoutMs !== undefined;
    const ms = hard ? Number(opts.timeoutMs) : PROFILE_DEADLINE_MS;

    const profileAttempt = profileCall(systemPrompt, prompt, responseLength); // never rejects
    let timer;
    const outcome = ms > 0
        ? await Promise.race([
            profileAttempt,
            new Promise((resolve) => { timer = setTimeout(() => resolve(DEADLINE_HIT), ms); }),
        ])
        : await profileAttempt;
    clearTimeout(timer);

    if (outcome === DEADLINE_HIT) {
        if (hard) throw new Error(`cheapCall timed out after ${ms} ms`);
        console.warn(`${LOG_PREFIX} cheapCall: profile exceeded ${ms} ms — falling back to active connection`);
    } else if (outcome) {
        return outcome;
    }

    const reply = await generateRaw({
        prompt,
        systemPrompt,
        responseLength,
        trimNames: false,
    });
    return await stripReasoning(String(reply || '').trim());
}

/** The profile attempt. Resolves to the reply text, or null on no profile / failure / empty reply. */
async function profileCall(systemPrompt, prompt, responseLength) {
    const profileId = getSettings().bookkeeperProfileId;
    if (!profileId || !cmAvailable()) return null;
    try {
        const res = await ConnectionManagerRequestService.sendRequest(
            profileId,
            [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: prompt },
            ],
            // B5: thinking models eat reasoning tokens from the same cap. Ask for LOW
            // effort (ST's server maps reasoning_effort onto OpenRouter / Google /
            // Claude / OpenAI-style sources; unsupported ones ignore it) and use the
            // user-configurable profileMaxTokens (default 32k) for profile calls, so
            // reasoning that can't be turned off never starves the answer.
            Number(getSettings().profileMaxTokens) || 32000,
            { includePreset: true, stream: false },
            { reasoning_effort: 'low', include_reasoning: false },
        );
        const text = await stripReasoning(String(res?.content || ''));
        if (text) return text;
        const reasoningLen = String(res?.reasoning || '').length;
        console.warn(`${LOG_PREFIX} cheapCall: profile returned empty content (reasoning: ${reasoningLen} chars — max_tokens ${responseLength} likely eaten by reasoning) — falling back to active connection`);
        return null;
    } catch (err) {
        console.warn(`${LOG_PREFIX} cheapCall: profile call failed — falling back to active connection:`, err);
        return null;
    }
}
