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

/**
 * One isolated background call. Never throws into the caller's turn: errors
 * are logged and rethrown only if the caller wants them (bookkeeper/backfill/
 * digest each already wrap their calls in try/catch).
 * @param {string} systemPrompt
 * @param {string} prompt
 * @param {number} responseLength max tokens
 * @returns {Promise<string>} the reply text (trimmed)
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
            const text = String(res?.content || '').trim();
            if (text) return text;
            console.warn(`${LOG_PREFIX} cheapCall: profile returned empty content — falling back to active connection`);
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
    return String(reply || '').trim();
}
