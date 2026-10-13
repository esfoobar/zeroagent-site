import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { fakeCollection } from './_fake-collection.js';
import { catalog, status, checkout, portal } from '../api/_lib/web-routes/billing.js';
import { csrfTokenFor } from '../api/_lib/web-auth.js';
import { StripeApiError } from '../api/_lib/stripe-client.js';

const now = new Date('2026-10-13T12:00:00.000Z');
const environment = { livemode: false, environment: 'sandbox', stripeAccountId: 'acct_test', productId: 'prod_test', portalConfigurationId: 'bpc_test' };
const tokenHash = createHash('sha256').update('a'.repeat(43)).digest('hex');
const baseHeaders = { cookie: '__Host-za_session=' + 'a'.repeat(43), origin: 'https://zeroagenthq.com', 'x-csrf-token': csrfTokenFor(tokenHash) };
function response() { return { headers: {}, ended: false, setHeader(k,v) { if (this.ended) throw new Error('ERR_HTTP_HEADERS_SENT'); this.headers[k] = v; }, end(v) { this.body = JSON.parse(v); this.ended = true; } }; }
function fixture() {
 const users = fakeCollection(), catalogStore = fakeCollection(), purchases = fakeCollection();
 const account = { _id: 42, plan: 'free', trialEnds: '2026-10-14T00:00:00.000Z', planUntil: null, billingCustomer: null };
 users.docs.set(42, account);
 const calls = { create: 0, portal: 0, expire: 0, checkoutData: null, customerData: null, portalData: null };
 let priceId = 'price_one', productId = 'prod_test', owner = '42', sessionStatus = 'open', subscriptionStatus = null, sessionExpiresAt = Math.floor(now.getTime()/1000)+1800, customerLivemode = false, sessionReadError = null, sessionCustomer = 'cus_42';
 const stripe = {
  products: { retrieve: async () => ({ id: 'prod_test', active: true, livemode: false, default_price: { id: priceId, active: true, livemode: false, product: productId, unit_amount: null, currency: 'usd', recurring: { interval: 'month' } } }) },
  customers: { create: async (data) => { calls.customerData=data; return { id: 'cus_42', livemode: false, metadata: data.metadata }; }, retrieve: async () => ({ id: 'cus_42', livemode: customerLivemode, metadata: { zeroagent_github_id: owner } }) },
  subscriptions: { list: async () => ({ data: subscriptionStatus ? [{ id: 'sub_1', customer: 'cus_42', status: subscriptionStatus, livemode: false }] : [], has_more: false }) },
  checkout: { sessions: { create: async (data) => { calls.create++; calls.checkoutData=data; return { id: 'cs_1', customer: data.customer, status: 'open', livemode: false, expires_at: sessionExpiresAt, url: 'https://checkout.stripe.com/session' }; }, retrieve: async () => { if (sessionReadError) throw sessionReadError; return { id: 'cs_1', customer: sessionCustomer, status: sessionStatus, livemode: false, expires_at: sessionExpiresAt, url: 'https://checkout.stripe.com/session' }; }, expire: async () => { calls.expire++; } } },
  billingPortal: { sessions: { create: async (data) => { calls.portal++; calls.portalData=data; assert.equal(data.configuration, 'bpc_test'); return { url: 'https://billing.stripe.com/session', livemode: false }; } } },
 };
 const deps = { now, environment, stripe, store: { collections: { users, catalog: catalogStore, purchases } }, getActiveSession: async () => ({ githubId: 42, authTime: now.toISOString() }) };
 async function call(handler, method = 'GET', body, headers = baseHeaders, query) { const res = response(); await handler({ method, body, headers, query }, res, deps); return res; }
 return { call, deps, account, users, purchases, calls, setPrice(v) { priceId=v; }, setProduct(v) { productId=v; }, setOwner(v) {owner=v;}, setCustomerLivemode(v) {customerLivemode=v;}, setSession(v) {sessionStatus=v;}, setSessionReadError(v) {sessionReadError=v;}, setSessionCustomer(v) {sessionCustomer=v;}, setSessionExpiry(v) {sessionExpiresAt=v;}, setSubscription(v) {subscriptionStatus=v;}, pause() { catalogStore.docs.set('catalog:sandbox', { _id: 'catalog:sandbox', salesPaused: true }); } };
}

