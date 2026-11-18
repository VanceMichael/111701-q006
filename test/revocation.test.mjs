import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePage } from '../src/adapter.mjs';
import { collect } from '../src/pipeline.mjs';
import { RecordStore } from '../src/store.mjs';

const T1 = '2026-11-17T08:00:00.000Z';
const T2 = '2026-11-17T09:00:00.000Z';
const T3 = '2026-11-17T10:00:00.000Z';

function announce(items, extra = {}) {
  return { source: 'sample-6', observedAt: T2, items, ...extra };
}

function first(...pages) {
  let index = 0;
  return async () => pages[Math.min(index++, pages.length - 1)];
}

const initial = [
  { id: '6-A', label: '甲街区', state: 'active', revision: 1 },
  { id: '6-B', label: '乙街区', state: 'active', revision: 1 },
  { id: '6-C', label: '丙街区', state: 'active', revision: 1 },
];

function ids(store, source = 'sample-6') {
  return store.list(source).map((record) => record.id).sort();
}

test('部分页面只改动列出的街区，其余街区保留原有安排', async () => {
  const store = new RecordStore();
  await collect({ source: first({ source: 'sample-6', observedAt: T1, items: initial }), store });
  await collect({
    source: first({
      source: 'sample-6',
      observedAt: T2,
      items: [{ id: '6-B', label: '乙街区（改期）', state: 'pending', revision: 2 }],
    }),
    store,
  });

  const records = store.list('sample-6');
  assert.deepEqual(ids(store), ['6-A', '6-B', '6-C']);
  const b = records.find((record) => record.id === '6-B');
  assert.equal(b.name, '乙街区（改期）');
  assert.equal(b.state, 'pending');
  assert.equal(records.find((record) => record.id === '6-A').name, '甲街区');
});

test('较旧的整页缓存不会覆盖较新的街区安排', async () => {
  const store = new RecordStore();
  await collect({ source: first({ source: 'sample-6', observedAt: T1, items: initial }), store });
  await collect({
    source: first({
      source: 'sample-6',
      observedAt: T3,
      items: [{ id: '6-A', label: '甲街区（新）', state: 'active', revision: 3 }],
    }),
    store,
  });
  // A stale cached copy of the original page arrives late.
  await collect({ source: first({ source: 'sample-6', observedAt: T1, items: initial }), store });

  const a = store.list('sample-6').find((record) => record.id === '6-A');
  assert.equal(a.name, '甲街区（新）');
  assert.equal(a.revision, 3);
});

test('街区级撤销后不再出现在居民查询结果中', async () => {
  const store = new RecordStore();
  await collect({ source: first({ source: 'sample-6', observedAt: T1, items: initial }), store });
  await collect({
    source: first({
      source: 'sample-6',
      observedAt: T2,
      items: [{ id: '6-B', state: 'revoked', revision: 2 }],
    }),
    store,
  });

  assert.deepEqual(ids(store), ['6-A', '6-C']);
  assert.equal(store.isRevoked('sample-6', '6-B'), true);
});

test('撤销后到达的旧缓存不会把撤销地点重新推荐出去', async () => {
  const store = new RecordStore();
  await collect({ source: first({ source: 'sample-6', observedAt: T1, items: initial }), store });
  await collect({
    source: first({
      source: 'sample-6',
      observedAt: T2,
      items: [{ id: '6-B', state: 'revoked', revision: 2 }],
    }),
    store,
  });
  await collect({ source: first({ source: 'sample-6', observedAt: T1, items: initial }), store });

  assert.deepEqual(ids(store), ['6-A', '6-C']);
});

test('撤销名单可以撤销页面上未列出的街区', async () => {
  const store = new RecordStore();
  await collect({ source: first({ source: 'sample-6', observedAt: T1, items: initial }), store });
  await collect({
    source: first({ source: 'sample-6', observedAt: T2, items: [], revokedIds: ['6-C'] }),
    store,
  });

  assert.deepEqual(ids(store), ['6-A', '6-B']);
});

