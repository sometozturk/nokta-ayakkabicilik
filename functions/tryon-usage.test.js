const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {createTryOnUsage} = require('./tryon-usage');

const hashedId = value => createHash('sha256').update(String(value)).digest('hex');

const createMemoryFirestore = () => {
  const documents = new Map();
  const firestore = {
    documents,
    doc: path => path,
    async runTransaction(callback) {
      const writes = [];
      const transaction = {
        async get(path) {
          return {data: () => documents.get(path)};
        },
        set(path, value) {
          writes.push({type: 'set', path, value});
        },
        update(path, value) {
          writes.push({type: 'update', path, value});
        }
      };
      const result = await callback(transaction);
      for (const write of writes) {
        if (write.type === 'set') {
          documents.set(write.path, write.value);
          continue;
        }
        const current = documents.get(write.path) || {};
        const updated = {...current};
        for (const [key, value] of Object.entries(write.value)) {
          updated[key] = value && typeof value === 'object' && '__increment' in value
            ? (current[key] || 0) + value.__increment
            : value;
        }
        documents.set(write.path, updated);
      }
      return result;
    }
  };
  return firestore;
};

const fakeFieldValue = {increment: value => ({__increment: value})};
const fixedNow = () => Date.parse('2026-09-29T12:00:00.000Z');

test('global daily limit blocks reservations and refunds restore global capacity', async () => {
  const firestore = createMemoryFirestore();
  const usage = createTryOnUsage({firestore, FieldValue: fakeFieldValue, globalDailyLimit: 2, now: fixedNow});
  const first = await usage.reserveUsage({uid: 'user-a', ip: 'ip-a'});
  await usage.reserveUsage({uid: 'user-b', ip: 'ip-b'});
  assert.equal(firestore.documents.get('tryOnUsage/globalDaily').count, 2);
  await assert.rejects(
    usage.reserveUsage({uid: 'user-c', ip: 'ip-c'}),
    error => error.code === 'TRYON_QUOTA_EXCEEDED'
  );

  await usage.refundUsage({uid: 'user-a', day: first.day});
  assert.equal(firestore.documents.get('tryOnUsage/globalDaily').count, 1);
  assert.equal(firestore.documents.get(`tryOnUsage/daily_${hashedId('user-a')}`).count, 0);
  await usage.reserveUsage({uid: 'user-c', ip: 'ip-c'});
  assert.equal(firestore.documents.get('tryOnUsage/globalDaily').count, 2);
});

test('IP rate limit allows 30 requests per ten minutes for CGNAT users', async () => {
  const firestore = createMemoryFirestore();
  const usage = createTryOnUsage({firestore, FieldValue: fakeFieldValue, globalDailyLimit: 100, now: fixedNow});
  for (let request = 0; request < 30; request++) {
    await usage.reserveUsage({uid: `user-${request}`, ip: 'shared-carrier-ip'});
  }
  await assert.rejects(
    usage.reserveUsage({uid: 'user-30', ip: 'shared-carrier-ip'}),
    error => error.code === 'TRYON_QUOTA_EXCEEDED'
  );
});

test('per-user minute limit remains one request', async () => {
  const firestore = createMemoryFirestore();
  const usage = createTryOnUsage({firestore, FieldValue: fakeFieldValue, globalDailyLimit: 100, now: fixedNow});
  await usage.reserveUsage({uid: 'same-user', ip: 'ip-a'});
  await assert.rejects(
    usage.reserveUsage({uid: 'same-user', ip: 'ip-b'}),
    error => error.code === 'TRYON_QUOTA_EXCEEDED'
  );
});

test('anonymous users receive one trial and failed reservations can be retried', async () => {
  const firestore = createMemoryFirestore();
  let timestamp = fixedNow();
  const usage = createTryOnUsage({firestore, FieldValue: fakeFieldValue, globalDailyLimit: 100, now: () => timestamp});
  const reservation = await usage.reserveUsage({uid: 'guest-a', ip: 'ip-a', isAnonymous: true});
  await assert.rejects(
    usage.reserveUsage({uid: 'guest-a', ip: 'ip-a', isAnonymous: true}),
    error => error.reason === 'ANONYMOUS_TRIAL_USED'
  );

  await usage.refundUsage({uid: 'guest-a', day: reservation.day, isAnonymous: true});
  timestamp += 60000;
  const retry = await usage.reserveUsage({uid: 'guest-a', ip: 'ip-a', isAnonymous: true});
  await usage.completeUsage({uid: 'guest-a', day: retry.day, isAnonymous: true});

  await assert.rejects(
    usage.reserveUsage({uid: 'guest-a', ip: 'ip-a', isAnonymous: true}),
    error => error.reason === 'ANONYMOUS_TRIAL_USED'
  );
});