test('catalog resolves live offer and honestly reports paused sales', async () => {
 const f=fixture(); const offer=await f.call(catalog); assert.equal(offer.body.priceId,'price_one'); assert.equal(offer.headers['Cache-Control'],'public, max-age=60');
 f.pause(); const paused=await f.call(catalog); assert.equal(paused.body.status,'paused');
});
test('checkout re-resolves price and requires reconfirmation', async () => {
 const f=fixture(); f.setPrice('price_two'); const changed=await f.call(checkout,'POST',{priceId:'price_one'}); assert.equal(changed.statusCode,409); assert.equal(changed.body.error,'price_changed'); assert.equal(changed.body.offer.priceId,'price_two'); assert.equal(f.calls.create,0);
 const accepted=await f.call(checkout,'POST',{priceId:'price_two'}); assert.equal(accepted.statusCode,200); assert.equal(f.calls.create,1);
});
test('paused sales, wrong owner, and current subscriptions refuse checkout', async () => {
 const f=fixture(); f.pause(); assert.equal((await f.call(checkout,'POST',{priceId:'price_one'})).body.error,'sales_paused');
 const g=fixture(); g.account.billingCustomer={ customerId:'cus_42', stripeAccountId:'acct_test', livemode:false }; g.setOwner('other'); assert.equal((await g.call(checkout,'POST',{priceId:'price_one'})).statusCode,503); assert.equal(g.calls.create,0);
 const h=fixture(); h.setSubscription('active'); assert.equal((await h.call(checkout,'POST',{priceId:'price_one'})).body.error,'already_subscribed');
});
test('duplicate and concurrent checkout requests reuse one session', async () => {
 const f=fixture(); const [a,b]=await Promise.all([f.call(checkout,'POST',{priceId:'price_one'}),f.call(checkout,'POST',{priceId:'price_one'})]); assert.deepEqual([a.statusCode,b.statusCode].sort(),[200,202]); assert.equal(f.purchases.docs.size,1);
 assert.equal((await f.call(checkout,'POST',{priceId:'price_one'})).body.url,'https://checkout.stripe.com/session'); assert.equal(f.calls.create,1);
});
test('ended subscription may buy again; completed checkout waits for webhook', async () => {
 const f=fixture(); f.setSubscription('canceled'); assert.equal((await f.call(checkout,'POST',{priceId:'price_one'})).statusCode,200); f.setSession('complete'); f.setSubscription('incomplete'); assert.equal((await f.call(checkout,'POST',{priceId:'price_one'})).statusCode,202);
});
test('portal requires recent authentication and owned customer', async () => {
 const f=fixture(); f.account.billingCustomer={ customerId:'cus_42', stripeAccountId:'acct_test', livemode:false }; f.deps.getActiveSession=async()=>({ githubId:42,authTime:'2026-10-13T11:00:00.000Z' }); assert.equal((await f.call(portal,'POST')).body.error,'recent_auth_required');
 f.deps.getActiveSession=async()=>({ githubId:42,authTime:now.toISOString() }); f.setOwner('other'); assert.equal((await f.call(portal,'POST')).statusCode,503); assert.equal(f.calls.portal,0);
 f.setOwner('42'); assert.equal((await f.call(portal,'POST')).statusCode,200); assert.equal(f.calls.portal,1);
});
test('CSRF, Origin, and sign-in are enforced', async () => {
 const f=fixture(); for (const handler of [checkout,portal]) {
  assert.equal((await f.call(handler,'POST',{priceId:'price_one'},{ ...baseHeaders, 'x-csrf-token':undefined })).statusCode,403);
  assert.equal((await f.call(handler,'POST',{priceId:'price_one'},{ ...baseHeaders, origin:'https://other.example' })).statusCode,403);
  assert.equal((await f.call(handler,'POST',{priceId:'price_one'},{ ...baseHeaders, cookie:undefined })).statusCode,401);
 }
 assert.equal((await f.call(status,'GET',null,{ cookie:undefined })).statusCode,401);
});
test('status is read only and ignores return parameters', async () => {
 const f=fixture(); const before=JSON.stringify([...f.users.docs.values()]); const a=await f.call(status,'GET'); const b=await f.call(status,'GET',null,baseHeaders,{ checkout:'success',session_id:'forged' }); assert.deepEqual(a.body,b.body); assert.equal(a.body.billingStatus,'none'); assert.equal(JSON.stringify([...f.users.docs.values()]),before); assert.equal(f.purchases.docs.size,0);
});

