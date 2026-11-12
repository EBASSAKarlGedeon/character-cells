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
 * IMPORTANT: responseLength maps onto max_tokens, and thinking models spend
 * reasoning from that SAME budget — callers must budget for reasoning + answer
 * (referee 1024, bookkeeper 2048; lorebook-forge uses 32k+ for the same reason).
 * @param {string} systemPrompt
 * @param {string} prompt
 * @param {number} responseLength max tokens
 * @returns {Promise<string>} the reply text (reasoning stripped, trimmed)
 */
export async function cheapCall(systemPrompt, prompt, responseLength) {
    const profileId = getSettings().bookkeeperProfileId;
    if (profileId && cmAvailable()) {
        try {
            const res = await ConnectionManagerRequestService.sendRequest(
                profileId,
                [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: prompt },
                ],
                responseLength,
                { includePreset: true, stream: false },
            );
            const text = await stripReasoning(String(res?.content || ''));
            if (text) return text;
            const reasoningLen = String(res?.reasoning || '').length;
            console.warn(`${LOG_PREFIX} cheapCall: profile returned empty content (reasoning: ${reasoningLen} chars — max_tokens ${responseLength} likely eaten by reasoning) — falling back to active connection`);
        } catch (err) {
            console.warn(`${LOG_PREFIX} cheapCall: profile call failed — falling back to active connection:`, err);
        }
    }
    // Fallback / no profile: the preset-free call on the active connection.
    const reply = await generateRaw({
        prompt,
        systemPrompt,
        responseLength,
        trimNames: false,
    });
    return await stripReasoning(String(reply || '').trim());
}
