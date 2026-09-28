# Nokta Ayakkabıcılık

Minimal web project scaffold for the `index.html` in this workspace.

Run locally:

- Quick (no install):

```
npx live-server --open=./index.html
```

- With npm (optional):

```
npm init -y
npm install --save-dev live-server
npm start
```

## Try-on backend

Run the Cloud Functions checks from `functions/`:

```
npm test
npm run lint
```

When `products.json` changes, refresh the backend allowlist before deploying:

```
npm run sync:catalog
```

The try-on function verifies Firebase ID tokens and stores shared rate-limit and daily-quota counters in the `tryon-quota` Cloud Firestore Enterprise database (`nam5`). It is capped at 3 instances and 25 successful reservations per UTC day across all users; configure `TRYON_GLOBAL_DAILY_LIMIT` at deploy time to change the default. Per-user limits remain 1 request per minute and 10 per day; the shared-IP limit is 30 per 10 minutes for mobile carrier CGNAT.

Quota storage errors intentionally prevent the AI request. Cloud Billing budget alerts are separate billing-account resources and are not created by this Firebase deploy command. A budget alert notifies but does not enforce a spending cap.

Deploy the function and its client-denying usage rules together:

```
npx firebase-tools deploy --only firestore:rules,functions --project nokta-ayakkabicilik-ai-1453
```