test('checkout refuses a Price from another Product', async () => {
 const f=fixture(); f.setProduct('other_product'); const res=await f.call(checkout,'POST',{priceId:'price_one'}); assert.equal(res.statusCode,503); assert.equal(res.body.error,'offer_unavailable'); assert.equal(f.calls.create,0);
});
test('a crashed creation recovers with its original operation', async () => {
 const f=fixture();
 f.account.billingCustomer={ customerId:'cus_42', stripeAccountId:'acct_test', livemode:false };
 const key='acct_test:sandbox:42';
 f.purchases.docs.set(key,{ _id:key, operationId:'operation', priceId:'price_one', customerId:'cus_42', sessionId:null, state:'creating', createdAt:'2026-10-13T11:00:00.000Z' });
 const res=await f.call(checkout,'POST',{priceId:'price_one'});
 assert.equal(res.statusCode,200); assert.equal(f.purchases.docs.get(key).operationId,'operation'); assert.equal(f.calls.create,1);
});

test('a completed prior Checkout does not block purchase after the subscription ended', async () => {
 const f=fixture(); f.account.billingCustomer={ customerId:'cus_42', stripeAccountId:'acct_test', livemode:false };
 const key='acct_test:sandbox:42';
 f.purchases.docs.set(key,{ _id:key, operationId:'old-operation', priceId:'old-price', customerId:'cus_42', sessionId:'old-session', state:'open', createdAt:'2026-10-01T00:00:00.000Z' });
 f.setSession('complete'); f.setSubscription('canceled');
 const res=await f.call(checkout,'POST',{priceId:'price_one'});
 assert.equal(res.statusCode,200); assert.equal(f.calls.create,1); assert.equal(f.purchases.docs.get(key).priceId,'price_one'); assert.notEqual(f.purchases.docs.get(key).operationId,'old-operation');
});

test('a crashed creation reclaims a changed Price after the lease', async () => {
 const f=fixture(); f.account.billingCustomer={ customerId:'cus_42', stripeAccountId:'acct_test', livemode:false };
 const key='acct_test:sandbox:42';
 f.purchases.docs.set(key,{ _id:key, operationId:'old-operation', priceId:'old-price', customerId:'cus_42', sessionId:null, state:'creating', createdAt:'2026-10-13T11:00:00.000Z' });
 const res=await f.call(checkout,'POST',{priceId:'price_one'});
 assert.equal(res.statusCode,200); assert.equal(f.calls.create,1); assert.equal(f.purchases.docs.get(key).priceId,'price_one'); assert.notEqual(f.purchases.docs.get(key).operationId,'old-operation');
});

test('status reflects active, completed, expired and open sessions without writes', async () => {
 const f=fixture(); const key='acct_test:sandbox:42';
 f.purchases.docs.set(key,{ _id:key, operationId:'op', priceId:'price_one', customerId:'cus_42', sessionId:'cs_1', state:'open', expiresAt:'2026-10-13T12:30:00.000Z' });
 const before=JSON.stringify([...f.purchases.docs.values()]);
 assert.equal((await f.call(status)).body.checkoutState,'checkout_pending');
 f.setSession('complete'); assert.equal((await f.call(status)).body.checkoutState,'confirming_payment');
 f.account.billing={ status:'active', paidThrough:'2026-11-13T00:00:00.000Z' }; assert.equal((await f.call(status)).body.checkoutState,null);
 delete f.account.billing; f.setSession('open'); f.setSessionExpiry(Math.floor(now.getTime()/1000)-1); assert.equal((await f.call(status)).body.checkoutState,null);
 assert.equal(JSON.stringify([...f.purchases.docs.values()]),before);
});

