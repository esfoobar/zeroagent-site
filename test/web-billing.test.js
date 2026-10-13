import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { fakeCollection } from './_fake-collection.js';
import { catalog, status, checkout, portal } from '../api/_lib/web-routes/billing.js';
import { csrfTokenFor } from '../api/_lib/web-auth.js';

const now = new Date('2026-10-13T12:00:00.000Z');
const environment = { livemode: false, environment: 'sandbox', stripeAccountId: 'acct_test', productId: 'prod_test', portalConfigurationId: 'bpc_test' };
const tokenHash = createHash('sha256').update('a'.repeat(43)).digest('hex');
const baseHeaders = { cookie: '__Host-za_session=' + 'a'.repeat(43), origin: 'https://zeroagenthq.com', 'x-csrf-token': csrfTokenFor(tokenHash) };
function response() { return { headers: {}, setHeader(k,v) { this.headers[k] = v; }, end(v) { this.body = JSON.parse(v); } }; }
function fixture() {
 const users = fakeCollection(), catalogStore = fakeCollection(), purchases = fakeCollection();
 const account = { _id: 42, plan: 'free', trialEnds: '2026-10-14T00:00:00.000Z', planUntil: null, billingCustomer: null };
 users.docs.set(42, account);
 const calls = { create: 0, portal: 0, expire: 0 };
 let priceId = 'price_one', productId = 'prod_test', owner = '42', sessionStatus = 'open', subscriptionStatus = null;
 const stripe = {
  products: { retrieve: async () => ({ id: 'prod_test', active: true, livemode: false, default_price: { id: priceId, active: true, livemode: false, product: productId, unit_amount: null, currency: 'usd', recurring: { interval: 'month' } } }) },
  customers: { create: async () => ({ id: 'cus_42', livemode: false, metadata: { githubId: '42' } }), retrieve: async () => ({ id: 'cus_42', livemode: false, metadata: { githubId: owner } }) },
  subscriptions: { list: async () => ({ data: subscriptionStatus ? [{ id: 'sub_1', customer: 'cus_42', status: subscriptionStatus, livemode: false }] : [], has_more: false }) },
  checkout: { sessions: { create: async (data) => { calls.create++; return { id: 'cs_1', customer: data.customer, status: 'open', livemode: false, expires_at: Math.floor(now.getTime()/1000)+1800, url: 'https://checkout.stripe.com/session' }; }, retrieve: async () => ({ id: 'cs_1', customer: 'cus_42', status: sessionStatus, livemode: false, expires_at: Math.floor(now.getTime()/1000)+1800, url: 'https://checkout.stripe.com/session' }), expire: async () => { calls.expire++; } } },
  billingPortal: { sessions: { create: async (data) => { calls.portal++; assert.equal(data.configuration, 'bpc_test'); return { url: 'https://billing.stripe.com/session', livemode: false }; } } },
 };
 const deps = { now, environment, stripe, store: { collections: { users, catalog: catalogStore, purchases } }, getActiveSession: async () => ({ githubId: 42, authTime: now.toISOString() }) };
 async function call(handler, method = 'GET', body, headers = baseHeaders, query) { const res = response(); await handler({ method, body, headers, query }, res, deps); return res; }
 return { call, deps, account, users, purchases, calls, setPrice(v) { priceId=v; }, setProduct(v) { productId=v; }, setOwner(v) {owner=v;}, setSession(v) {sessionStatus=v;}, setSubscription(v) {subscriptionStatus=v;}, pause() { catalogStore.docs.set('catalog:sandbox', { _id: 'catalog:sandbox', salesPaused: true }); } };
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
 const f=fixture(); f.setSubscription('canceled'); assert.equal((await f.call(checkout,'POST',{priceId:'price_one'})).statusCode,200); f.setSession('complete'); assert.equal((await f.call(checkout,'POST',{priceId:'price_one'})).statusCode,202);
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
