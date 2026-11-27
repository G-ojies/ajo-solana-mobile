// Solana Pay transaction request for paying an Ajo round.
//
//   solana:https://<host>/api/pay?circle=<circle address>[&reference=<random pubkey>]
//
// GET returns the label and icon the wallet shows. POST {account} returns the same unsigned
// `contribute` transaction the app sends, with the wallet as the only signer and fee payer.
// The server holds no keys. An optional `reference` key is appended read-only so the app or
// the join page can find the payment with getSignaturesForAddress(reference).
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import * as ajo from '../app/src/ajo';

const RPC = process.env.RPC ?? ajo.DEVNET_RPC;
const ICON = 'https://g-ojies.github.io/ajo-solana-mobile/icon.png';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Accept-Encoding',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
  });
}

function fail(status: number, message: string): Response {
  return json({ error: message, message }, status);
}

function key(s: string | null | undefined): PublicKey | null {
  if (!s) return null;
  try {
    return new PublicKey(s);
  } catch {
    return null;
  }
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

export function GET(): Response {
  return json({ label: 'Ajo', icon: ICON });
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const circleKey = key(url.searchParams.get('circle'));
  if (!circleKey) return fail(400, 'Missing or invalid circle address.');
  const refParam = url.searchParams.get('reference');
  const reference = key(refParam);
  if (refParam && !reference) return fail(400, 'Invalid reference.');

  let body: { account?: string };
  try {
    body = await request.json();
  } catch {
    return fail(400, 'Body must be JSON with an account field.');
  }
  const member = key(body.account);
  if (!member) return fail(400, 'Missing or invalid account.');

  const conn = new Connection(RPC, 'confirmed');
  let c: ajo.Circle | null;
  try {
    c = await ajo.withTimeout(ajo.fetchCircle(conn, circleKey), 8000);
  } catch {
    return fail(502, 'Could not reach Solana. Try again.');
  }
  if (!c) return fail(404, 'That circle does not exist.');
  if (c.state !== 'active') return fail(400, `"${c.name}" is not collecting payments (${c.state}).`);
  const i = c.members.findIndex((m) => m.equals(member));
  if (i < 0) return fail(400, `This wallet is not a member of "${c.name}".`);
  if (ajo.hasPaid(c, i)) return fail(400, `This wallet already paid round ${c.round + 1} of "${c.name}".`);
  const owed = ajo.owedNow(c, member, Math.floor(Date.now() / 1000))!;

  let balance = 0n;
  try {
    const b = await ajo.withTimeout(conn.getTokenAccountBalance(ajo.ata(member, c.mint)), 8000);
    balance = BigInt(b.value.amount);
  } catch {
    balance = 0n; // no token account yet
  }
  if (balance < owed.amount) {
    return fail(400, `Not enough USDC: round ${c.round + 1} needs ${ajo.formatUsdc(owed.amount)}, wallet has ${ajo.formatUsdc(balance)}.`);
  }

  const ix = ajo.contributeIx(member, c);
  if (reference) ix.keys.push({ pubkey: reference, isSigner: false, isWritable: false });
  let blockhash: string;
  try {
    blockhash = (await ajo.withTimeout(conn.getLatestBlockhash('confirmed'), 8000)).blockhash;
  } catch {
    return fail(502, 'Could not reach Solana. Try again.');
  }
  const tx = new Transaction({ feePayer: member, recentBlockhash: blockhash }).add(ix);
  const transaction = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');

  const late = owed.late ? ' (includes late fee)' : '';
  return json({
    transaction,
    message: `Pay ${ajo.formatUsdc(owed.amount)} USDC${late} for round ${c.round + 1} of "${c.name}"`,
  });
}
