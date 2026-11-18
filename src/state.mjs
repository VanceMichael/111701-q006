// Revocation is expressed differently by different announcement feeds: some
// mark a record with a state, others set a flag or a revocation timestamp.
const REVOKED_STATES = new Set([
  'revoked',
  'cancelled',
  'canceled',
  'withdrawn',
  'retracted',
  'deleted',
  'removed',
  'invalidated',
]);

const REVOCATION_FLAGS = [
  'revoked',
  'cancelled',
  'canceled',
  'withdrawn',
  'retracted',
  'deleted',
  'removed',
  'invalidated',
];

const REVOCATION_TIMESTAMPS = [
  'revokedAt',
  'cancelledAt',
  'canceledAt',
  'withdrawnAt',
  'retractedAt',
  'deletedAt',
  'removedAt',
  'invalidatedAt',
];

const REVOKED_ID_KEYS = [
  'revokedIds',
  'cancelledIds',
  'canceledIds',
  'withdrawnIds',
  'retractedIds',
  'deletedIds',
  'removedIds',
  'invalidatedIds',
];

const NESTED_ANNOUNCEMENT_KEYS = ['announcement', 'notice', 'plan', 'outage'];

export function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

export function isRevokedState(state) {
  return (
    typeof state === 'string' &&
    REVOKED_STATES.has(state.trim().toLowerCase())
  );
}

export function isRevokedRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (isRevokedState(record.state) || isRevokedState(record.status)) {
    return true;
  }
  if (REVOCATION_FLAGS.some((field) => record[field] === true)) return true;
  return REVOCATION_TIMESTAMPS.some((field) => hasValue(record[field]));
}

function nestedAnnouncements(page) {
  if (!page || typeof page !== 'object') return [];
  return NESTED_ANNOUNCEMENT_KEYS.map((key) => page[key]).filter(
    (value) => value && typeof value === 'object',
  );
}

// A page can withdraw the whole announcement, in which case every street of
// that source must disappear from resident-facing results.
export function isRevokedPage(page) {
  if (!page || typeof page !== 'object') return false;
  if (
    isRevokedState(page.state) ||
    isRevokedState(page.status) ||
    isRevokedState(page.announcementState) ||
    isRevokedState(page.announcementStatus)
  ) {
    return true;
  }
  if (REVOCATION_FLAGS.some((field) => page[field] === true)) return true;
  if (REVOCATION_TIMESTAMPS.some((field) => hasValue(page[field]))) return true;
  return nestedAnnouncements(page).some((value) => isRevokedRecord(value));
}

function collectIds(value, into) {
  if (typeof value === 'string' || typeof value === 'number') {
    if (hasValue(value)) into.add(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectIds(entry, into);
    return;
  }
  if (value && typeof value === 'object' && hasValue(value.id)) {
    into.add(String(value.id));
  }
}

// Street ids a page explicitly withdraws. These survive partial pages that
// otherwise only carry the changed streets.
export function revokedIdsOf(page) {
  if (!page || typeof page !== 'object') return [];
  const ids = new Set();
  for (const source of [page, ...nestedAnnouncements(page)]) {
    for (const key of REVOKED_ID_KEYS) {
      if (source[key] !== undefined) collectIds(source[key], ids);
    }
    // `revoked` is normally a boolean flag; an array form names streets.
    if (Array.isArray(source.revoked)) collectIds(source.revoked, ids);
  }
  return [...ids];
}

export function readRevision(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

export function readTime(value) {
  if (!hasValue(value)) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function hasVersion(version) {
  return Boolean(
    version && (version.revision !== null || version.observedAt !== null),
  );
}

// Observation time wins when both sides carry one, so a stale cached page
// cannot overwrite a newer snapshot. Revision breaks ties, including for
// records that only carry a revision.
export function compareVersions(a, b) {
  const aTime = a?.observedAt ?? null;
  const bTime = b?.observedAt ?? null;
  if (aTime !== null && bTime !== null && aTime !== bTime) {
    return aTime > bTime ? 1 : -1;
  }

  const aRevision = a?.revision ?? 0;
  const bRevision = b?.revision ?? 0;
  if (aRevision !== bRevision) return aRevision > bRevision ? 1 : -1;

  if (aTime !== bTime) {
    return (aTime ?? -Infinity) > (bTime ?? -Infinity) ? 1 : -1;
  }
  return 0;
}

export function pageVersion(page) {
  if (!page || typeof page !== 'object') {
    return { revision: null, observedAt: null };
  }
  const candidates = [page, ...nestedAnnouncements(page)];
  const revision = candidates
    .map((value) => readRevision(value.revision ?? value.version))
    .filter((value) => value !== null)
    .reduce((max, value) => (max === null || value > max ? value : max), null);
  const observedAt = candidates
    .map((value) => readTime(value.observedAt ?? value.updatedAt))
    .filter((value) => value !== null)
    .reduce((max, value) => (max === null || value > max ? value : max), null);
  return { revision, observedAt };
}
