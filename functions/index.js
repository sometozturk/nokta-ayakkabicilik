const { onRequest } = require('firebase-functions/v2/https');
const { defineInt, defineSecret, defineString } = require('firebase-functions/params');
const { getApp, initializeApp, getApps } = require('firebase-admin/app');
const { getAppCheck } = require('firebase-admin/app-check');
const { getAuth } = require('firebase-admin/auth');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
const { createTryOnHandler } = require('./tryon-handler');
const { createTryOnUsage } = require('./tryon-usage');
const tryOnProducts = require('./tryon-products.json');

const fashnApiKey = defineSecret('FASHN_API_KEY');
const hashSalt = defineSecret('HASH_SALT');
const appCheckMode = defineString('APPCHECK_MODE', {default: 'monitor'});
const registeredDailyLimit = defineInt('REGISTERED_DAILY_LIMIT', {default: 2});
const deviceDailyCap = defineInt('DEVICE_DAILY_CAP', {default: 3});
const anonIpDailyCap = defineInt('ANON_IP_DAILY_CAP', {default: 3});
const globalDailyCap = defineInt('GLOBAL_DAILY_CAP', {default: 14});
const globalTotalCap = defineInt('GLOBAL_TOTAL_CAP', {default: 100});

if (!getApps().length) initializeApp();
const adminApp = getApp();
const auth = getAuth();
const appCheck = getAppCheck(adminApp);
const firestore = getFirestore(adminApp, 'tryon-quota');

const tryOnProductMap = new Map(tryOnProducts.map(product => [String(product.id), product]));
const {reserveUsage, completeUsage, refundUsage, markGlobalTotalExhausted} = createTryOnUsage({
  firestore,
  FieldValue,
  hashSalt: () => hashSalt.value(),
  registeredDailyLimit: () => registeredDailyLimit.value(),
  deviceDailyCap: () => deviceDailyCap.value(),
  anonIpDailyCap: () => anonIpDailyCap.value(),
  globalDailyCap: () => globalDailyCap.value(),
  globalTotalCap: () => globalTotalCap.value()
});

exports.tryOn = onRequest({
  region: 'us-central1',
  timeoutSeconds: 120,
  memory: '1GiB',
  maxInstances: 3,
  secrets: [fashnApiKey, hashSalt]
}, createTryOnHandler({
  verifyIdToken: token => auth.verifyIdToken(token, true),
  verifyAppCheckToken: token => appCheck.verifyToken(token),
  getAppCheckMode: () => appCheckMode.value(),
  reserveUsage,
  completeUsage,
  refundUsage,
  markGlobalTotalExhausted,
  resolveProduct: productId => tryOnProductMap.get(String(productId)),
  getApiKey: () => fashnApiKey.value()
}));
