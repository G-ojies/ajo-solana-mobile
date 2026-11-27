// Client for the `ajo` program: PDAs, instruction builders and the Circle decoder.
// Plain @solana/web3.js v1 + spl-token, no Anchor TS dependency, so the same file
// runs in the React Native app and in Node scripts.

import { Buffer } from 'buffer';
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

export const PROGRAM_ID = new PublicKey('66oEASieGnPhV51Xi1TVWFhotG3TfjpBYXHVUPpVXF7b');
/** Devnet test USDC (6 decimals). */
export const USDC_MINT = new PublicKey('234ncajJBfiu5MZwZqExTjhzhotgWz1nqWJjzR6KpqMJ');
export const USDC_DECIMALS = 6;
export const DEVNET_RPC = 'https://api.devnet.solana.com';

const DISC = {
  createCircle: [186, 99, 49, 131, 31, 51, 13, 198],
  join: [206, 55, 2, 106, 113, 220, 17, 163],
  start: [62, 15, 117, 236, 47, 1, 89, 139],
  contribute: [82, 33, 68, 131, 32, 0, 205, 95],
  payout: [149, 140, 194, 236, 174, 189, 6, 239],
  closeCircle: [249, 63, 161, 46, 147, 239, 34, 37],
  circleAccount: [27, 59, 8, 117, 62, 199, 222, 252],
};

export type CircleState = 'forming' | 'active' | 'done';

export type Circle = {
  address: PublicKey;
  creator: PublicKey;
  circleId: bigint;
  name: string;
  mint: PublicKey;
  vault: PublicKey;
  tokenProgram: PublicKey;
  contribution: bigint;
  lateFee: bigint;
  roundSecs: number;
  graceSecs: number;
  capacity: number;
  state: CircleState;
  createdTs: number;
  startTs: number;
  round: number;
  paidMask: number;
  members: PublicKey[];
  order: number[];
  missed: number[];
  totalPaidOut: bigint;
};

// ---------------------------------------------------------------------------
// Little-endian helpers (no Buffer-specific APIs, so Hermes is happy).
// ---------------------------------------------------------------------------

function u64le(v: bigint): number[] {
  const out: number[] = [];
  let x = BigInt.asUintN(64, v);
  for (let i = 0; i < 8; i++) {
    out.push(Number(x & 0xffn));
    x >>= 8n;
  }
  return out;
}

function u32le(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

class Reader {
  private o = 0;
  constructor(private d: Uint8Array) {}
  u8() {
    return this.d[this.o++];
  }
  u16() {
    const v = this.d[this.o] | (this.d[this.o + 1] << 8);
    this.o += 2;
    return v;
  }
  u32() {
    const v =
      (this.d[this.o] | (this.d[this.o + 1] << 8) | (this.d[this.o + 2] << 16)) +
      this.d[this.o + 3] * 0x1000000;
    this.o += 4;
    return v;
  }
  u64() {
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(this.d[this.o + i]);
    this.o += 8;
    return v;
  }
  i64() {
    return Number(BigInt.asIntN(64, this.u64()));
  }
  key() {
    const k = new PublicKey(this.d.slice(this.o, this.o + 32));
    this.o += 32;
    return k;
  }
  str() {
    const n = this.u32();
    const s = new TextDecoder().decode(this.d.slice(this.o, this.o + n));
    this.o += n;
    return s;
  }
  bytes() {
    const n = this.u32();
    const b = Array.from(this.d.slice(this.o, this.o + n));
    this.o += n;
    return b;
  }
  keys() {
    const n = this.u32();
    return Array.from({ length: n }, () => this.key());
  }
}

// ---------------------------------------------------------------------------
// PDAs
// ---------------------------------------------------------------------------

export function circlePda(creator: PublicKey, circleId: bigint): PublicKey {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('circle'), creator.toBytes(), Uint8Array.from(u64le(circleId))],
    PROGRAM_ID,
  )[0];
}

export function vaultPda(circle: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('vault'), circle.toBytes()],
    PROGRAM_ID,
  )[0];
}

