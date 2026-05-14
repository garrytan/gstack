import 'dotenv/config';
import { createDbClient } from './src/db/client.js';
import { accounts, champions, triggerEvents, referrals, connectionMaps, revenueSnapshots } from './src/db/schema.js';
import { eq } from 'drizzle-orm';
import { scoreReadiness } from './src/agents/readiness-scorer/scoring-engine.js';
import { analyzeRevenue } from './src/agents/pcp-builder/revenue-analyzer.js';
import { buildIcpWeights } from './src/agents/pcp-builder/icp-weight-builder.js';
import { scoreDealHealth } from './src/agents/success-tracker/deal-health-scorer.js';
import { analyzeCohorts } from './src/agents/success-tracker/cohort-analyzer.js';

async function main() {
  const db = createDbClient(process.env.DATABASE_URL!);

  // ─── Show Database Contents ───
  const accts = await db.select().from(accounts);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  DATABASE LOADED — YOUR REFERRAL SYSTEM');
  console.log('═══════════════════════════════════════════════════════════\n');

  for (const a of accts) {
    const champs = await db.select().from(champions).where(eq(champions.accountId, a.id));
    const triggers = await db.select().from(triggerEvents).where(eq(triggerEvents.accountId, a.id));
    const refs = await db.select().from(referrals).where(eq(referrals.accountId, a.id));
    console.log(`  ${a.companyName} ($${Number(a.currentAcv).toLocaleString()} ACV) — NPS: ${a.npsScore ?? 'n/a'}, CS Health: ${a.csHealthScore ?? 'n/a'}, Usage: ${a.usageTrend ?? 'n/a'}`);
    console.log(`    Champions: ${champs.map(c => c.name + ' (' + c.title + ', ' + c.relationshipStrength + ')').join(', ')}`);
    if (triggers.length > 0) {
      console.log(`    Triggers: ${triggers.map(t => (t.isAntiTrigger ? '⛔ ' : '✓ ') + t.eventType).join(', ')}`);
    }
    if (refs.length > 0) {
      console.log(`    Referrals: ${refs.map(r => r.targetCompany + ' [' + r.status + ']').join(', ')}`);
    }
    console.log();
  }

  // ─── Score Every Account ───
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  READINESS SCORES — PORTFOLIO REPORT');
  console.log('═══════════════════════════════════════════════════════════\n');

  const results: { account: string; score: number; tier: string; champion: string; trigger?: string; antiTriggers: string[] }[] = [];

  for (const a of accts) {
    const champs = await db.select().from(champions).where(eq(champions.accountId, a.id));
    const triggers = await db.select().from(triggerEvents).where(eq(triggerEvents.accountId, a.id));
    const refs = await db.select().from(referrals).where(eq(referrals.accountId, a.id));

    for (const champ of champs) {
      const result = scoreReadiness({
        account: a,
        champion: champ,
        triggerEvents: triggers,
        referralHistory: refs,
      });

      results.push({
        account: a.companyName,
        score: result.totalScore,
        tier: result.tier,
        champion: champ.name,
        trigger: result.triggerEvent ?? undefined,
        antiTriggers: result.antiTriggers,
      });
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  const hot = results.filter(r => r.tier === 'hot');
  const warm = results.filter(r => r.tier === 'warm');
  const notYet = results.filter(r => r.tier === 'not_yet');

  console.log(`  Total: ${results.length} champion-account pairs | Hot: ${hot.length} | Warm: ${warm.length} | Not Yet: ${notYet.length}\n`);

  if (hot.length > 0) {
    console.log('  🔥 HOT — Ready for Ask');
    for (const r of hot) {
      console.log(`    ${r.score}/100  ${r.account} — ${r.champion}${r.trigger ? ', Trigger: ' + r.trigger : ''}`);
    }
    console.log();
  }

  if (warm.length > 0) {
    console.log('  🟡 WARM — Nurture');
    for (const r of warm) {
      console.log(`    ${r.score}/100  ${r.account} — ${r.champion}`);
    }
    console.log();
  }

  if (notYet.length > 0) {
    console.log('  ⬜ NOT YET');
    for (const r of notYet) {
      const blockers = r.antiTriggers.length > 0 ? ` ⛔ ${r.antiTriggers.join(', ')}` : '';
      console.log(`    ${r.score}/100  ${r.account} — ${r.champion}${blockers}`);
    }
    console.log();
  }

  // ─── PCP Power-Law Analysis ───
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  PCP POWER-LAW ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════\n');

  const revSnapshots = await db.select().from(revenueSnapshots);
  if (revSnapshots.length > 0) {
    const revenueData = revSnapshots.map(r => ({
      accountId: r.accountId,
      companyName: 'Account',
      revenue: Number(r.revenue),
    }));

    // Aggregate by account
    const byAccount = new Map<string, { accountId: string; revenue: number }>();
    for (const r of revenueData) {
      const existing = byAccount.get(r.accountId);
      if (existing) {
        existing.revenue += r.revenue;
      } else {
        byAccount.set(r.accountId, { accountId: r.accountId, revenue: r.revenue });
      }
    }

    // Get company names
    const revenueWithNames = [];
    for (const [accountId, data] of byAccount) {
      const acct = accts.find(a => a.id === accountId);
      revenueWithNames.push({
        accountId,
        companyName: acct?.companyName ?? 'Unknown',
        revenue: data.revenue,
      });
    }
    revenueWithNames.sort((a, b) => b.revenue - a.revenue);

    const distribution = analyzeRevenue(revenueWithNames);
    const totalRev = revenueWithNames.reduce((s, r) => s + r.revenue, 0);

    console.log('  Revenue Concentration');
    console.log('  ┌──────────────────────────┬──────────┬───────────┐');
    console.log('  │ Tier                     │ Accounts │ % Revenue │');
    console.log('  ├──────────────────────────┼──────────┼───────────┤');
    console.log(`  │ Power Law (top 3%)       │ ${String(distribution.tiers.powerLaw.count).padStart(8)} │ ${distribution.tiers.powerLaw.revenuePct.toFixed(1).padStart(8)}% │`);
    console.log(`  │ High Value (next 7%)     │ ${String(distribution.tiers.highValue.count).padStart(8)} │ ${distribution.tiers.highValue.revenuePct.toFixed(1).padStart(8)}% │`);
    console.log(`  │ Core (next 40%)          │ ${String(distribution.tiers.core.count).padStart(8)} │ ${distribution.tiers.core.revenuePct.toFixed(1).padStart(8)}% │`);
    console.log(`  │ Long Tail (bottom)       │ ${String(distribution.tiers.longTail.count).padStart(8)} │ ${distribution.tiers.longTail.revenuePct.toFixed(1).padStart(8)}% │`);
    console.log('  └──────────────────────────┴──────────┴───────────┘');
    console.log(`\n  Gini Coefficient: ${distribution.giniCoefficient.toFixed(3)} (1.0 = maximum concentration)\n`);

    console.log('  Top Accounts by Revenue:');
    for (const r of revenueWithNames.slice(0, 5)) {
      const pct = ((r.revenue / totalRev) * 100).toFixed(1);
      console.log(`    $${r.revenue.toLocaleString()} — ${r.companyName} (${pct}% of total)`);
    }
  }

  // ─── Pipeline Health ───
  console.log('\n\n═══════════════════════════════════════════════════════════');
  console.log('  PIPELINE HEALTH — ACTIVE REFERRAL DEALS');
  console.log('═══════════════════════════════════════════════════════════\n');

  const allReferrals = await db.select().from(referrals);
  const activeRefs = allReferrals.filter(r =>
    !['closed_won', 'closed_lost', 'declined', 'expired'].includes(r.status!)
  );

  for (const ref of activeRefs) {
    const acct = accts.find(a => a.id === ref.accountId);
    const champ = (await db.select().from(champions).where(eq(champions.id, ref.championId)))[0];
    const daysSinceAsk = ref.askDate
      ? Math.floor((Date.now() - new Date(ref.askDate).getTime()) / 86400000)
      : 0;

    const health = scoreDealHealth({
      status: ref.status ?? 'ask_pending',
      createdAt: ref.createdAt ?? new Date(),
      lastActivityDate: ref.responseDate ?? ref.askDate ?? null,
      askDate: ref.askDate ?? null,
      introDate: ref.introDate ?? null,
      meetingDate: ref.meetingDate ?? null,
      followUpCount: ref.followUpCount ?? 0,
      response: ref.response ?? 'pending',
      opportunityAmount: ref.opportunityAmount ? Number(ref.opportunityAmount) : null,
    });

    const emoji = health.tier === 'healthy' ? '✅' : health.tier === 'at_risk' ? '⚠️' : health.tier === 'stalled' ? '🔶' : '🔴';

    console.log(`  ${emoji} ${ref.targetCompany} (via ${acct?.companyName ?? 'Unknown'})`);
    console.log(`     Health: ${health.score}/100 — ${health.tier.toUpperCase()} | Status: ${ref.status} | Days since ask: ${daysSinceAsk}`);
    console.log(`     Champion: ${champ?.name ?? 'Unknown'} | Response: ${ref.response}`);
    for (const f of health.factors.slice(0, 2)) {
      console.log(`     - ${f}`);
    }
    console.log(`     Action: ${health.recommendedAction}`);
    console.log();
  }

  // ─── Cohort Analysis ───
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  COHORT ANALYSIS — REFERRAL vs OUTBOUND');
  console.log('═══════════════════════════════════════════════════════════\n');

  const now = new Date();
  const cohortDeals = allReferrals.map(r => ({
    source: 'referral' as const,
    amount: r.closedAmount ? Number(r.closedAmount) : (r.opportunityAmount ? Number(r.opportunityAmount) : 50000),
    timeToCloseDays: r.timeToCloseDays ?? null,
    status: r.status ?? 'ask_pending',
    createdAt: r.createdAt ?? now,
  }));

  // Add synthetic outbound deals for comparison
  const outboundDeals = [
    { source: 'outbound' as const, amount: 35000, timeToCloseDays: 78, status: 'closed_won', createdAt: now },
    { source: 'outbound' as const, amount: 28000, timeToCloseDays: 92, status: 'closed_won', createdAt: now },
    { source: 'outbound' as const, amount: 42000, timeToCloseDays: 65, status: 'closed_won', createdAt: now },
    { source: 'outbound' as const, amount: 55000, timeToCloseDays: 110, status: 'closed_lost', createdAt: now },
    { source: 'outbound' as const, amount: 31000, timeToCloseDays: 85, status: 'closed_lost', createdAt: now },
    { source: 'outbound' as const, amount: 22000, timeToCloseDays: 70, status: 'closed_lost', createdAt: now },
    { source: 'outbound' as const, amount: 48000, timeToCloseDays: 95, status: 'opportunity_created', createdAt: now },
    { source: 'outbound' as const, amount: 38000, timeToCloseDays: null as number | null, status: 'meeting_booked', createdAt: now },
  ];

  const comparison = analyzeCohorts([...cohortDeals, ...outboundDeals], 'Last 12 months');

  const refCohort = comparison.cohorts.find(c => c.source === 'referral');
  const outCohort = comparison.cohorts.find(c => c.source === 'outbound');

  if (refCohort && outCohort) {
    console.log('  ┌───────────────────────┬──────────┬──────────┐');
    console.log('  │ Metric                │ Referral │ Outbound │');
    console.log('  ├───────────────────────┼──────────┼──────────┤');
    console.log(`  │ Deals                 │ ${String(refCohort.dealCount).padStart(8)} │ ${String(outCohort.dealCount).padStart(8)} │`);
    console.log(`  │ Pipeline              │ $${refCohort.totalPipeline.toLocaleString().padStart(7)} │ $${outCohort.totalPipeline.toLocaleString().padStart(7)} │`);
    console.log(`  │ Avg Deal Size         │ $${Math.round(refCohort.avgDealSize).toLocaleString().padStart(7)} │ $${Math.round(outCohort.avgDealSize).toLocaleString().padStart(7)} │`);
    console.log(`  │ Win Rate              │ ${(refCohort.winRate * 100).toFixed(1).padStart(7)}% │ ${(outCohort.winRate * 100).toFixed(1).padStart(7)}% │`);
    console.log(`  │ Avg Days to Close     │ ${String(Math.round(refCohort.avgTimeToClose)).padStart(8)} │ ${String(Math.round(outCohort.avgTimeToClose)).padStart(8)} │`);
    console.log(`  │ Closed Won            │ ${String(refCohort.closedWon).padStart(8)} │ ${String(outCohort.closedWon).padStart(8)} │`);
    console.log('  └───────────────────────┴──────────┴──────────┘');

    if (comparison.referralAdvantage) {
      const adv = comparison.referralAdvantage;
      console.log('\n  Referral Advantage:');
      console.log(`    Win Rate:  ${adv.winRateLift.toFixed(1)}x higher`);
      console.log(`    Speed:     ${adv.speedAdvantage} days faster`);
      console.log(`    Deal Size: ${adv.dealSizeLift.toFixed(1)}x larger`);
      console.log(`    CAC:       ${adv.cacReduction.toFixed(0)}% lower`);
    }
  }

  // ─── Connection Maps ───
  console.log('\n\n═══════════════════════════════════════════════════════════');
  console.log('  WARM INTRODUCTION PATHS');
  console.log('═══════════════════════════════════════════════════════════\n');

  const connections = await db.select().from(connectionMaps);
  for (const conn of connections) {
    const champ = (await db.select().from(champions).where(eq(champions.id, conn.championId)))[0];
    const acct = champ ? accts.find(a => a.id === champ.accountId) : null;
    console.log(`  ${champ?.name ?? 'Unknown'} (${acct?.companyName ?? 'Unknown'}) → ${conn.targetContact} @ ${conn.targetCompany}`);
    console.log(`    Path: ${conn.connectionPath}`);
    console.log(`    Strength: ${conn.connectionStrengthScore}/10 | Framing: ${conn.suggestedFraming?.slice(0, 100) ?? 'n/a'}`);
    console.log();
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  DONE — All agents executed against live database');
  console.log('═══════════════════════════════════════════════════════════');

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
