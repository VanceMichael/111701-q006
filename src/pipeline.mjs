import { normalizePage, normalizePageEnvelope } from './adapter.mjs';
import { readSource } from './source.mjs';
import { RecordStore } from './store.mjs';

// Collects one page. Pages may be partial: only the streets present are
// applied, untouched streets keep their previous arrangement. Revocation is
// handled by the store, so a revoked street or announcement disappears from
// resident-facing results.
export async function collect({
  source = readSource,
  store = new RecordStore(),
} = {}) {
  const page = await source();
  const envelope = normalizePageEnvelope(page);
  const records = normalizePage(page);
  const applied = store.applyPage(envelope, records);
  return {
    source: page.source,
    observedAt: page.observedAt ?? null,
    records: applied,
    store,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await collect();
  console.log(
    JSON.stringify(
      { source: result.source, count: result.records.length },
      null,
      2,
    ),
  );
}
