/* MailMind Experiment: read-only lookups in Thunderbird's Global Search (Gloda) index.
 * It only runs full-text queries and returns message ids; it never changes mail or settings. */
'use strict';

var { ExtensionCommon } = ChromeUtils.importESModule('resource://gre/modules/ExtensionCommon.sys.mjs');
var { setTimeout, clearTimeout } = ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs');

var glodaSearch = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    const extension = context.extension;
    const loadGloda = () => {
      const { Gloda } = ChromeUtils.importESModule('resource:///modules/gloda/GlodaPublic.sys.mjs');
      const { GlodaConstants } = ChromeUtils.importESModule('resource:///modules/gloda/GlodaConstants.sys.mjs');
      return { Gloda, GlodaConstants };
    };
    const enabled = () => Services.prefs.getBoolPref('mailnews.database.global.indexer.enabled', false);

    /** One full-text query; resolves to gloda message items (or rejects on timeout). */
    const query = (Gloda, NOUN, term, limit, timeoutMs) =>
      new Promise((resolve, reject) => {
        const q = Gloda.newQuery(NOUN);
        // Quoted like Global Search does, so multi-word terms match as a phrase.
        q.fulltextMatches('"' + term.replace(/"/g, ' ').trim() + '"');
        q.orderBy('-date');
        q.limit(limit);
        const timer = setTimeout(() => reject(new Error('Global Search index timed out')), timeoutMs);
        const listener = {
          onItemsAdded() {},
          onItemsModified() {},
          onItemsRemoved() {},
          onQueryCompleted(collection) {
            clearTimeout(timer);
            resolve(collection.items);
          },
        };
        // Keep a reference until done; gloda holds collections weakly.
        listener.collection = q.getCollection(listener);
      });

    /** Gloda messages for these headers (only the ones it has indexed). */
    const indexedFor = (Gloda, hdrs, timeoutMs) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Global Search index timed out')), timeoutMs);
        const listener = {
          onItemsAdded() {},
          onItemsModified() {},
          onItemsRemoved() {},
          onQueryCompleted(collection) {
            clearTimeout(timer);
            resolve(collection.items);
          },
        };
        listener.collection = Gloda.getMessageCollectionForHeaders(hdrs, listener);
      });

    return {
      glodaSearch: {
        /**
         * Whether each message has attachments, without opening it: Thunderbird's attachment flag on
         * the header, or the attachment types Global Search recorded when it indexed the message.
         * Resolves to [{id, has}]; ids it can't answer for (not indexed, no flag) are left out.
         */
        async attachmentInfo(ids, options = {}) {
          const timeoutMs = options.timeoutMs ?? 30000;
          const out = [];
          const unknown = [];
          for (const id of ids) {
            const hdr = extension.messageManager.get(id);
            if (!hdr) continue;
            if (hdr.flags & Ci.nsMsgMessageFlags.Attachment) out.push({ id, has: true });
            else unknown.push({ id, hdr, key: hdr.folder.URI + '#' + hdr.messageKey });
          }
          if (!unknown.length || !enabled()) return out;
          const { Gloda } = loadGloda();
          for (let i = 0; i < unknown.length; i += 200) {
            const batch = unknown.slice(i, i + 200);
            const items = await indexedFor(Gloda, batch.map((u) => u.hdr), timeoutMs);
            const types = new Map();
            for (const item of items) {
              let t = [];
              try {
                t = item.attachmentTypes || [];
              } catch {}
              types.set(item.folderURI + '#' + item.messageKey, t.length > 0);
            }
            for (const u of batch) {
              if (!types.has(u.key)) continue;
              const has = types.get(u.key);
              // Gloda only sees attachments in message bodies it could read, so trust a "no" only for
              // mail stored on this computer (local folders, or IMAP messages kept for offline use).
              const local = u.hdr.folder.server?.type !== 'imap' || !!(u.hdr.flags & Ci.nsMsgMessageFlags.Offline);
              if (has || local) out.push({ id: u.id, has });
            }
          }
          return out;
        },
        async isAvailable() {
          if (!enabled()) return false;
          try {
            loadGloda();
            return true;
          } catch {
            return false;
          }
        },
        async search(terms, options = {}) {
          if (!enabled()) throw new Error('Global Search indexing is switched off');
          const { Gloda, GlodaConstants } = loadGloda();
          const from = options.fromDate ?? null;
          const to = options.toDate ?? null;
          const limit = options.limit ?? 5000;
          const timeoutMs = options.timeoutMs ?? 30000;
          const out = [];
          for (const term of terms) {
            if (String(term).trim().length < 2) continue;
            const items = await query(Gloda, GlodaConstants.NOUN_MESSAGE, String(term), limit, timeoutMs);
            const ids = [];
            for (const item of items) {
              const t = item.date ? item.date.getTime() : null;
              if (t !== null && ((from !== null && t < from) || (to !== null && t > to))) continue;
              let hdr = null;
              try {
                hdr = item.folderMessage; // null if the message was moved/deleted since indexing
              } catch {}
              if (!hdr) continue;
              const m = extension.messageManager.convert(hdr);
              if (m && typeof m.id === 'number') ids.push(m.id);
            }
            out.push({ term: String(term), ids, complete: items.length < limit });
          }
          return out;
        },
      },
    };
  }
};
