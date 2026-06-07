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

/**
 * Retrieve the current authentication token.
 * @returns {string|null} The current authentication token, or `null` if none is set.
 */
export function getAuthToken() {
    return authToken;
}

/**
 * Update the module's current authentication token.
 * @param {string|null} token - The new auth token, or `null` to clear it.
 */
export function setAuthToken(token) {
    authToken = token;
}

/**
 * Indicates whether a browser instance is currently available for use.
 * @returns {boolean} `true` if the browser is available, `false` otherwise.
 */
export function isBrowserAvailable() {
    return browserAvailable;
}

/**
 * Set whether the browser is considered available.
 * @param {boolean} val - `true` if the browser is available, `false` otherwise.
 */
export function setBrowserAvailable(val) {
    browserAvailable = val;
}

/**
 * Register a callback to clear the page pool; the registered function will be invoked (and awaited, if it returns a promise) by clearPagePool().
 * @param {Function|null} fn - The function to call when clearing the page pool. Pass `null` to unregister any previously registered callback.
 */
export function registerClearPagePool(fn) {
    _clearPagePoolFn = fn;
}

/**
 * Invoke the registered clear-page-pool function if one has been registered.
 *
 * If no clear function was registered via registerClearPagePool, this function performs no action.
 */
export async function clearPagePool() {
    if (_clearPagePoolFn) {
        await _clearPagePoolFn();
    }
}
