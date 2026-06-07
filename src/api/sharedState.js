// ===== SHARED STATE LEAF MODULE =====
// This module is a LEAF NODE in the dependency graph.
// It has ZERO imports from chat.js or browser.js.
// This breaks the circular dependency: browser.js ←→ chat.js.

let authToken = null;
let browserAvailable = true;

// Late-bound clearPagePool registration.
// chat.js registers its implementation at module load time,
// so sharedState.js never needs to import from chat.js.
let _clearPagePoolFn = null;

export function getAuthToken() {
    return authToken;
}

export function setAuthToken(token) {
    authToken = token;
}

export function isBrowserAvailable() {
    return browserAvailable;
}

export function setBrowserAvailable(val) {
    browserAvailable = val;
}

export function registerClearPagePool(fn) {
    _clearPagePoolFn = fn;
}

export async function clearPagePool() {
    if (_clearPagePoolFn) {
        await _clearPagePoolFn();
    }
}
