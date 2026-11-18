import {
  isRevokedPage,
  isRevokedRecord,
  pageVersion,
  readRevision,
  revokedIdsOf,
} from './state.mjs';

// Normalizes one announcement page into records. A page may be partial: the
// items it carries are the streets the operator touched, while absent streets
// keep whatever the store already knows.
export function normalizePage(page) {
  if (!page || typeof page !== 'object') {
    throw new Error('来源页缺少 source 或 items');
  }
  if (!page.source) {
    throw new Error('来源页缺少 source 或 items');
  }
  if (!Array.isArray(page.items)) {
    // A withdrawal page may omit its street list: either it closes the whole
    // announcement or it names the revoked ids explicitly.
    if (isRevokedPage(page) || revokedIdsOf(page).length > 0) return [];
    throw new Error('来源页缺少 source 或 items');
  }

  const pageRevoked = isRevokedPage(page);
  const revokedIds = revokedIdsOf(page);
  const version = pageVersion(page);
  return page.items.map((item) =>
    normalizeItem(item, page, { pageRevoked, revokedIds, version }),
  );
}

function normalizeItem(item, page, { pageRevoked, revokedIds, version }) {
  if (!item || typeof item !== 'object' || !item.id) {
    throw new Error('来源记录缺少 id、label 或 state');
  }

  const named = revokedIds.includes(String(item.id));
  // An explicit id list revokes exactly those streets; other streets on the
  // same page keep their normal arrangement.
  const pageRevokesItem = named || (pageRevoked && revokedIds.length === 0);
  const revoked = pageRevokesItem || isRevokedRecord(item);

  if (!revoked && (!item.label || !item.state)) {
    throw new Error('来源记录缺少 id、label 或 state');
  }

  const record = {
    source: page.source,
    id: String(item.id),
    name:
      item.label === undefined || item.label === null
        ? ''
        : String(item.label).trim(),
    state: revoked ? 'revoked' : String(item.state),
    revision:
      readRevision(
        item.revision ?? item.version ?? version.revision ?? undefined,
      ) ?? 0,
    observedAt:
      item.observedAt ??
      item.updatedAt ??
      page.observedAt ??
      (version.observedAt === null
        ? null
        : new Date(version.observedAt).toISOString()),
  };

  if (revoked) {
    record.revokedAt =
      item.revokedAt ??
      item.cancelledAt ??
      item.canceledAt ??
      item.deletedAt ??
      item.removedAt ??
      item.updatedAt ??
      record.observedAt ??
      null;
    const reason = item.reason ?? sourceReason(page);
    if (reason !== undefined) record.reason = reason;
  }

  return record;
}

function sourceReason(page) {
  return page.revokedReason ?? page.reason;
}

// Page-level metadata the pipeline needs beyond the records.
export function normalizePageEnvelope(page) {
  const revokedIds = revokedIdsOf(page);
  const revoked = isRevokedPage(page);
  const version = pageVersion(page);
  return {
    source: page.source,
    // Nested announcement objects may carry the only usable timestamp.
    observedAt:
      page.observedAt ??
      page.updatedAt ??
      (version.observedAt === null
        ? null
        : new Date(version.observedAt).toISOString()),
    revision: readRevision(page.revision ?? page.version) ?? version.revision,
    revoked,
    revokedIds,
    // A revoked page closes the whole source unless it names specific streets.
    closesSource: revoked && revokedIds.length === 0,
    reason: sourceReason(page) ?? null,
  };
}
