// Character Cells — shared extension settings.
// One settings object under extension_settings.character_cells, so every module
// (bookkeeper, tiers, …) persists to the SAME object instead of clobbering
// each other's keys. index.js calls initSettings() once at startup.

import { saveSettingsDebounced } from '../../../../script.js';

const SETTINGS_KEY = 'character_cells';

const settings = {
    bookkeeperEnabled: false,
    bookkeeperDelayMs: 1500,
    bookkeeperProfileId: '', // Connection Manager profile for ALL cheap calls ('' = active connection)
    bookkeeperAutoCells: true, // bookkeeper may auto-create cells/factions/quests (char_add/faction_add/quest_add)
    autoTierEnabled: true,
    mainCharacterMode: false, // perspective rebuild: block built from ONE character's knowledge
    autoChekhov: true,        // tick engine fires Chekhov bullets by d20 threshold
    worldSimEnabled: true,    // tick engine rolls the World Sim table each turn
};

let _extension_settings = null;

/** Called by index.js at init with the extension_settings object. */
export function initSettings(extension_settings) {
    _extension_settings = extension_settings;
    const stored = extension_settings[SETTINGS_KEY];
    if (stored && typeof stored === 'object') {
        if (typeof stored.bookkeeperEnabled === 'boolean') settings.bookkeeperEnabled = stored.bookkeeperEnabled;
        if (typeof stored.bookkeeperDelayMs === 'number') settings.bookkeeperDelayMs = stored.bookkeeperDelayMs;
        if (typeof stored.bookkeeperProfileId === 'string') settings.bookkeeperProfileId = stored.bookkeeperProfileId;
        if (typeof stored.bookkeeperAutoCells === 'boolean') settings.bookkeeperAutoCells = stored.bookkeeperAutoCells;
        if (typeof stored.autoTierEnabled === 'boolean') settings.autoTierEnabled = stored.autoTierEnabled;
        if (typeof stored.mainCharacterMode === 'boolean') settings.mainCharacterMode = stored.mainCharacterMode;
        if (typeof stored.autoChekhov === 'boolean') settings.autoChekhov = stored.autoChekhov;
        if (typeof stored.worldSimEnabled === 'boolean') settings.worldSimEnabled = stored.worldSimEnabled;
    }
}

export function getSettings() {
    return settings;
}

export function persistSettings() {
    if (_extension_settings) {
        _extension_settings[SETTINGS_KEY] = settings;
        saveSettingsDebounced();
    }
}
