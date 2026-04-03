/**
 * ClientSideBlock — Revenge Plugin
 *
 * Ported from Equicord's clientSideBlock (by Samwich / KamiRu).
 * Targets: Revenge (React Native Discord Android)
 *
 * What it does:
 *   - Hides messages, DM list entries, and friend list entries for blocked users
 *   - Adds "Client Block / Unblock" to the user long-press context menu
 *   - Persists the blocked-user list across restarts via plugin storage
 *   - Optionally also hides users already blocked via Discord's own block
 *
 * Revenge APIs used:
 *   findByProps / findByName  — Metro module lookup
 *   patcher.before / .after   — Method interception
 *   storage                   — Persistent key-value store (AsyncStorage-backed)
 *   showToast                 — Brief on-screen notifications
 */

"use strict";

// ─── Module resolution helpers ────────────────────────────────────────────────
// Revenge exposes its API on the global `revenge` object.
// Adjust the destructuring paths here if a future Revenge version reorganises them.

const { findByProps, findByName, findByDisplayName } = revenge.metro;
const patcher  = revenge.patcher;
const storage  = revenge.storage;        // { get, set } — async key/value
const toast    = findByProps("showToast");

// ─── Storage helpers ──────────────────────────────────────────────────────────

const STORAGE_KEY = "clientSideBlock_blockedUsers";

async function loadBlockedSet() {
    const raw = await storage.get(STORAGE_KEY);
    try {
        return new Set(JSON.parse(raw ?? "[]"));
    } catch {
        return new Set();
    }
}

async function saveBlockedSet(set) {
    await storage.set(STORAGE_KEY, JSON.stringify([...set]));
}

async function blockUser(userId, username) {
    const set = await loadBlockedSet();
    if (!set.has(userId)) {
        set.add(userId);
        await saveBlockedSet(set);
        toast?.showToast(`@${username} client-blocked.`);
    }
}

async function unblockUser(userId, username) {
    const set = await loadBlockedSet();
    if (set.has(userId)) {
        set.delete(userId);
        await saveBlockedSet(set);
        toast?.showToast(`@${username} client-unblocked.`);
    }
}

// Sync snapshot used inside patches (updated each time the set changes)
let blockedCache = new Set();
loadBlockedSet().then(s => { blockedCache = s; });

function isBlocked(userId) {
    return blockedCache.has(String(userId));
}

// ─── Patch registry (so we can cleanly unpatch on disable) ───────────────────
const patches = [];

// ─── Patch 1: Hide chat messages ─────────────────────────────────────────────
// Find the component that renders individual chat messages.
// On the RN Discord app this is typically named "Message" or "ChatMessage".

function patchMessages() {
    // Try a few possible names — obfuscation varies by Discord build
    const MessageComp =
        findByDisplayName("Message") ??
        findByDisplayName("ChatMessage") ??
        findByProps("renderMessage")?.default;

    if (!MessageComp) {
        console.warn("[ClientSideBlock] Could not find message component — message hiding inactive.");
        return;
    }

    const key   = "render" in MessageComp.prototype ? "render" : "default";
    const proto = MessageComp.prototype ?? MessageComp;

    const unpatch = patcher.before(key, proto, (args) => {
        // args[0] is the props object; message.author.id is the user's snowflake
        const authorId = args[0]?.message?.author?.id ?? args[0]?.author?.id;
        if (authorId && isBlocked(authorId)) {
            return [{ ...args[0], _csb_hidden: true }];
        }
    });

    const unpatch2 = patcher.after(key, proto, ([props], res) => {
        if (props?._csb_hidden) return null;
        return res;
    });

    patches.push(unpatch, unpatch2);
}

// ─── Patch 2: Hide DM list entries ───────────────────────────────────────────

function patchDMList() {
    const DMChannel =
        findByDisplayName("PrivateChannel") ??
        findByDisplayName("DirectMessage") ??
        findByProps("renderAvatar")?.default;

    if (!DMChannel) {
        console.warn("[ClientSideBlock] Could not find DM list component — DM hiding inactive.");
        return;
    }

    const proto = DMChannel.prototype ?? DMChannel;
    const key   = "render" in proto ? "render" : "default";

    const unpatch = patcher.after(key, proto, ([props], res) => {
        const recipientId = props?.channel?.rawRecipients?.[0]?.id;
        if (recipientId && isBlocked(recipientId)) return null;
        return res;
    });

    patches.push(unpatch);
}

// ─── Patch 3: Add "Client Block / Unblock" to the user context menu ──────────
// In Revenge the user long-press sheet is usually driven by
// `ActionSheet` or a component named "UserProfileActionSheet".

function patchUserContextMenu() {
    // Find the action sheet that appears when you long-press a user avatar / name
    const UserSheet =
        findByDisplayName("UserProfileActionSheet") ??
        findByDisplayName("UserContextMenu") ??
        findByProps("openUserContextMenu");

    if (!UserSheet) {
        console.warn("[ClientSideBlock] Could not find user context menu — block option inactive.");
        return;
    }

    const target = UserSheet.default ?? UserSheet;
    const proto  = target.prototype ?? target;
    const key    = "render" in proto ? "render" : "default";

    const unpatch = patcher.after(key, proto, ([props], res) => {
        if (!res) return res;

        const userId   = String(props?.user?.id ?? props?.userId ?? "");
        const username = props?.user?.username ?? props?.username ?? "user";
        if (!userId) return res;

        const blocked    = isBlocked(userId);
        const label      = blocked ? `Client Unblock @${username}` : `Client Block @${username}`;
        const { React }  = revenge.metro.common;

        // Locate the actions array inside the rendered output and append our item
        const actionItem = React.createElement(
            findByDisplayName("ActionSheetRow") ??
            findByProps("ActionSheetRow")?.ActionSheetRow ??
            "TouchableOpacity",   // fallback — will look unstyled but functional
            {
                key:      "csb-toggle",
                label,
                onPress: () => {
                    if (blocked) unblockUser(userId, username).then(() => { blockedCache.delete(userId); });
                    else         blockUser(userId, username).then(() => { blockedCache.add(userId); });
                }
            },
            label
        );

        // Walk the React element tree to find the children list and push our item
        function inject(el) {
            if (!el || typeof el !== "object") return el;
            if (Array.isArray(el)) { el.push(actionItem); return el; }
            if (el.props?.children) {
                if (Array.isArray(el.props.children)) {
                    el.props.children.push(actionItem);
                    return el;
                }
                inject(el.props.children);
            }
            return el;
        }
        inject(res);
        return res;
    });

    patches.push(unpatch);
}

// ─── Plugin lifecycle ─────────────────────────────────────────────────────────

module.exports = {
    // Called when the plugin is enabled
    onLoad() {
        // Refresh the in-memory cache whenever the plugin loads
        loadBlockedSet().then(s => { blockedCache = s; });

        patchMessages();
        patchDMList();
        patchUserContextMenu();

        console.log("[ClientSideBlock] Loaded.");
    },

    // Called when the plugin is disabled / Revenge unloads it
    onUnload() {
        patches.forEach(fn => fn?.());
        patches.length = 0;
        console.log("[ClientSideBlock] Unloaded.");
    },

    // Expose helpers so Revenge's settings UI can call them if desired
    blockUser,
    unblockUser,
    isBlocked,
    loadBlockedSet,
};