test('整份公告撤销清空该来源的全部街区，不影响其他来源', async () => {
  const store = new RecordStore();
  await collect({ source: first({ source: 'sample-6', observedAt: T1, items: initial }), store });
  await collect({
    source: first({
      source: 'sample-7',
      observedAt: T1,
      items: [{ id: '7-A', label: '其他来源街区', state: 'active', revision: 1 }],
    }),
    store,
  });
  await collect({
    source: first({ source: 'sample-6', observedAt: T3, items: [], revoked: true }),
    store,
  });

  assert.deepEqual(store.list('sample-6'), []);
  assert.deepEqual(ids(store, 'sample-7'), ['7-A']);
});

test('嵌套在 announcement 中的撤销同样生效', async () => {
  const store = new RecordStore();
  await collect({ source: first({ source: 'sample-6', observedAt: T1, items: initial }), store });
  await collect({
    source: first({
      source: 'sample-6',
      observedAt: T3,
      items: [],
      announcement: { state: 'cancelled', cancelledAt: T3 },
    }),
    store,
  });

  assert.deepEqual(store.list('sample-6'), []);
});

test('撤销后到达的旧整页无法重新开放整份公告', async () => {
  const store = new RecordStore();
  await collect({ source: first({ source: 'sample-6', observedAt: T1, items: initial }), store });
  await collect({
    source: first({ source: 'sample-6', observedAt: T3, items: [], revoked: true }),
    store,
  });
  await collect({ source: first({ source: 'sample-6', observedAt: T1, items: initial }), store });

  assert.deepEqual(store.list('sample-6'), []);
  assert.equal(store.isSourceClosed('sample-6'), true);
});

test('严格更新的公告可以重新开放已撤销的街区', async () => {
  const store = new RecordStore();
  await collect({ source: first({ source: 'sample-6', observedAt: T1, items: initial }), store });
  await collect({
    source: first({
      source: 'sample-6',
      observedAt: T2,
      items: [{ id: '6-A', state: 'revoked', revision: 2 }],
    }),
    store,
  });
  await collect({
    source: first({
      source: 'sample-6',
      observedAt: T3,
      items: [{ id: '6-A', label: '甲街区（恢复）', state: 'active', revision: 3 }],
    }),
    store,
  });

  const a = store.list('sample-6').find((record) => record.id === '6-A');
  assert.equal(a.state, 'active');
  assert.equal(a.name, '甲街区（恢复）');
});

test('带撤销时间戳的街区按撤销处理', () => {
  const [record] = normalizePage({
    source: 'sample-6',
    observedAt: T2,
    items: [{ id: '6-B', label: '乙街区', state: 'active', revokedAt: T2, revision: 2 }],
  });
  assert.equal(record.state, 'revoked');
  assert.equal(record.revokedAt, T2);
});

test('迟到的旧撤销不会撤销已经更新的街区', async () => {
  const store = new RecordStore();
  await collect({ source: first({ source: 'sample-6', observedAt: T1, items: initial }), store });
  await collect({
    source: first({
      source: 'sample-6',
      observedAt: T3,
      items: [{ id: '6-B', label: '乙街区（改期）', state: 'active', revision: 3 }],
    }),
    store,
  });
  // A revocation observed before that update is delivered late.
  await collect({
    source: first({
      source: 'sample-6',
      observedAt: T2,
      items: [{ id: '6-B', state: 'revoked', revision: 2 }],
    }),
    store,
  });

  const b = store.list('sample-6').find((record) => record.id === '6-B');
  assert.equal(b.state, 'active');
  assert.equal(b.name, '乙街区（改期）');
});

test('记录上的撤销标志和状态字段都被识别', () => {
  const [flag] = normalizePage({
    source: 'sample-6',
    observedAt: T1,
    items: [{ id: '6-A', label: '甲街区', state: 'active', deleted: true }],
  });
  assert.equal(flag.state, 'revoked');

  const [status] = normalizePage({
    source: 'sample-6',
    observedAt: T1,
    items: [{ id: '6-A', label: '甲街区', state: 'active', status: 'withdrawn' }],
  });
  assert.equal(status.state, 'revoked');
});

