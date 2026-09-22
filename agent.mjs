import { writeFile } from 'node:fs/promises';

const recipient = '0x0d68028d06af13379C872FEE032568B4Be712f22';
const payoutWallet = '0x993612957B9aa30F248f3EF21bBFe988510e7503';

const policyConfig = {
  maxPerTransaction: '5.00',
  remainingDailyBudget: '20.00',
  requireHumanAbove: '2.00',
  maxRepeats: 1,
  allowedRecipients: [recipient, payoutWallet],
  blockUnknownRecipients: true
};

const transactionContext = {
  agentId: 'kushbit-sdk-meysam',
  requestId: 'req-' + Date.now(),
  chain: 'base',
  asset: 'USDC',
  recipient: recipient,
  amount: '1.00',
  context: { repeatCount: 0, agentProofDecision: 'ALLOW' }
};

function evaluateSpendGuardLocally(tx, policy) {
  const amountNum = parseFloat(tx.amount);
  const maxPerTx = parseFloat(policy.maxPerTransaction);
  const remainingBudget = parseFloat(policy.remainingDailyBudget);
  const humanThreshold = parseFloat(policy.requireHumanAbove);

  const recipientAllowed = !policy.blockUnknownRecipients || policy.allowedRecipients.map(r => r.toLowerCase()).includes(tx.recipient.toLowerCase());
  const withinTxLimit = amountNum <= maxPerTx;
  const withinDailyBudget = amountNum <= remainingBudget;
  const requiresHuman = amountNum > humanThreshold;

  const passed = recipientAllowed && withinTxLimit && withinDailyBudget;

  return {
    requestId: tx.requestId,
    agentId: tx.agentId,
    chain: tx.chain,
    asset: tx.asset,
    amount: tx.amount,
    recipient: tx.recipient,
    verdict: passed ? 'ALLOW' : 'DENY',
    requiresHumanApproval: requiresHuman,
    evaluationTimestamp: new Date().toISOString(),
    policyEvaluation: {
      recipientCheck: recipientAllowed ? 'PASSED' : 'FAILED',
      perTransactionLimitCheck: withinTxLimit ? 'PASSED' : 'FAILED',
      dailyBudgetCheck: withinDailyBudget ? 'PASSED' : 'FAILED',
      remainingBudgetAfterTx: (remainingBudget - amountNum).toFixed(2)
    },
    status: 'EVALUATED_OFFLINE_FALLBACK'
  };
}

async function main() {
  const reportFile = 'kushbitx-report.json';
  let reportData;

  try {
    const res = await fetch('https://kushbitx.com/api/spendguard/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...transactionContext, policy: policyConfig }),
      signal: AbortSignal.timeout(5000)
    });
    if (res.ok) {
      reportData = await res.json();
    } else {
      throw new Error(`Cloudflare/Remote HTTP ${res.status}`);
    }
  } catch (err) {
    console.log(`[SpendGuard Engine] Remote API unreachable (${err.message}). Using local deterministic evaluator...`);
    reportData = evaluateSpendGuardLocally(transactionContext, policyConfig);
  }

  await writeFile(reportFile, JSON.stringify(reportData, null, 2));
  console.log(JSON.stringify({ status: "SUCCESS", verdict: reportData.verdict, reportFile }, null, 2));
}

main().catch(err => {
  console.error('Fatal Error:', err);
  process.exit(1);
});
