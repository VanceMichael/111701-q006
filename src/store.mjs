import {
  compareVersions,
  hasVersion,
  isRevokedPage,
  isRevokedRecord,
  pageVersion,
  readTime,
  revokedIdsOf,
} from './state.mjs';

function versionFor(value) {
  return {
    revision: value?.revision ?? null,
    observedAt: readTime(value?.observedAt),
  };
}

function recordVersion(record) {
  return versionFor(record);
}

// A revocation is only lifted by a strictly newer announcement. When the
// revocation carries no version of its own, the version of the street it
// withdraws is the best available baseline: a replay of that same snapshot
// (or anything older) stays revoked, while a genuinely newer announcement can
// reopen the street.
function supersedes(incoming, recorded) {
  if (!hasVersion(incoming) || !hasVersion(recorded)) return false;
  return compareVersions(incoming, recorded) > 0;
}

function revokedRecord(source, id, revision, observedAt) {
  return {
    source,
    id,
    name: '',
    state: 'revoked',
    revision: revision ?? 0,
    observedAt:
      observedAt === null || observedAt === undefined
        ? null
        : new Date(observedAt).toISOString(),
  };
}

export class RecordStore {
  #records = new Map();
  // Every revoked street keeps a tombstone so stale caches cannot revive it.
  #tombstones = new Map();
  // A whole revoked announcement blocks every street of that source.
  #closedSources = new Map();