test('整份公告撤销页可以没有 items', () => {
  const store = new RecordStore();
  store.save({
    source: 'sample-6',
    id: '6-A',
    name: '甲街区',
    state: 'active',
    revision: 1,
    observedAt: T1,
  });
  const records = normalizePage({
    source: 'sample-6',
    observedAt: T2,
    revoked: true,
    reason: '计划取消',
  });
  assert.deepEqual(records, []);

  const store2 = new RecordStore();
  store2.applyPage(
    { source: 'sample-6', observedAt: T2, revoked: true, closesSource: true, revokedIds: [], revision: null, reason: '计划取消' },
    records,
  );
  assert.deepEqual(store2.list('sample-6'), []);
});

test('撤销名单只撤销被点名的街区，同页其他街区照常更新', async () => {
  const store = new RecordStore();
  await collect({ source: first({ source: 'sample-6', observedAt: T1, items: initial }), store });
  await collect({
    source: first({
      source: 'sample-6',
      observedAt: T2,
      items: [
        { id: '6-A', label: '甲街区（改期）', state: 'pending', revision: 2 },
        { id: '6-C', label: '丙街区', state: 'active', revision: 2 },
      ],
      revokedIds: ['6-C'],
    }),
    store,
  });

  const records = store.list('sample-6');
  assert.deepEqual(ids(store), ['6-A', '6-B']);
  assert.equal(records.find((record) => record.id === '6-A').name, '甲街区（改期）');
  assert.equal(records.find((record) => record.id === '6-B').name, '乙街区');
});

test('居民查询默认汇总所有来源的有效地点', async () => {
  const store = new RecordStore();
  await collect({
    source: first({
      source: 'sample-6',
      observedAt: T1,
      items: [
        ...initial,
        { id: '7-A', label: '其他来源街区', state: 'active', revision: 1 },
      ],
    }),
    store,
  });
  await collect({
    source: first({
      source: 'sample-6',
      observedAt: T2,
      items: [{ id: '6-B', state: 'revoked', revision: 2 }],
    }),
    store,
  });

  assert.deepEqual(ids(store), ['6-A', '6-C', '7-A']);
});

test('整份公告撤销后居民查询不再返回该来源任何街区', async () => {
  const store = new RecordStore();
  await collect({ source: first({ source: 'sample-6', observedAt: T1, items: initial }), store });
  await collect({
    source: first({
      source: 'sample-6',
      observedAt: T2,
      items: [{ id: '6-A', label: '甲街区', state: 'active', revision: 2 }],
      announcementStatus: 'withdrawn',
    }),
    store,
  });

  assert.deepEqual(store.list('sample-6'), []);
});

test('部分页面不会被误当作整页覆盖而删除其他街区', async () => {
  const store = new RecordStore();
  await collect({ source: first({ source: 'sample-6', observedAt: T1, items: initial }), store });
  await collect({
    source: first({
      source: 'sample-6',
      observedAt: T2,
      items: [{ id: '6-B', label: '乙街区（待定）', state: 'pending', revision: 2 }],
    }),
    store,
  });
  await collect({
    source: first({
      source: 'sample-6',
      observedAt: T3,
      items: [{ id: '6-C', state: 'revoked', revision: 3 }],
    }),
    store,
  });

  assert.deepEqual(ids(store), ['6-A', '6-B']);
  assert.equal(
    store.list('sample-6').find((record) => record.id === '6-B').state,
    'pending',
  );
});

test('带撤销名单但没有 items 的页面也能撤销街区', async () => {
  const store = new RecordStore();
  await collect({ source: first({ source: 'sample-6', observedAt: T1, items: initial }), store });
  await collect({
    source: first({ source: 'sample-6', observedAt: T2, revokedIds: ['6-A', '6-C'] }),
    store,
  });

  assert.deepEqual(ids(store), ['6-B']);
});

test('运营审计视图保留撤销记录', async () => {
  const store = new RecordStore();
  await collect({ source: first({ source: 'sample-6', observedAt: T1, items: initial }), store });
  await collect({
    source: first({
      source: 'sample-6',
      observedAt: T2,
      items: [{ id: '6-B', state: 'revoked', revision: 2 }],
    }),
    store,
  });

  const b = store.listAll('sample-6').find((record) => record.id === '6-B');
  assert.equal(b.state, 'revoked');
  assert.equal(b.name, '乙街区');
});
