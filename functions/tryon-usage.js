const {createHmac} = require('node:crypto');

const quotaError = reason => Object.assign(new Error('Try-on usage limit reached'), {code: 'TRYON_QUOTA_EXCEEDED', reason});

const resolveNumber = (value, fallback) => {
  const resolved = typeof value === 'function' ? value() : value;
  const parsed = Number(resolved);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const resolveText = value => {
  const resolved = typeof value === 'function' ? value() : value;
  return resolved == null ? '' : String(resolved);
};

const hmacHash = (secret, value) => createHmac('sha256', secret).update(String(value)).digest('hex');

const createTryOnUsage = ({
  firestore,
  FieldValue,
  hashSalt,
  now = () => Date.now(),
  registeredDailyLimit = 2,
  deviceDailyCap = 3,
  anonIpDailyCap = 3,
  globalDailyCap = 14,
  globalTotalCap = 100
}) => {
  const limits = () => ({
    registeredDailyLimit: resolveNumber(registeredDailyLimit, 2),
    deviceDailyCap: resolveNumber(deviceDailyCap, 3),
    anonIpDailyCap: resolveNumber(anonIpDailyCap, 3),
    globalDailyCap: resolveNumber(globalDailyCap, 14),
    globalTotalCap: resolveNumber(globalTotalCap, 100)
  });

  const saltOrThrow = () => {
    const salt = resolveText(hashSalt);
    if (!salt) {
      throw Object.assign(new Error('HASH_SALT missing'), {code: 'failed-precondition'});
    }
    return salt;
  };

  const hashed = (salt, value) => hmacHash(salt, value);
  const expireAtFrom = timestamp => new Date(timestamp + 30 * 24 * 60 * 60 * 1000);

  const reserveUsage = async ({uid, ip, isAnonymous = false, deviceId = ''}) => {
    const salt = saltOrThrow();
    const caps = limits();
    const timestamp = now();
    const utcDay = new Date(timestamp).toISOString().slice(0, 10);
    const dayKey = utcDay.replaceAll('-', '');
    const expireAt = expireAtFrom(timestamp);
    const uidHash = hashed(salt, uid);
    const ipHash = hashed(salt, ip);
    const deviceHash = deviceId ? hashed(salt, deviceId) : '';

    const anonUidRef = isAnonymous ? firestore.doc(`tryon_usage/anon_uid_${uidHash}`) : null;
    const deviceUsedRef = isAnonymous && deviceHash ? firestore.doc(`tryon_usage/device_${deviceHash}`) : null;
    const ipRef = isAnonymous ? firestore.doc(`tryon_usage/ip_${ipHash}_${dayKey}`) : null;
    const userRef = !isAnonymous ? firestore.doc(`tryon_usage/user_${uidHash}_${dayKey}`) : null;
    const deviceDailyRef = !isAnonymous && deviceHash ? firestore.doc(`tryon_usage/device_${deviceHash}_${dayKey}`) : null;
    const globalDailyRef = firestore.doc(`tryon_usage/global_${dayKey}`);
    const globalTotalRef = firestore.doc('tryon_usage/global_total');

    return firestore.runTransaction(async transaction => {
      const [anonUid, deviceUsed, ipDoc, userDoc, deviceDaily, globalDaily, globalTotal] = await Promise.all([
        anonUidRef ? transaction.get(anonUidRef) : Promise.resolve(null),
        deviceUsedRef ? transaction.get(deviceUsedRef) : Promise.resolve(null),
        ipRef ? transaction.get(ipRef) : Promise.resolve(null),
        userRef ? transaction.get(userRef) : Promise.resolve(null),
        deviceDailyRef ? transaction.get(deviceDailyRef) : Promise.resolve(null),
        transaction.get(globalDailyRef),
        transaction.get(globalTotalRef)
      ]);

      const anonUidData = anonUid?.data() || {};
      const deviceUsedData = deviceUsed?.data() || {};
      const ipCount = ipDoc?.data()?.count || 0;
      const userCount = userDoc?.data()?.count || 0;
      const deviceCount = deviceDaily?.data()?.count || 0;
      const globalDailyCount = globalDaily.data()?.count || 0;
      const globalTotalCount = globalTotal.data()?.count || 0;

      if (globalTotalCount >= caps.globalTotalCap) throw quotaError('QUOTA_EXHAUSTED');
      if (globalDailyCount >= caps.globalDailyCap) throw quotaError('GLOBAL_CAP');

      if (isAnonymous) {
        if (anonUidData.used === true || deviceUsedData.used === true) {
          throw quotaError('ANONYMOUS_TRIAL_USED');
        }
        if (ipCount >= caps.anonIpDailyCap) throw quotaError('ANONYMOUS_TRIAL_USED');
      } else {
        if (userCount >= caps.registeredDailyLimit) throw quotaError('DAILY_LIMIT');
        if (deviceDailyRef && deviceCount >= caps.deviceDailyCap) throw quotaError('DAILY_LIMIT');
      }

      if (anonUidRef) transaction.set(anonUidRef, {used: true, expireAt});
      if (deviceUsedRef) transaction.set(deviceUsedRef, {used: true, expireAt});
      if (ipRef) transaction.set(ipRef, {count: ipCount + 1, expireAt});
      if (userRef) transaction.set(userRef, {count: userCount + 1, expireAt});
      if (deviceDailyRef) transaction.set(deviceDailyRef, {count: deviceCount + 1, expireAt});
      transaction.set(globalDailyRef, {count: globalDailyCount + 1, expireAt});
      transaction.set(globalTotalRef, {count: globalTotalCount + 1});

      return {
        day: utcDay,
        dayKey,
        isAnonymous,
        uidHash,
        ipHash,
        deviceHash
      };
    });
  };

  const completeUsage = async () => {};

  const refundUsage = async (reservation = {}) => {
    const {
      dayKey,
      isAnonymous = false,
      uidHash,
      ipHash,
      deviceHash
    } = reservation;
    if (!dayKey) return;

    const anonUidRef = isAnonymous && uidHash ? firestore.doc(`tryon_usage/anon_uid_${uidHash}`) : null;
    const deviceUsedRef = isAnonymous && deviceHash ? firestore.doc(`tryon_usage/device_${deviceHash}`) : null;
    const ipRef = isAnonymous && ipHash ? firestore.doc(`tryon_usage/ip_${ipHash}_${dayKey}`) : null;
    const userRef = !isAnonymous && uidHash ? firestore.doc(`tryon_usage/user_${uidHash}_${dayKey}`) : null;
    const deviceDailyRef = !isAnonymous && deviceHash ? firestore.doc(`tryon_usage/device_${deviceHash}_${dayKey}`) : null;
    const globalDailyRef = firestore.doc(`tryon_usage/global_${dayKey}`);
    const globalTotalRef = firestore.doc('tryon_usage/global_total');

    await firestore.runTransaction(async transaction => {
      const [anonUid, deviceUsed, ipDoc, userDoc, deviceDaily, globalDaily, globalTotal] = await Promise.all([
        anonUidRef ? transaction.get(anonUidRef) : Promise.resolve(null),
        deviceUsedRef ? transaction.get(deviceUsedRef) : Promise.resolve(null),
        ipRef ? transaction.get(ipRef) : Promise.resolve(null),
        userRef ? transaction.get(userRef) : Promise.resolve(null),
        deviceDailyRef ? transaction.get(deviceDailyRef) : Promise.resolve(null),
        transaction.get(globalDailyRef),
        transaction.get(globalTotalRef)
      ]);

      const decrement = (ref, snap) => {
        if (!ref) return;
        const count = snap?.data()?.count || 0;
        if (count > 0) transaction.update(ref, {count: FieldValue.increment(-1)});
      };

      if (anonUidRef && anonUid?.data()?.used === true) {
        transaction.set(anonUidRef, {used: false, expireAt: anonUid.data().expireAt});
      }
      if (deviceUsedRef && deviceUsed?.data()?.used === true) {
        transaction.set(deviceUsedRef, {used: false, expireAt: deviceUsed.data().expireAt});
      }
      decrement(ipRef, ipDoc);
      decrement(userRef, userDoc);
      decrement(deviceDailyRef, deviceDaily);
      decrement(globalDailyRef, globalDaily);
      decrement(globalTotalRef, globalTotal);
    });
  };

  const markGlobalTotalExhausted = async () => {
    const saltCheck = saltOrThrow();
    if (!saltCheck) return;
    const cap = limits().globalTotalCap;
    const globalTotalRef = firestore.doc('tryon_usage/global_total');
    await firestore.runTransaction(async transaction => {
      const globalTotal = await transaction.get(globalTotalRef);
      const count = globalTotal.data()?.count || 0;
      if (count < cap) transaction.set(globalTotalRef, {count: cap});
    });
  };

  return {reserveUsage, completeUsage, refundUsage, markGlobalTotalExhausted};
};

module.exports = {createTryOnUsage};
