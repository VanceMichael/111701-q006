import { readFile } from 'node:fs/promises';
import { isRevokedPage, revokedIdsOf } from './state.mjs';

export async function readSource(path = new URL('../data/source.json', import.meta.url)) {
  const text = await readFile(path, 'utf8');
  const page = JSON.parse(text);
  // A withdrawal page may carry no street list at all.
  const withdrawal =
    isRevokedPage(page) || revokedIdsOf(page).length > 0;
  if (!page.source || (!Array.isArray(page.items) && !withdrawal)) {
    throw new Error('来源页缺少 source 或 items');
  }
  return page;
}