test('Checkout and portal use account metadata and fixed return paths', async () => {
 const f=fixture(); assert.equal((await f.call(checkout,'POST',{priceId:'price_one'})).statusCode,200);
 const metadata={ zeroagent_github_id:'42', zeroagent_account_id:'acct_gh42' };
 assert.deepEqual(f.calls.customerData.metadata,metadata);
 assert.equal(f.calls.checkoutData.client_reference_id,'acct_gh42');
 assert.deepEqual(f.calls.checkoutData.metadata,metadata);
 assert.deepEqual(f.calls.checkoutData.subscription_data.metadata,metadata);
 assert.equal(f.calls.checkoutData.success_url,'https://zeroagenthq.com/account/plan?checkout=returned');
 assert.equal(f.calls.checkoutData.cancel_url,'https://zeroagenthq.com/account/plan');
 assert.equal((await f.call(portal,'POST')).statusCode,200);
 assert.equal(f.calls.portalData.return_url,'https://zeroagenthq.com/account/plan');
});

test('a customer mapping from another environment is replaced, while a matching mapping is kept', async () => {
 const f=fixture(); f.account.billingCustomer={ customerId:'old-customer', stripeAccountId:'other-account', livemode:true };
 assert.equal((await f.call(checkout,'POST',{priceId:'price_one'})).statusCode,200);
 assert.deepEqual(f.account.billingCustomer,{ customerId:'cus_42', stripeAccountId:'acct_test', livemode:false });
 const g=fixture(); g.account.billingCustomer={ customerId:'cus_42', stripeAccountId:'acct_test', livemode:false };
 assert.equal((await g.call(checkout,'POST',{priceId:'price_one'})).statusCode,200);
 assert.equal(g.calls.customerData,null);
});

test('security failures log only name and code, while the response stays generic', async () => {
 const f=fixture(); f.account.billingCustomer={ customerId:'cus_42', stripeAccountId:'acct_test', livemode:false }; f.setOwner('someone-else');
 const messages=[]; const original=console.error; console.error=(...parts)=>messages.push(parts);
 try { const res=await f.call(checkout,'POST',{priceId:'price_one'}); assert.equal(res.statusCode,503); assert.deepEqual(res.body,{ error:'billing_unavailable' }); }
 finally { console.error=original; }
 assert.deepEqual(messages,[['billing route failure','BillingIntegrityError','customer_owner_mismatch']]);
 const g=fixture(); g.account.billingCustomer={ customerId:'cus_42', stripeAccountId:'acct_test', livemode:false }; g.setCustomerLivemode(true);
 const modeMessages=[]; console.error=(...parts)=>modeMessages.push(parts);
 try { assert.equal((await g.call(portal,'POST')).statusCode,503); } finally { console.error=original; }
 assert.equal(modeMessages[0][1],'BillingModeMismatchError'); assert.equal(modeMessages[0].length,3);
});

test('status preserves projected entitlement when Stripe Session read fails, but rejects an integrity mismatch', async () => {
 const f=fixture(); const key='acct_test:sandbox:42';
 f.purchases.docs.set(key,{ _id:key, operationId:'op', priceId:'price_one', customerId:'cus_42', sessionId:'cs_1', state:'open' });
 const outage=new StripeApiError({ status:404, code:'resource_missing' }); f.setSessionReadError(outage);
 const messages=[]; const original=console.error; console.error=(...parts)=>messages.push(parts);
 try {
  const res=await f.call(status); assert.equal(res.statusCode,200); assert.equal(res.body.billingStatus,'none'); assert.equal(res.body.relayAllowed,true); assert.equal(res.body.checkoutState,null);
 } finally { console.error=original; }
 assert.deepEqual(messages,[['billing route failure','StripeApiError','resource_missing']]);
 f.setSessionReadError(null); f.setSessionCustomer('another-customer');
 const mismatchMessages=[]; console.error=(...parts)=>mismatchMessages.push(parts);
 try { const res=await f.call(status); assert.equal(res.statusCode,503); assert.deepEqual(res.body,{error:'billing_unavailable'}); } finally { console.error=original; }
 assert.deepEqual(mismatchMessages,[['billing route failure','BillingIntegrityError','checkout_customer_mismatch']]);
});

