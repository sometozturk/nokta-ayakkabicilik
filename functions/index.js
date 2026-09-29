const { onRequest } = require('firebase-functions/v2/https');
const { defineInt, defineSecret } = require('firebase-functions/params');
const { getApp, initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
const { createTryOnHandler } = require('./tryon-handler');
const { createTryOnUsage } = require('./tryon-usage');
const tryOnProducts = require('./tryon-products.json');

const fashnApiKey = defineSecret('FASHN_API_KEY');
const tryOnGlobalDailyLimit = defineInt('TRYON_GLOBAL_DAILY_LIMIT', {default: 25});
if (!getApps().length) initializeApp();
const adminApp = getApp();
const auth = getAuth();
const firestore = getFirestore(adminApp, 'tryon-quota');

const tryOnProductMap = new Map(tryOnProducts.map(product => [String(product.id), product]));
const {reserveUsage, completeUsage, refundUsage} = createTryOnUsage({
  firestore,
  FieldValue,
  globalDailyLimit: () => tryOnGlobalDailyLimit.value()
});

exports.tryOn = onRequest({
  region: 'us-central1',
  timeoutSeconds: 120,
  memory: '1GiB',
  maxInstances: 3,
  secrets: [fashnApiKey]
}, createTryOnHandler({
  verifyIdToken: token => auth.verifyIdToken(token, true),
  reserveUsage,
  completeUsage,
  refundUsage,
  resolveProduct: productId => tryOnProductMap.get(String(productId)),
  getApiKey: () => fashnApiKey.value()
}));
