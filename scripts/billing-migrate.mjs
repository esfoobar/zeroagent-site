// ZA-901. Index migration for the billing collections. Not a Vercel
// function: run it by hand, once per environment, against that
// environment's database (MONGODB_URI and MONGODB_DB set to it).
//
//   node scripts/billing-migrate.mjs            create indexes, print inventory
//   node scripts/billing-migrate.mjs --dry-run  print inventory only
//
// Safe to run twice. It writes no user document. The inventory lists hand
// assigned paid plans by hash reference only, with no customer data.

import { getBillingStore } from '../api/_lib/billing-store.js';
import { runBillingMigration } from '../api/_lib/billing-schema.js';

const dryRun = process.argv.includes('--dry-run');
const { collections } = await getBillingStore();
const report = await runBillingMigration({ collections, dryRun });
console.log(JSON.stringify(report, null, 2));
process.exit(0);