test('mapping-only billing object is not a paid subscription in status or checkout', async () => {
 const f=fixture();
 f.account.billing={ customerId:'cus_42', stripeAccountId:'acct_test', livemode:false };
 const view=await f.call(status);
 assert.equal(view.statusCode,200); assert.equal(view.body.billingStatus,'none');
 const purchase=await f.call(checkout,'POST',{priceId:'price_one'});
 assert.equal(purchase.statusCode,200); assert.equal(f.calls.customerData,null);
 assert.equal(f.calls.create,1);
});

function withPrices(f, prices) {
 f.deps.stripe.prices = { retrieve: async (id) => { if (!prices[id]) throw new StripeApiError({ status: 404, code: 'resource_missing', retriable: false }); return prices[id]; } };
}
const own = (id, amount, extra = {}) => ({ id, active: false, livemode: false, product: 'prod_test', unit_amount: amount, currency: 'usd', recurring: { interval: 'month' }, ...extra });

test('status gives a subscriber their own Price, archived or not, and never the current offer', async () => {
 const f=fixture(); f.account.billing={ status:'active', paidThrough:'2026-11-13T00:00:00.000Z', priceId:'price_old', customerId:'cus_42', stripeAccountId:'acct_test' };
 withPrices(f, { price_old: own('price_old', 500) });
 f.setPrice('price_new');
 const res=await f.call(status);
 assert.deepEqual(res.body.subscription,{ unitAmount:500, currency:'usd', interval:'month' });
 assert.equal(res.body.hasBillingHistory,true);
});

test('status states no subscriber price when it cannot be read or is not Premium', async () => {
 const f=fixture(); f.account.billing={ status:'active', paidThrough:'2026-11-13T00:00:00.000Z', priceId:'price_old' };
 const messages=[]; const original=console.error; console.error=(...p)=>messages.push(p);
 try {
  withPrices(f, {});
  assert.equal((await f.call(status)).body.subscription,null);
  withPrices(f, { price_old: own('price_old', 500, { product:'prod_other' }) });
  assert.equal((await f.call(status)).body.subscription,null);
  withPrices(f, { price_old: own('price_old', 500, { livemode:true }) });
  assert.equal((await f.call(status)).body.subscription,null);
 } finally { console.error=original; }
 assert.ok(messages.length>=1);
 assert.equal((await f.call(status)).statusCode,200);
});

test('a free or ended account carries no subscription price and no Stripe read', async () => {
 const f=fixture(); let reads=0; f.deps.stripe.prices={ retrieve: async () => { reads++; return own('x', 100); } };
 assert.equal((await f.call(status)).body.subscription,null); assert.equal((await f.call(status)).body.hasBillingHistory,false);
 f.account.billing={ status:'ended', paidThrough:'2026-09-01T00:00:00.000Z', priceId:'price_old', customerId:'cus_42' };
 const ended=await f.call(status); assert.equal(ended.body.billingStatus,'ended'); assert.equal(ended.body.subscription,null); assert.equal(reads,0);
 assert.equal(ended.body.hasBillingHistory,true);
});

test('two tabs share one open Checkout: the second request gets the same URL and no new Session', async () => {
 const f=fixture();
 const first=await f.call(checkout,'POST',{ priceId:'price_one' });
 const key='acct_test:sandbox:42';
 assert.equal((await f.call(status)).body.checkoutState,'checkout_pending');
 const second=await f.call(checkout,'POST',{ priceId:'price_one' });
 assert.equal(first.body.url,second.body.url); assert.equal(f.calls.create,1); assert.equal(f.purchases.docs.size,1); assert.ok(f.purchases.docs.get(key));
});

test('a reversed cancellation or payment-method change is a status of the same subscription and Price', async () => {
 const f=fixture(); f.account.billing={ status:'active', cancelAtPeriodEnd:true, paidThrough:'2026-11-13T00:00:00.000Z', priceId:'price_old', customerId:'cus_42', stripeAccountId:'acct_test' };
 withPrices(f, { price_old: own('price_old', 500) });
 f.setPrice('price_new');
 const scheduled=await f.call(status); assert.equal(scheduled.body.billingStatus,'cancel_scheduled'); assert.equal(scheduled.body.subscription.unitAmount,500);
 f.account.billing.cancelAtPeriodEnd=false;
 const resumed=await f.call(status); assert.equal(resumed.body.billingStatus,'active'); assert.equal(resumed.body.subscription.unitAmount,500);
});
