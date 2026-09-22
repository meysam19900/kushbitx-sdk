// Node 22+. Free token and SpendGuard previews need no package installation.
// A paid run requires npm install viem, --paid and AGENT_PRIVATE_KEY.
// Examples: node agent.mjs --spendguard
// node agent.mjs --paid --service=token-preview
// TX_TO=0x... node agent.mjs --paid --service=preflight
// TX_HASH=0x... EXPECTED_TO=0x... EXPECTED_AMOUNT=1.00 node agent.mjs --paid --service=payment
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const origin = 'https://kushbitx.com';
const asset = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const recipient = '0x0d68028d06af13379C872FEE032568B4Be712f22';
const serviceName = (process.argv.find(value => value.startsWith('--service='))?.split('=')[1] || 'token-preview').toLowerCase();
const aliases = { token: 'token-preview', 'token-preview': 'token-preview', preflight: 'transaction-preflight', 'transaction-preflight': 'transaction-preflight', payment: 'verify-payment', 'payment-proof': 'verify-payment', 'verify-payment': 'verify-payment' };
const selectedService = aliases[serviceName];
if (!selectedService) throw new Error('Unknown service. Use token-preview, preflight or payment.');
const recoveryFile = process.env.RECOVERY_FILE || (selectedService === 'token-preview' ? 'kushbitx-recovery.json' : 'kushbitx-' + selectedService + '-recovery.json');
const reportFile = process.env.REPORT_FILE || (selectedService === 'token-preview' ? 'kushbitx-report.json' : 'kushbitx-' + selectedService + '-report.json');
const post = (path, body, headers = {}) => fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
const required = (name, hint) => {
  const value = process.env[name];
  if (!value) throw new Error('Set ' + name + ' before this run. ' + hint);
  return value;
};
function serviceConfig(accountAddress) {
  if (selectedService === 'token-preview') return { path: '/api/token-preview', amount: '250000', price: '0.25', input: { chain: 'base', address: process.env.TOKEN_ADDRESS || asset } };
  if (selectedService === 'transaction-preflight') return { path: '/api/transaction-preflight', amount: '50000', price: '0.05', input: { chain: 'base', from: process.env.TX_FROM || accountAddress, to: required('TX_TO', 'Use the unsigned transaction destination.'), valueWei: process.env.TX_VALUE_WEI || '0', data: process.env.TX_DATA || '0x' } };
  return { path: '/api/verify-payment', amount: '10000', price: '0.01', input: { chain: 'base', txHash: required('TX_HASH', 'Use the Base transaction hash to verify.'), expectedTo: required('EXPECTED_TO', 'Use the exact expected USDC recipient.'), expectedAmount: required('EXPECTED_AMOUNT', 'Use the exact expected USDC amount.'), ...(process.env.EXPECTED_FROM ? { expectedFrom: process.env.EXPECTED_FROM } : {}) } };
}
async function consume(response) {
  const data = await response.json();
  if (response.status === 202) throw new Error('Still processing. Use --restore. Do not start a new payment.');
  if (!response.ok) throw new Error(data.error || 'Request failed');
  await writeFile(reportFile, JSON.stringify(data, null, 2), { mode: 0o600 });
  const decision = data.verdict?.decision || data.decision;
  console.log(JSON.stringify({ reportFile, reportId: data.receipt?.reportId, decision, advisory: data.advisory === true, executionAuthorized: data.executionAuthorized === true, usableForNextReview: decision === 'ALLOW' && data.verdict?.confidence === 'high' }));
}
async function freeSpendGuard() {
  const spendRecipient = process.env.SPEND_RECIPIENT || recipient;
  await consume(await post('/api/spendguard/evaluate', {
    agentId: process.env.AGENT_ID || 'example-agent', requestId: process.env.REQUEST_ID || 'example-' + Date.now(), chain: 'base', asset: 'USDC', recipient: spendRecipient, amount: process.env.SPEND_AMOUNT || '1.00',
    policy: { maxPerTransaction: process.env.MAX_PER_TRANSACTION || '5.00', remainingDailyBudget: process.env.REMAINING_DAILY_BUDGET || '20.00', requireHumanAbove: process.env.REQUIRE_HUMAN_ABOVE || '2.00', maxRepeats: 1, allowedRecipients: [spendRecipient], blockUnknownRecipients: true },
    context: { repeatCount: 0, agentProofDecision: 'ALLOW' }
  }));
}
async function main() {
  if (process.argv.includes('--restore')) {
    const saved = JSON.parse(await readFile(recoveryFile, 'utf8'));
    await consume(await post('/api/orders/recover', { id: saved.id, key: saved.key, ...(process.env.PAYMENT_TX_HASH ? { txHash: process.env.PAYMENT_TX_HASH } : {}) }));
    return;
  }
  if (process.argv.includes('--spendguard')) {
    if (process.argv.includes('--paid')) throw new Error('SpendGuard preview is free. Remove --paid.');
    await freeSpendGuard();
    return;
  }
  if (!process.argv.includes('--paid')) {
    await consume(await post('/api/token-preview', { chain: 'base', address: process.env.TOKEN_ADDRESS || asset }));
    return;
  }
  if (!process.env.AGENT_PRIVATE_KEY) throw new Error('Set AGENT_PRIVATE_KEY locally for a dedicated wallet with a small USDC balance.');
  let privateKeyToAccount;
  try {
    ({ privateKeyToAccount } = await import('viem/accounts'));
  } catch {
    throw new Error('Paid mode requires viem. Run: npm install viem');
  }
  const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY);
  const config = serviceConfig(account.address);
  const first = await post(config.path, config.input);
  if (first.status !== 402) throw new Error('Expected an x402 payment challenge. No signature created.');
  const paymentRequest = JSON.parse(Buffer.from(first.headers.get('PAYMENT-REQUIRED') || '', 'base64').toString());
  const accepted = paymentRequest.accepts?.[0];
  if (paymentRequest.x402Version !== 2 || paymentRequest.resource?.url !== origin + config.path || accepted?.scheme !== 'exact' || accepted.network !== 'eip155:8453' || accepted.amount !== config.amount || accepted.asset?.toLowerCase() !== asset.toLowerCase() || accepted.payTo?.toLowerCase() !== recipient.toLowerCase() || !Number.isInteger(accepted.maxTimeoutSeconds) || accepted.maxTimeoutSeconds < 1 || accepted.maxTimeoutSeconds > 300 || accepted.extra?.name !== 'USD Coin' || accepted.extra?.version !== '2') throw new Error('Unexpected payment terms. No signature created.');
  const message = { from: account.address, to: recipient, value: BigInt(accepted.amount), validAfter: 0n, validBefore: BigInt(Math.floor(Date.now() / 1000) + accepted.maxTimeoutSeconds), nonce: '0x' + randomBytes(32).toString('hex') };
  const created = await post('/api/orders', { path: config.path, input: config.input });
  if (!created.ok) throw new Error('Report recovery could not be prepared. No signature created.');
  const saved = await created.json();
  await writeFile(recoveryFile, JSON.stringify(saved, null, 2), { mode: 0o600, flag: 'wx' });
  console.log('Recovery file saved. Authorizing exactly ' + config.price + ' USDC on Base for ' + selectedService + '.');
  const signature = await account.signTypedData({ domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: asset }, types: { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] }, primaryType: 'TransferWithAuthorization', message });
  const authorization = {
    from: message.from,
    to: message.to,
    value: message.value.toString(),
    validAfter: message.validAfter.toString(),
    validBefore: message.validBefore.toString(),
    nonce: message.nonce
  };
  const payload = { x402Version: 2, resource: paymentRequest.resource, accepted, payload: { signature, authorization }, ...(paymentRequest.extensions ? { extensions: paymentRequest.extensions } : {}) };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  await consume(await post(config.path, config.input, { 'PAYMENT-SIGNATURE': encoded, 'Report-Id': saved.id, 'Recovery-Key': saved.key }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