export function ata(owner: PublicKey, mint = USDC_MINT): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

export function decodeCircle(address: PublicKey, data: Uint8Array): Circle {
  for (let i = 0; i < 8; i++) {
    if (data[i] !== DISC.circleAccount[i]) throw new Error('not a Circle account');
  }
  const r = new Reader(data.subarray(8));
  const creator = r.key();
  const circleId = r.u64();
  const name = r.str();
  const mint = r.key();
  const vault = r.key();
  const tokenProgram = r.key();
  const contribution = r.u64();
  const lateFee = r.u64();
  const roundSecs = r.i64();
  const graceSecs = r.i64();
  const capacity = r.u8();
  const state = (['forming', 'active', 'done'] as const)[r.u8()];
  const createdTs = r.i64();
  const startTs = r.i64();
  const round = r.u8();
  const paidMask = r.u16();
  const members = r.keys();
  const order = r.bytes();
  const missed = r.bytes();
  const totalPaidOut = r.u64();
  return {
    address, creator, circleId, name, mint, vault, tokenProgram, contribution, lateFee,
    roundSecs, graceSecs, capacity, state, createdTs, startTs, round, paidMask, members,
    order, missed, totalPaidOut,
  };
}

export async function fetchCircle(conn: Connection, address: PublicKey): Promise<Circle | null> {
  const acct = await withTimeout(conn.getAccountInfo(address));
  if (!acct || !acct.owner.equals(PROGRAM_ID)) return null;
  return decodeCircle(address, acct.data);
}

/** Reject if `p` takes longer than `ms` (RPC calls can hang on weak mobile connections). */
export function withTimeout<T>(p: Promise<T>, ms = 20000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Network request timed out')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Every circle of the program. Fine on devnet; mainnet would want an index. */
export async function fetchAllCircles(conn: Connection): Promise<Circle[]> {
  const accts = await withTimeout(conn.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58Disc() } }],
  }));
  return accts
    .map((a) => {
      try {
        return decodeCircle(a.pubkey, a.account.data);
      } catch {
        return null;
      }
    })
    .filter((c): c is Circle => c !== null)
    .sort((a, b) => b.createdTs - a.createdTs);
}

function bs58Disc(): string {
  return encodeBase58(Uint8Array.from(DISC.circleAccount));
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function encodeBase58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
}

/** Find a circle by the short join code (first 6 characters of its address). */
export async function findByCode(conn: Connection, code: string): Promise<Circle | null> {
  const c = code.trim();
  if (c.length >= 32) {
    try {
      return await fetchCircle(conn, new PublicKey(c));
    } catch {
      return null;
    }
  }
  const all = await fetchAllCircles(conn);
  return all.find((x) => x.address.toBase58().startsWith(c)) ?? null;
}

/** Web page that shows the circle and opens the app (WhatsApp links https, not custom schemes). */
export const JOIN_PAGE = 'https://g-ojies.github.io/ajo-solana-mobile/join/';

export function inviteLink(circle: PublicKey): string {
  return `${JOIN_PAGE}?c=${circle.toBase58()}`;
}

/** Solana Pay transaction-request endpoint (api/pay.ts at the repo root, deployed on Vercel). */
export const PAY_API = 'https://ajo-pay.vercel.app/api/pay';

/**
 * Solana Pay link a member scans with any wallet that supports transaction requests to pay their
 * round. The endpoint builds the same `contribute` transaction the app sends; `reference` is a
 * random key the app watches with getSignaturesForAddress to notice the payment.
 */
export function payRequestUrl(circle: PublicKey, reference?: PublicKey): string {
  const q = `circle=${circle.toBase58()}${reference ? `&reference=${reference.toBase58()}` : ''}`;
  return `solana:${encodeURIComponent(`${PAY_API}?${q}`)}`;
}

export function joinCode(circle: PublicKey): string {
  return circle.toBase58().slice(0, 6);
}

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

