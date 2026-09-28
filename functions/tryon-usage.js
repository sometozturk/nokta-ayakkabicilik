const {createHash} = require('node:crypto');

const quotaError = () => Object.assign(new Error('Try-on usage limit reached'), {code: 'TRYON_QUOTA_EXCEEDED'});
const hashedId = value => createHash('sha256').update(String(value)).digest('hex');

const createTryOnUsage = ({firestore, FieldValue, globalDailyLimit = 25, now = () => Date.now()}) => {
  const reserveUsage = async ({uid, ip}) => {
    const timestamp = now();
    const minuteWindow = Math.floor(timestamp / 60000);
    const tenMinuteWindow = Math.floor(timestamp / 600000);
    const utcDay = new Date(timestamp).toISOString().slice(0, 10);
    const userRateRef = firestore.doc(`tryOnUsage/userRate_${hashedId(uid)}`);
    const ipRateRef = firestore.doc(`tryOnUsage/ipRate_${hashedId(ip)}`);
    const dailyRef = firestore.doc(`tryOnUsage/daily_${hashedId(uid)}`);
    const globalDailyRef = firestore.doc('tryOnUsage/globalDaily');
    const dailyLimit = typeof globalDailyLimit === 'function' ? globalDailyLimit() : globalDailyLimit;

    return firestore.runTransaction(async transaction => {
      const [userRate, ipRate, daily, globalDaily] = await Promise.all([
        transaction.get(userRateRef),
        transaction.get(ipRateRef),
        transaction.get(dailyRef),
        transaction.get(globalDailyRef)
      ]);
      const userRateData = userRate.data() || {};
      const ipRateData = ipRate.data() || {};
      const dailyData = daily.data() || {};
      const globalDailyData = globalDaily.data() || {};
      const userCount = userRateData.window === minuteWindow ? userRateData.count || 0 : 0;
      const ipCount = ipRateData.window === tenMinuteWindow ? ipRateData.count || 0 : 0;
      const dailyCount = dailyData.day === utcDay ? dailyData.count || 0 : 0;
      const globalCount = globalDailyData.day === utcDay ? globalDailyData.count || 0 : 0;

      if (userCount >= 1 || ipCount >= 30 || dailyCount >= 10 || globalCount >= dailyLimit) throw quotaError();

      transaction.set(userRateRef, {window: minuteWindow, count: userCount + 1});
      transaction.set(ipRateRef, {window: tenMinuteWindow, count: ipCount + 1});
      transaction.set(dailyRef, {day: utcDay, count: dailyCount + 1});
      transaction.set(globalDailyRef, {day: utcDay, count: globalCount + 1});
      return {day: utcDay};
    });
  };

  const refundUsage = async ({uid, day}) => {
    if (!day) return;
    const dailyRef = firestore.doc(`tryOnUsage/daily_${hashedId(uid)}`);
    const globalDailyRef = firestore.doc('tryOnUsage/globalDaily');

    await firestore.runTransaction(async transaction => {
      const [daily, globalDaily] = await Promise.all([
        transaction.get(dailyRef),
        transaction.get(globalDailyRef)
      ]);
      const dailyData = daily.data() || {};
      const globalDailyData = globalDaily.data() || {};
      if (dailyData.day === day && (dailyData.count || 0) > 0) {
        transaction.update(dailyRef, {count: FieldValue.increment(-1)});
      }
      if (globalDailyData.day === day && (globalDailyData.count || 0) > 0) {
        transaction.update(globalDailyRef, {count: FieldValue.increment(-1)});
      }
    });
  };

  return {reserveUsage, refundUsage};
};

module.exports = {createTryOnUsage};