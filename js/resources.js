// =============================================================================
// RESOURCES — CPU, NET and RAM, which is where WAX actually hurts.
//
// Running out of CPU is the most common way a WAX account stops working, and
// the fix is nobody's idea of obvious: stake more, wait three days to get it
// back, or rent through a system contract with its own pricing. Meanwhile the
// numbers that tell you how close you are live in `get_account` and nowhere a
// normal person looks.
//
// One call answers all of it — usage against limits, what is self-staked, and
// whether a refund is already in flight.
// =============================================================================

import { rpc } from './chain.js';

export async function resourcesOf(account) {
  const d = await rpc('get_account', { account_name: account });

  const cpu = d.cpu_limit || {};
  const net = d.net_limit || {};
  const self = d.self_delegated_bandwidth || null;

  // A refund is staked WAX on its way back, released three days after the
  // unstake. It is neither staked nor spendable in between, which is exactly
  // the state people forget they are in.
  const refund = d.refund_request ? {
    at: new Date(d.refund_request.request_time + 'Z').getTime(),
    net: parseFloat(d.refund_request.net_amount) || 0,
    cpu: parseFloat(d.refund_request.cpu_amount) || 0,
  } : null;
  if (refund) {
    refund.total = refund.net + refund.cpu;
    refund.readyAt = refund.at + 3 * 86400000;
  }

  return {
    account,
    cpu: { used: cpu.used ?? 0, max: cpu.max ?? 0, available: cpu.available ?? 0 },
    net: { used: net.used ?? 0, max: net.max ?? 0, available: net.available ?? 0 },
    ram: { used: d.ram_usage ?? 0, max: d.ram_quota ?? 0 },
    staked: {
      cpu: self ? parseFloat(self.cpu_weight) || 0 : 0,
      net: self ? parseFloat(self.net_weight) || 0 : 0,
    },
    refund,
    voter: d.voter_info ? {
      proxy: d.voter_info.proxy || '',
      producers: d.voter_info.producers || [],
      weight: Number(d.voter_info.last_vote_weight) || 0,
    } : null,
    created: d.created ? new Date(d.created + 'Z').getTime() : null,
  };
}

// A fraction, guarded: a brand-new account can report a max of zero, and 0/0
// drawn as a full bar says "you are out of CPU" to someone who is not.
export const useFraction = r => (r.max > 0 ? Math.min(1, r.used / r.max) : 0);

// µs and bytes are the units the chain speaks and nobody reads. A transfer is
// on the order of 200µs of CPU, so "how many transactions is that" is the
// honest translation of a CPU limit.
export const cpuTransactions = us => Math.floor(us / 250);
export const bytes = n => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB'
  : n >= 1024 ? (n / 1024).toFixed(0) + ' KB' : n + ' B');
export const micros = us => (us >= 1e6 ? (us / 1e6).toFixed(2) + ' s'
  : us >= 1000 ? (us / 1000).toFixed(1) + ' ms' : us + ' µs');
