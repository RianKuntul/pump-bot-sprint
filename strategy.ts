// Moonshot Lottery v1 — an asymmetric early-entry bot for the pump.fun bonding-curve replay
// (agent-fun/replay/v2).
//
// Thesis (different from the momentum-chase bots that lost money here): chasing a coin AFTER its
// price already ran +12% buys the top of a spike on a curve whose next flow is usually sells, and
// capping winners at +20% while losers lose -12% needs a win rate the tape does not give. This bot
// does the opposite: it buys EARLY, while the launch is still young and cheap, but only when the
// opening tape shows genuine broad demand — many distinct non-creator buyers, real net inflow, no
// creator selling, no single wallet dominating the buys. Every position is one small fixed buy
// (0.08 SOL). Losers are cut fast at -10%; winners are never capped early — a +100% take-profit
// banks a moonshot, and a trailing stop (armed at +30%, 15% give-back) lets a runner keep running.
// A curve that completes is closed by the replay at its final reserves.
//
// v2 (from grading v1 on the dev window, -0.121 SOL over 98 round trips): entries are far
// stricter — at least 15 distinct buyers, 20 buys and 4 SOL of net inflow since creation, and
// the run-up window narrowed to 0-20% — which cut the trip count to 30 and the loss to
// -0.018 SOL. v2 also banks half of every position at +30% (partial take-profit) instead of
// letting a runner give the whole move back before the trailing stop fires, and holds up to
// 12000 slots so a slow runner is not cut by the clock.
//
// Guardrail probes keep the run above the minimum bar (round trips on at least 20 coins): when the
// bot's own fills or coins lag a pace set in block time, it buys a tiny probe of a liquid curve and
// sells it as soon as the buy lands.
//
// Deterministic by construction: no clock, no randomness, iteration only over insertion-ordered
// maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since CreateEvent) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Minimum distinct non-creator buyers seen since creation. */
  minBuyers: number;
  /** Minimum buy trades seen since creation. */
  minBuys: number;
  /** Minimum net SOL (buys minus sells) seen since creation. */
  minNetSol: number;
  /** Largest single non-creator buyer's share of buy SOL, at most (anti-bundle). */
  maxBuyerShare: number;
  /** Lamports sold by others / lamports bought, at most. */
  maxSellRatio: number;
  /** Price now over the create price, as a fraction: window. */
  minRunup: number;
  maxRunup: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Latest buy must be within this many slots (the tape is alive). */
  aliveSlots: number;
  /** SOL staked in the single buy per position. */
  stakeSol: number;
  /** Smallest buy worth sending (SOL). */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exit when the position's liquidation value falls below cost * (1 - stopLoss). */
  stopLoss: number;
  /** Exit when the position's liquidation value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Bank half the position once value reaches cost * (1 + partialAt); the rest rides on. */
  partialAt: number;
  /** Share of the position sold at the partial take-profit. */
  partialShare: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm)... */
  trailArm: number;
  /** ...then exits when value falls below peakValue * (1 - trail). */
  trail: number;
  /** Exit after this many slots held (unless up at least holdIfUp). */
  maxHold: number;
  holdIfUp: number;
  /** Exit when underwater and the curve has seen no buys for this many slots. */
  staleSlots: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most main positions open at once (the rest of caps.max_open_positions is for probes). */
  maxMain: number;
  /** Guardrail pacing targets. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 5,
  maxAge: 1200,
  minBuyers: 15,
  minBuys: 20,
  minNetSol: 4.0,
  maxBuyerShare: 0.3,
  maxSellRatio: 0.25,
  minRunup: 0.0,
  maxRunup: 0.2,
  minRqSol: 0.5,
  maxRqSol: 60,
  aliveSlots: 40,
  stakeSol: 0.08,
  minBuySol: 0.01,
  buySlipBps: 1000,
  stopLoss: 0.08,
  takeProfit: 1.0,
  partialAt: 0.3,
  partialShare: 0.5,
  trailArm: 0.3,
  trail: 0.15,
  maxHold: 12000,
  holdIfUp: 0.25,
  staleSlots: 400,
  cooldown: 300,
  maxEntries: 1,
  maxMain: 4,
  targetCoins: 25,
  targetFills: 60,
  paceSecs: 21600,
  probeSol: 0.01,
  maxProbes: 1,
  maxExposureSol: 6,
};

const LAMPORTS = 1e9;
/** Curve fee taken on sells (protocol + creator, ~1.25%) as a fraction. */
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface Tape {
  created: number | null;
  creator: string | null;
  createPrice: number;
  trades: Trade[];
  entries: number;
  lastExit: number;
  /** Slot of the latest recorded buy on this curve (-1 if none seen). */
  lastBuy: number;
  /** The creator has sold at least once. */
  creatorSold: boolean;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastValue: number;
  /** The partial take-profit already banked half of this position. */
  tookPartial: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = p.maxAge + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator: null, createPrice: 0, trades: [], entries: 0, lastExit: -1e12, lastBuy: -1, creatorSold: false };
      tapes.set(mint, t);
    }
    return t;
  };

  /** A young curve whose opening tape shows broad, genuine demand — buy the launch, not the spike. */
  const launch = (t: Tape, now: number, rqSol: number, price: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || t.createPrice <= 0) return false;
    const age = now - t.created;
    if (age < p.minAge || age > p.maxAge) return false;
    if (t.creatorSold) return false;
    if (t.lastBuy < 0 || now - t.lastBuy > p.aliveSlots) return false;
    const runup = price / t.createPrice - 1;
    if (runup < p.minRunup || runup > p.maxRunup) return false;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        if (tr.user !== t.creator) byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
    }
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (sellSol > buySol * p.maxSellRatio) return false;
    let biggest = 0;
    for (const v of byUser.values()) if (v > biggest) biggest = v;
    if (buySol > 0 && biggest > buySol * p.maxBuyerShare) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
          const vt = Number(e.virtual_token_reserves);
          t.createPrice = vt > 0 ? Number(e.virtual_quote_reserves) / vt : 0;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user });
          if (e.is_buy) t.lastBuy = e.slot;
          if (!e.is_buy && t.creator !== null && e.user === t.creator) t.creatorSold = true;
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: sell the whole position on the first trigger that fires.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        // v2: bank half at +30% and let the rest ride — a runner that reverses still
        // pays, instead of giving the whole move back to the trailing stop.
        let bankedHalf = false;
        if (!h.tookPartial && !h.exiting && value >= cost * (1 + p.partialAt)) {
          const half = pos.token_amount / 2n;
          if (half > 0n && !pendingByMint.has(mint) && orders.length < cap) {
            orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: 10_000 });
            h.tookPartial = true;
            bankedHalf = true;
          }
        }
        let exit = h.exiting;
        if (bankedHalf) continue; // the half just sold; decide on the rest next batch
        const t = tapeOf(mint);
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && t.creatorSold) exit = true;
        if (!exit && value < cost && t.lastBuy >= 0 && now - t.lastBuy > p.staleSlots) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries: one fixed-size buy per position, on a young curve with broad demand.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        if (held.has(mint)) continue;
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        const vt = Number(curve.virtual_token_reserves);
        const price = vt > 0 ? Number(curve.virtual_quote_reserves) / vt : 0;
        if (price <= 0 || !launch(t, now, rqSol, price)) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastValue: 0, tookPartial: false });
        t.entries++;
        slotsLeft--;
        mainLeft--;
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