export function hasPaid(c: Circle, i: number): boolean {
  return (c.paidMask & (1 << i)) !== 0;
}

export type MemberRecord = { circles: number; rounds: number; missed: number };

/**
 * A member's payment record across every circle, from the program's own counters: rounds that have
 * been paid out while they were a member, and how many of those they missed. The current, unfinished
 * round is not counted.
 */
export function memberRecord(circles: Circle[], member: PublicKey): MemberRecord {
  const r: MemberRecord = { circles: 0, rounds: 0, missed: 0 };
  for (const c of circles) {
    const i = c.members.findIndex((m) => m.equals(member));
    if (i < 0) continue;
    r.circles += 1;
    r.rounds += c.round;
    r.missed += c.missed[i] ?? 0;
  }
  return r;
}

export function recordText(r: MemberRecord): string {
  if (r.rounds === 0) return 'new: no rounds yet';
  if (r.missed === 0) return `paid all ${r.rounds} round${r.rounds === 1 ? '' : 's'}`;
  return `paid ${r.rounds - r.missed} of ${r.rounds} rounds`;
}

export function paidCount(c: Circle): number {
  return c.members.filter((_, i) => hasPaid(c, i)).length;
}

export function recipientIndex(c: Circle): number | null {
  if (c.state !== 'active') return null;
  return c.order[c.round] ?? null;
}

export function dueTs(c: Circle): number {
  return c.startTs + (c.round + 1) * c.roundSecs;
}

/** What `member` owes now, or null if they already paid / are not in it. */
export function owedNow(c: Circle, member: PublicKey, nowSecs: number): { amount: bigint; late: boolean } | null {
  const i = c.members.findIndex((m) => m.equals(member));
  if (i < 0 || c.state !== 'active' || hasPaid(c, i)) return null;
  const late = nowSecs > dueTs(c);
  return { amount: c.contribution + (late ? c.lateFee : 0n), late };
}

export function canPayout(c: Circle, nowSecs: number): boolean {
  if (c.state !== 'active') return false;
  if (paidCount(c) === c.members.length) return true;
  return nowSecs > dueTs(c) + c.graceSecs;
}

/** Rounds until `member` collects: 0 = this round, null = already collected or not a member. */
export function roundsUntilTurn(c: Circle, member: PublicKey): number | null {
  const i = c.members.findIndex((m) => m.equals(member));
  if (i < 0 || c.state === 'done') return null;
  if (c.state === 'forming') return null;
  const turn = c.order.indexOf(i);
  return turn >= c.round ? turn - c.round : null;
}