  #key(source, id) {
    return `${source}:${id}`;
  }

  #isBlocked(source, id, version) {
    const tombstone = this.#tombstones.get(this.#key(source, id));
    if (tombstone && !supersedes(version, tombstone)) return true;

    const closed = this.#closedSources.get(source);
    if (closed && !supersedes(version, closed)) return true;

    return false;
  }

  #markRevoked(source, id, reason, revokedAt = null) {
    const key = this.#key(source, id);
    const previous = this.#records.get(key);
    if (!previous) return null;
    const revoked = { ...structuredClone(previous), state: 'revoked' };
    if (reason !== undefined && reason !== null) revoked.reason = reason;
    if (revokedAt !== undefined && revokedAt !== null) {
      revoked.revokedAt = revokedAt;
    }
    this.#records.set(key, revoked);
    return revoked;
  }

  // Records a revocation for one street. The revoked snapshot stays in the
  // operational view, while the tombstone hides it from residents. A
  // revocation older than the street's current arrangement is a stale replay
  // and is ignored.
  revoke(source, id, version = null, reason = null) {
    const key = this.#key(source, String(id));
    const current = this.#records.get(key);
    let recorded = versionFor(version);
    // Without an explicit version the revocation cannot be ordered against the
    // current arrangement. Use the street's own version as the baseline so a
    // replay of that same snapshot stays revoked, while an explicit older
    // revocation (a late delivery) leaves a newer arrangement alone.
    const explicitVersion = hasVersion(recorded);
    if (!explicitVersion && current) {
      recorded = recordVersion(current);
    }
    if (
      explicitVersion &&
      current &&
      !isRevokedRecord(current) &&
      compareVersions(recordVersion(current), recorded) > 0
    ) {
      return structuredClone(current);
    }

    const existing = this.#tombstones.get(key);
    // A tombstone without a version is absolute: nothing in a cached page can
    // outrank it. A versioned tombstone is replaced only by a newer
    // revocation.
    if (!existing || (hasVersion(existing) && supersedes(recorded, existing))) {
      this.#tombstones.set(key, recorded);
    }
    const tombstone = this.#tombstones.get(key);
    const revokedAt =
      tombstone.observedAt === null
        ? null
        : new Date(tombstone.observedAt).toISOString();
    const marked = this.#markRevoked(source, String(id), reason, revokedAt);
    if (marked) return marked;
    const snapshot = revokedRecord(
      source,
      String(id),
      tombstone.revision,
      tombstone.observedAt,
    );
    if (revokedAt !== null) snapshot.revokedAt = revokedAt;
    if (reason !== undefined && reason !== null) snapshot.reason = reason;
    return snapshot;
  }

  // Records a page-level revocation. With explicit street ids only those
  // streets are withdrawn; without them the entire announcement is closed.
  revokePage(source, { version = null, ids = [], reason = null } = {}) {
    const recorded = versionFor(version);
    if (ids.length === 0) {
      // A close older than already-known streets is a stale replay.
      let newest = null;
      for (const record of this.#records.values()) {
        if (record.source !== source) continue;
        const current = recordVersion(record);
        if (!newest || compareVersions(current, newest) > 0) newest = current;
      }
      if (newest && hasVersion(recorded) && compareVersions(newest, recorded) > 0) {
        return [];
      }
    }

    const revoked = [];
    if (ids.length === 0) {
      const existing = this.#closedSources.get(source);
      if (!existing || supersedes(recorded, existing)) {
        this.#closedSources.set(source, recorded);
      }
      const closed = this.#closedSources.get(source);
      for (const record of this.#records.values()) {
        if (record.source !== source) continue;
        revoked.push(this.revoke(source, record.id, closed, reason));
      }
    } else {
      for (const id of ids) {
        revoked.push(this.revoke(source, id, recorded, reason));
      }
    }
    return revoked;
  }

  // Applies one page. Streets absent from a partial page are left untouched;
  // streets present are merged, and revocation signals always win. Accepts
  // either a raw announcement page or the normalized envelope.
  applyPage(page, records = []) {
    if (page?.source && Array.isArray(page?.items) && page.closesSource === undefined) {
      const version = pageVersion(page);
      page = {
        source: page.source,
        observedAt:
          page.observedAt ??
          page.updatedAt ??
          (version.observedAt === null
            ? null
            : new Date(version.observedAt).toISOString()),
        revision: page.revision ?? page.version ?? version.revision,
        revoked: isRevokedPage(page),
        revokedIds: revokedIdsOf(page),
        reason: page.revokedReason ?? page.reason ?? null,
      };
      page.closesSource = page.revoked && page.revokedIds.length === 0;
    }
    const version = versionFor(page);

    if (page.closesSource) {
      this.revokePage(page.source, {
        version,
        ids: [],
        reason: page.reason ?? null,
      });
    } else if (page.revokedIds?.length) {
      this.revokePage(page.source, {
        version,
        ids: page.revokedIds,
        reason: page.reason ?? null,
      });
    }

    const applied = [];
    for (const record of records) {
      applied.push(this.save(record));
    }
    return applied;
  }

  save(record) {
    const source = record.source;
    const id = record.id;
    const version = recordVersion(record);

    // Revocations may arrive as ordinary records (`state: 'revoked'`), in
    // which case they must leave the tombstone behind rather than just
    // overwriting the street.
    if (isRevokedRecord(record)) {
      const revoked = this.revoke(
        source,
        id,
        version,
        record.reason ?? null,
      );
      const revokedAt = record.revokedAt ?? record.updatedAt ?? null;
      if (revokedAt !== null && revokedAt !== undefined) {
        revoked.revokedAt = revokedAt;
      }
      return revoked;
    }

    if (this.#isBlocked(source, id, version)) {
      const stored = this.#records.get(this.#key(source, id));
      if (stored) {
        const revoked = { ...structuredClone(stored), state: 'revoked' };
        if (record.reason !== undefined) revoked.reason = record.reason;
        return revoked;
      }
      return revokedRecord(source, id, version.revision, version.observedAt);
    }

    // A strictly newer announcement may lift this street's tombstone. A
    // page-level revocation is also lifted here, but only once a newer page
    // actually carries a live street: streets it never re-announces keep
    // their own tombstones and stay hidden.
    if (hasVersion(version)) {
      this.#tombstones.delete(this.#key(source, id));
      const closed = this.#closedSources.get(source);
      if (closed && supersedes(version, closed)) {
        this.#closedSources.delete(source);
      }
    }

    const previous = this.#records.get(this.#key(source, id));
    if (previous && compareVersions(version, recordVersion(previous)) < 0) {
      return structuredClone(previous);
    }

    const stored = structuredClone(record);
    this.#records.set(this.#key(source, id), stored);
    return structuredClone(stored);
  }

  // Resident-facing query: live streets only. Revoked streets and revoked
  // announcements are omitted instead of being served from an old cache.
  list(source = null) {
    return [...this.#records.values()]
      .filter((record) => !isRevokedRecord(record))
      .filter(
        (record) => !this.#tombstones.has(this.#key(record.source, record.id)),
      )
      .filter((record) => !this.#closedSources.has(record.source))
      .filter((record) => source === null || record.source === source)
      .map((record) => structuredClone(record));
  }

  // Operational view, including revoked snapshots kept for audit.
  listAll(source = null) {
    return [...this.#records.values()]
      .filter((record) => source === null || record.source === source)
      .map((record) => structuredClone(record));
  }

  isRevoked(source, id) {
    return (
      this.#tombstones.has(this.#key(source, String(id))) ||
      this.#closedSources.has(source)
    );
  }

  isSourceClosed(source) {
    return this.#closedSources.has(source);
  }
}