export function formatUsdc(v: bigint): string {
  const whole = v / 1_000_000n;
  const frac = v % 1_000_000n;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(6, '0').replace(/0+$/, '')}`;
}

export function parseUsdc(s: string): bigint | null {
  const m = s.trim().match(/^(\d+)(?:\.(\d{0,6}))?$/);
  if (!m) return null;
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0') || '0');
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

export type CreateParams = {
  circleId: bigint;
  name: string;
  contribution: bigint;
  capacity: number;
  roundSecs: number;
  graceSecs: number;
  lateFee: bigint;
};

export function createCircleIx(creator: PublicKey, p: CreateParams, mint = USDC_MINT): TransactionInstruction {
  const circle = circlePda(creator, p.circleId);
  const name = Array.from(new TextEncoder().encode(p.name));
  const data = [
    ...DISC.createCircle,
    ...u64le(p.circleId),
    ...u32le(name.length),
    ...name,
    ...u64le(p.contribution),
    p.capacity,
    ...u64le(BigInt(p.roundSecs)),
    ...u64le(BigInt(p.graceSecs)),
    ...u64le(p.lateFee),
  ];
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: circle, isSigner: false, isWritable: true },
      { pubkey: vaultPda(circle), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export function joinIx(member: PublicKey, circle: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: member, isSigner: true, isWritable: false },
      { pubkey: circle, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(DISC.join),
  });
}

export function startIx(creator: PublicKey, circle: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: creator, isSigner: true, isWritable: false },
      { pubkey: circle, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(DISC.start),
  });
}

export function contributeIx(member: PublicKey, c: Circle): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: member, isSigner: true, isWritable: false },
      { pubkey: c.address, isSigner: false, isWritable: true },
      { pubkey: c.mint, isSigner: false, isWritable: false },
      { pubkey: ata(member, c.mint), isSigner: false, isWritable: true },
      { pubkey: c.vault, isSigner: false, isWritable: true },
      { pubkey: c.tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(DISC.contribute),
  });
}

/** Creates the recipient's token account if needed, then pays the round out. */
export function payoutIxs(cranker: PublicKey, c: Circle): TransactionInstruction[] {
  const r = recipientIndex(c);
  if (r === null) throw new Error('circle is not active');
  const recipient = c.members[r];
  const recipientToken = ata(recipient, c.mint);
  return [
    createAssociatedTokenAccountIdempotentInstruction(cranker, recipientToken, recipient, c.mint, c.tokenProgram),
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: cranker, isSigner: true, isWritable: false },
        { pubkey: c.address, isSigner: false, isWritable: true },
        { pubkey: c.mint, isSigner: false, isWritable: false },
        { pubkey: c.vault, isSigner: false, isWritable: true },
        { pubkey: recipientToken, isSigner: false, isWritable: true },
        { pubkey: c.tokenProgram, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(DISC.payout),
    }),
  ];
}

export function closeCircleIx(creator: PublicKey, c: Circle): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: c.address, isSigner: false, isWritable: true },
      { pubkey: c.vault, isSigner: false, isWritable: true },
      { pubkey: c.tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(DISC.closeCircle),
  });
}

// ---------------------------------------------------------------------------
// History: every transaction that touched the circle, read from its logs.
// ---------------------------------------------------------------------------

export type HistoryItem = {
  signature: string;
  time: number | null;
  kind: 'created' | 'joined' | 'started' | 'paid' | 'payout' | 'closed' | 'other';
  who: PublicKey | null;
};

const historyCache = new Map<string, HistoryItem>();

function classify(sig: string, time: number | null, tx: Awaited<ReturnType<Connection['getTransaction']>>): HistoryItem {
  const logs = tx?.meta?.logMessages ?? [];
  const has = (n: string) => logs.some((l) => l === `Program log: Instruction: ${n}`);
  const kind: HistoryItem['kind'] = has('CreateCircle')
    ? 'created'
    : has('Join')
      ? 'joined'
      : has('Start')
        ? 'started'
        : has('Contribute')
          ? 'paid'
          : has('Payout')
            ? 'payout'
            : has('CloseCircle')
              ? 'closed'
              : 'other';
  // The acting member is the last required signer (the first one may be a separate fee payer).
  const msg = tx?.transaction.message;
  const keys = msg?.getAccountKeys?.().staticAccountKeys;
  const who = keys && msg ? keys[Math.max(0, msg.header.numRequiredSignatures - 1)] : null;
  return { signature: sig, time, kind, who };
}

/**
 * Transactions that touched the circle, newest first. Each transaction is fetched once and cached,
 * one at a time, so the public devnet RPC does not rate-limit us. On an RPC error it returns what it has.
 */
export async function fetchHistory(conn: Connection, circle: PublicKey, limit = 25): Promise<HistoryItem[]> {
  const sigs = (await conn.getSignaturesForAddress(circle, { limit })).filter((s) => !s.err);
  for (const s of sigs) {
    if (historyCache.has(s.signature)) continue;
    try {
      const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
      if (tx) historyCache.set(s.signature, classify(s.signature, s.blockTime ?? null, tx));
    } catch {
      break; // rate limited: show what we have, fill in on the next refresh
    }
  }
  return sigs.map((s) => historyCache.get(s.signature)).filter((h): h is HistoryItem => !!h);
}

export function explorerTx(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

export function explorerAddress(a: PublicKey): string {
  return `https://explorer.solana.com/address/${a.toBase58()}?cluster=devnet`;
}
