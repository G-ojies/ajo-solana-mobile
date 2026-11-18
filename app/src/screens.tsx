import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Linking, Pressable, RefreshControl, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { useMobileWallet } from '@wallet-ui/react-native-web3js';
import * as ajo from './ajo';
import { Dial } from './Dial';
import { Button, Card, Chips, Field, H1, Muted, explain, useSend } from './ui';
import { c, mono, naira, short } from './theme';

export type Route =
  | { name: 'home' }
  | { name: 'create' }
  | { name: 'join'; code?: string }
  | { name: 'circle'; address: string }
  | { name: 'settings' };

export type Nav = { go: (r: Route) => void; back: () => void };

const now = () => Math.floor(Date.now() / 1000);

function Screen({ children, refresh }: { children: React.ReactNode; refresh?: () => Promise<void> }) {
  const [refreshing, setRefreshing] = useState(false);
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.bg }}
      contentContainerStyle={{ padding: 18, paddingBottom: 48, gap: 14 }}
      refreshControl={
        refresh ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await refresh().finally(() => setRefreshing(false));
            }}
          />
        ) : undefined
      }
    >
      {children}
    </ScrollView>
  );
}

function TopBar({ title, nav, right }: { title: string; nav?: Nav; right?: React.ReactNode }) {
  return (
    <View style={styles.top}>
      {nav ? (
        <Pressable onPress={nav.back} hitSlop={12}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
      ) : (
        <Text style={styles.brand}>{title}</Text>
      )}
      <View style={{ flex: 1 }} />
      {right}
    </View>
  );
}

function WalletChip({ nav }: { nav: Nav }) {
  const { account, connect } = useMobileWallet();
  const [busy, setBusy] = useState(false);
  if (account) {
    return (
      <Pressable onPress={() => nav.go({ name: 'settings' })} style={styles.walletChip}>
        <View style={styles.dot} />
        <Text style={{ fontFamily: mono, color: c.ink }}>{short(account.publicKey.toBase58())}</Text>
      </Pressable>
    );
  }
  return (
    <Button
      title="Connect wallet"
      busy={busy}
      style={{ paddingVertical: 10, minHeight: 40 }}
      onPress={async () => {
        setBusy(true);
        try {
          await connect();
        } catch (e) {
          Alert.alert('Could not connect', explain(e));
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

export function Home({ nav }: { nav: Nav }) {
  const { account, connection } = useMobileWallet();
  const [circles, setCircles] = useState<ajo.Circle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const me = account?.publicKey;

  const load = useCallback(async () => {
    if (!me) return;
    try {
      setError(null);
      const all = await ajo.fetchAllCircles(connection);
      setCircles(all.filter((x) => x.members.some((m) => m.equals(me))));
    } catch (e) {
      setError(explain(e));
    }
  }, [connection, me?.toBase58()]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Screen refresh={load}>
      <TopBar title="Ajo" right={<WalletChip nav={nav} />} />
      {!me ? (
        <Card style={{ backgroundColor: c.indigo, borderColor: c.indigo, padding: 22, gap: 10 }}>
          <Text style={styles.heroTitle}>Ajo, minus the person you have to trust.</Text>
          <Text style={styles.heroBody}>
            Save with people you know. Everyone pays in each round and one person collects the whole pot. The pot sits
            in a Solana program, not with any one person.
          </Text>
          <Muted style={{ color: '#c9cde6' }}>Connect your wallet to see your circles.</Muted>
        </Card>
      ) : (
        <>
          <H1>My circles</H1>
          {error && <Muted style={{ color: c.red }}>{error}</Muted>}
          {circles === null && !error && <Muted>Loading…</Muted>}
          {circles?.length === 0 && (
            <Card style={{ gap: 6 }}>
              <Text style={styles.cardTitle}>No circles yet</Text>
              <Muted>Start one and share the code in your WhatsApp group, or join with a code someone sent you.</Muted>
            </Card>
          )}
          {circles?.map((x) => (
            <CircleCard key={x.address.toBase58()} circle={x} me={me} onPress={() => nav.go({ name: 'circle', address: x.address.toBase58() })} />
          ))}
        </>
      )}
      <Button title="Start a circle" onPress={() => nav.go({ name: 'create' })} disabled={!me} />
      <Button title="Join with code" kind="ghost" onPress={() => nav.go({ name: 'join' })} disabled={!me} />
    </Screen>
  );
}

function statusLine(x: ajo.Circle, me: PublicKey): string {
  if (x.state === 'forming') return `Forming · ${x.members.length} of ${x.capacity} joined`;
  if (x.state === 'done') return `Finished · ${ajo.formatUsdc(x.totalPaidOut)} USDC paid out`;
  const turn = ajo.roundsUntilTurn(x, me);
  const paid = `${ajo.paidCount(x)} of ${x.members.length} paid`;
  if (turn === 0) return `You collect this round! · ${paid}`;
  if (turn !== null) return `Your turn in ${turn} round${turn === 1 ? '' : 's'} · ${paid}`;
  return `You have collected · ${paid}`;
}

function CircleCard({ circle, me, onPress }: { circle: ajo.Circle; me: PublicKey; onPress: () => void }) {
  const owed = ajo.owedNow(circle, me, now());
  return (
    <Pressable onPress={onPress}>
      <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <Dial circle={circle} size={84} me={me.toBase58()} showCenter={false} />
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={styles.cardTitle}>{circle.name}</Text>
          <Text style={{ color: c.ink }}>
            {ajo.formatUsdc(circle.contribution * BigInt(circle.members.length))} USDC pot ·{' '}
            {naira(Number(circle.contribution) * circle.members.length / 1e6)}
          </Text>
          <Muted>{statusLine(circle, me)}</Muted>
          {owed && (
            <Text style={{ color: owed.late ? c.red : c.gold, fontWeight: '700' }}>
              {owed.late ? 'Late: ' : 'Due: '}pay {ajo.formatUsdc(owed.amount)} USDC
            </Text>
          )}
        </View>
      </Card>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

const ROUNDS = [
  { label: '2 min (demo)', value: 120 },
  { label: 'Weekly', value: 7 * 86400 },
  { label: 'Monthly', value: 30 * 86400 },
];

export function Create({ nav }: { nav: Nav }) {
  const { account } = useMobileWallet();
  const send = useSend();
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('10');
  const [members, setMembers] = useState(4);
  const [roundSecs, setRoundSecs] = useState(7 * 86400);
  const [lateFee, setLateFee] = useState('1');
  const [busy, setBusy] = useState(false);

  const contribution = ajo.parseUsdc(amount);
  const fee = ajo.parseUsdc(lateFee || '0');
  const graceSecs = roundSecs <= 120 ? 60 : roundSecs >= 30 * 86400 ? 3 * 86400 : 2 * 86400;
  const valid =
    name.trim().length > 0 &&
    new TextEncoder().encode(name.trim()).length <= 32 &&
    !!contribution && contribution > 0n &&
    fee !== null && fee <= contribution;

  async function create() {
    if (!account || !contribution || fee === null) return;
    setBusy(true);
    try {
      const circleId = BigInt(Date.now());
      await send([
        ajo.createCircleIx(account.publicKey, {
          circleId,
          name: name.trim(),
          contribution,
          capacity: members,
          roundSecs,
          graceSecs,
          lateFee: fee,
        }),
      ]);
      nav.go({ name: 'circle', address: ajo.circlePda(account.publicKey, circleId).toBase58() });
    } catch (e) {
      Alert.alert('Could not create the circle', explain(e));
    } finally {
      setBusy(false);
    }
  }

  const graceText = graceSecs < 3600 ? `${graceSecs / 60} min` : `${graceSecs / 86400} days`;
  return (
    <Screen>
      <TopBar title="" nav={nav} />
      <H1>Start a circle</H1>
      <Card>
        <Field label="Circle name" value={name} onChangeText={setName} placeholder="Market women, Oja Oba" maxLength={32} />
        <Field
          label="Amount per person, each round (USDC)"
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          hint={contribution ? `${naira(Number(contribution) / 1e6)} each · pot ${ajo.formatUsdc(contribution * BigInt(members))} USDC` : 'Enter an amount'}
        />
        <Chips
          label="Members"
          options={[2, 3, 4, 5, 6, 8, 10, 12].map((n) => ({ label: String(n), value: n }))}
          value={members}
          onChange={setMembers}
        />
        <Chips label="Round length" options={ROUNDS} value={roundSecs} onChange={setRoundSecs} />
        <Field
          label="Late fee (USDC)"
          value={lateFee}
          onChangeText={setLateFee}
          keyboardType="decimal-pad"
          hint={`Added if someone pays after the due date. It goes into the pot. After ${graceText} of grace, anyone can pay the round out and the missed payment is recorded.`}
        />
      </Card>
      <Muted>
        The pot sits in a Solana program, not with any one person. The payout order is drawn by code anyone can check
        when you start the circle.
      </Muted>
      <Button title="Create (sign with wallet)" busy={busy} disabled={!valid} onPress={create} />
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

export function Join({ nav, code: initial }: { nav: Nav; code?: string }) {
  const { connection } = useMobileWallet();
  const [code, setCode] = useState(initial ?? '');
  const [busy, setBusy] = useState(false);
  const [notFound, setNotFound] = useState(false);

  async function find() {
    setBusy(true);
    setNotFound(false);
    try {
      const x = await ajo.findByCode(connection, code);
      if (x) nav.go({ name: 'circle', address: x.address.toBase58() });
      else setNotFound(true);
    } catch (e) {
      Alert.alert('Could not look up the code', explain(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <TopBar title="" nav={nav} />
      <H1>Join a circle</H1>
      <Card>
        <Field
          label="Circle code"
          value={code}
          onChangeText={(t) => setCode(t.trim())}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="e.g. 7xKp2Q"
          hint="The 6-character code from your invite, or the full circle address."
        />
        {notFound && <Muted style={{ color: c.red }}>No circle with that code. Check it with whoever invited you.</Muted>}
      </Card>
      <Button title="Find circle" busy={busy} disabled={code.length < 4} onPress={find} />
      <Muted>You will see the circle's rules before you sign anything.</Muted>
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Circle
// ---------------------------------------------------------------------------

export function CircleScreen({ nav, address }: { nav: Nav; address: string }) {
  const { account, connection } = useMobileWallet();
  const send = useSend();
  const [x, setX] = useState<ajo.Circle | null | undefined>(undefined);
  const [history, setHistory] = useState<ajo.HistoryItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [clock, setClock] = useState(now());
  const key = new PublicKey(address);
  const me = account?.publicKey;

  const load = useCallback(async () => {
    const [circle, hist] = await Promise.all([
      ajo.fetchCircle(connection, key),
      ajo.fetchHistory(connection, key).catch(() => []),
    ]);
    setX(circle);
    setHistory(hist);
  }, [connection, address]);

  useEffect(() => {
    load();
    const t = setInterval(() => setClock(now()), 1000);
    const r = setInterval(load, 8000);
    return () => {
      clearInterval(t);
      clearInterval(r);
    };
  }, [load]);

  async function act(label: string, build: () => TransactionInstruction[]) {
    setBusy(label);
    try {
      await send(build());
      await load();
    } catch (e) {
      Alert.alert('Something went wrong', explain(e));
    } finally {
      setBusy(null);
    }
  }

  if (x === undefined) {
    return (
      <Screen>
        <TopBar title="" nav={nav} />
        <Muted>Loading the circle…</Muted>
      </Screen>
    );
  }
  if (x === null) {
    return (
      <Screen>
        <TopBar title="" nav={nav} />
        <H1>Circle not found</H1>
        <Muted>It may have been closed by its creator.</Muted>
      </Screen>
    );
  }

  const n = x.members.length;
  const myIndex = me ? x.members.findIndex((m) => m.equals(me)) : -1;
  const isMember = myIndex >= 0;
  const isCreator = !!me && x.creator.equals(me);
  const r = ajo.recipientIndex(x);
  const recipient = r !== null ? x.members[r] : null;
  const label = (k: PublicKey) => (me && k.equals(me) ? 'You' : short(k.toBase58()));
  const owed = me ? ajo.owedNow(x, me, clock) : null;
  const due = ajo.dueTs(x);
  const left = due - clock;

  let status = '';
  if (x.state === 'forming') status = `${n} of ${x.capacity} joined · waiting for the creator to start`;
  if (x.state === 'active')
    status = `Round ${x.round + 1} of ${n} · ${ajo.paidCount(x)} of ${n} paid · ${recipient ? label(recipient) : ''} collect${recipient && me && recipient.equals(me) ? '' : 's'} when everyone has paid`;
  if (x.state === 'done') status = `Finished · every member collected once`;

  const invite = async () => {
    const code = ajo.joinCode(x.address);
    await Share.share({
      message: `Join my ajo circle "${x.name}" on Ajo. ${ajo.formatUsdc(x.contribution)} USDC per round, ${x.capacity} members. Code: ${code}\najo://join/${x.address.toBase58()}`,
    });
  };

  return (
    <Screen refresh={load}>
      <TopBar
        title=""
        nav={nav}
        right={x.state === 'forming' ? <Button title="Invite" kind="ghost" style={{ paddingVertical: 8, minHeight: 38 }} onPress={invite} /> : undefined}
      />
      <H1>{x.name}</H1>
      <View style={{ alignItems: 'center', paddingVertical: 6 }}>
        <Dial circle={x} size={250} me={me?.toBase58()} />
      </View>
      <Text style={styles.status}>{status}</Text>
      {x.state === 'active' && (
        <Muted style={{ textAlign: 'center' }}>
          {left > 0 ? `Due in ${fmtDuration(left)}` : `Past due by ${fmtDuration(-left)}. Late payments add ${ajo.formatUsdc(x.lateFee)} USDC.`}
        </Muted>
      )}

      {/* Primary action */}
      {x.state === 'forming' && !isMember && me && (
        <Button title={`Join (${ajo.formatUsdc(x.contribution)} USDC per round)`} busy={busy === 'join'} disabled={n >= x.capacity}
          onPress={() => act('join', () => [ajo.joinIx(me, x.address)])} />
      )}
      {x.state === 'forming' && isCreator && (
        <Button title={n < 2 ? 'Waiting for members to join' : `Start the circle with ${n} members`} disabled={n < 2} busy={busy === 'start'}
          onPress={() => act('start', () => [ajo.startIx(me!, x.address)])} />
      )}
      {x.state === 'forming' && isMember && !isCreator && <Muted style={{ textAlign: 'center' }}>You are in. The creator starts the circle.</Muted>}
      {x.state === 'forming' && <Button title="Share invite" kind="ghost" onPress={invite} />}

      {x.state === 'active' && owed && (
        <Button title={`Pay my ${ajo.formatUsdc(owed.amount)} USDC${owed.late ? ' (late)' : ''}`} kind="gold" busy={busy === 'pay'}
          onPress={() => act('pay', () => [ajo.contributeIx(me!, x)])} />
      )}
      {x.state === 'active' && isMember && !owed && <Text style={[styles.status, { color: c.green }]}>Paid this round ✓</Text>}
      {x.state === 'active' && ajo.canPayout(x, clock) && me && recipient && (
        <Button title={`Send pot to ${label(recipient)}`} busy={busy === 'payout'}
          onPress={() => act('payout', () => ajo.payoutIxs(me, x))} />
      )}
      {x.state === 'done' && isCreator && (
        <Button title="Close circle and get the rent back" kind="ghost" busy={busy === 'close'}
          onPress={() => act('close', () => [ajo.closeCircleIx(me!, x)])} />
      )}

      {/* Rules */}
      <Card style={{ gap: 4 }}>
        <Text style={styles.cardTitle}>Rules</Text>
        <Muted>{ajo.formatUsdc(x.contribution)} USDC per person per round ({naira(Number(x.contribution) / 1e6)})</Muted>
        <Muted>{x.capacity} members · rounds of {fmtDuration(x.roundSecs)}</Muted>
        <Muted>Late fee {ajo.formatUsdc(x.lateFee)} USDC · grace {fmtDuration(x.graceSecs)} before the round can be paid out without everyone</Muted>
        <Muted>Code {ajo.joinCode(x.address)}</Muted>
      </Card>

      {/* Order */}
      {x.state !== 'forming' && (
        <Card style={{ gap: 8 }}>
          <Text style={styles.cardTitle}>Payout order</Text>
          {x.order.map((idx, round) => {
            const m = x.members[idx];
            const st = round < x.round ? 'collected' : round === x.round && x.state === 'active' ? 'collecting now' : 'waiting';
            return (
              <View key={round} style={styles.row}>
                <Text style={styles.round}>{round + 1}</Text>
                <Text style={[styles.member, me && m.equals(me) && { fontWeight: '800' }]}>{label(m)}</Text>
                {x.missed[idx] > 0 && <Text style={styles.missed}>missed {x.missed[idx]}</Text>}
                <Text style={[styles.badge, st === 'collected' && { color: c.green }, st === 'collecting now' && { color: c.gold }]}>{st}</Text>
              </View>
            );
          })}
          <Muted style={{ fontSize: 12 }}>Drawn from the circle address and member list when it started. Anyone can recompute it.</Muted>
        </Card>
      )}

      {/* Members (forming) */}
      {x.state === 'forming' && (
        <Card style={{ gap: 8 }}>
          <Text style={styles.cardTitle}>Members</Text>
          {x.members.map((m, i) => (
            <View key={i} style={styles.row}>
              <Text style={styles.member}>{label(m)}</Text>
              {i === 0 && <Text style={styles.badge}>creator</Text>}
            </View>
          ))}
        </Card>
      )}

      {/* History */}
      <Card style={{ gap: 8 }}>
        <Text style={styles.cardTitle}>History</Text>
        {history.length === 0 && <Muted>Nothing yet.</Muted>}
        {history.map((h) => (
          <Pressable key={h.signature} onPress={() => Linking.openURL(ajo.explorerTx(h.signature))} style={styles.row}>
            <Text style={styles.member}>
              {h.who ? label(h.who) : '?'} {historyVerb(h.kind)}
            </Text>
            <Text style={styles.badge}>{h.time ? new Date(h.time * 1000).toLocaleString() : ''} ↗</Text>
          </Pressable>
        ))}
        <Muted style={{ fontSize: 12 }}>Every line here is a Solana transaction. Nobody can edit it.</Muted>
      </Card>
      <Pressable onPress={() => Linking.openURL(ajo.explorerAddress(x.address))}>
        <Muted style={{ textAlign: 'center', textDecorationLine: 'underline' }}>View circle on Solana Explorer</Muted>
      </Pressable>
    </Screen>
  );
}

function historyVerb(k: ajo.HistoryItem['kind']): string {
  return {
    created: 'started the circle',
    joined: 'joined',
    started: 'drew the order and began round 1',
    paid: 'paid in',
    payout: 'sent the pot out',
    closed: 'closed the circle',
    other: 'sent a transaction',
  }[k];
}

function fmtDuration(s: number): string {
  if (s < 120) return `${Math.max(0, Math.round(s))} sec`;
  if (s < 7200) return `${Math.round(s / 60)} min`;
  if (s < 2 * 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function Settings({ nav }: { nav: Nav }) {
  const { account, connection, disconnect } = useMobileWallet();
  const [sol, setSol] = useState<number | null>(null);
  const [usdc, setUsdc] = useState<string | null>(null);

  useEffect(() => {
    if (!account) return;
    connection.getBalance(account.publicKey).then((l) => setSol(l / 1e9)).catch(() => {});
    connection
      .getTokenAccountBalance(ajo.ata(account.publicKey))
      .then((b) => setUsdc(b.value.uiAmountString ?? '0'))
      .catch(() => setUsdc('0'));
  }, [account?.publicKey.toBase58()]);

  return (
    <Screen>
      <TopBar title="" nav={nav} />
      <H1>Settings</H1>
      <Card style={{ gap: 6 }}>
        <Text style={styles.cardTitle}>Wallet</Text>
        <Text selectable style={{ fontFamily: mono, color: c.ink }}>{account?.publicKey.toBase58() ?? 'Not connected'}</Text>
        <Muted>{sol === null ? '' : `${sol.toFixed(3)} SOL · ${usdc ?? '…'} test USDC`}</Muted>
      </Card>
      <Card style={{ gap: 6 }}>
        <Text style={styles.cardTitle}>Network: Solana devnet</Text>
        <Muted>This build uses test money. Get test SOL for fees from the faucet. Test USDC comes from the circle organiser.</Muted>
        <Button title="Get test SOL" kind="ghost" onPress={() => Linking.openURL('https://faucet.solana.com')} />
        <Muted style={{ fontSize: 12 }}>Test USDC mint {short(ajo.USDC_MINT.toBase58())} · program {short(ajo.PROGRAM_ID.toBase58())}</Muted>
      </Card>
      {account && (
        <Button
          title="Disconnect wallet"
          kind="danger"
          onPress={async () => {
            await disconnect();
            nav.go({ name: 'home' });
          }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  brand: { fontSize: 28, fontWeight: '900', color: c.indigo, letterSpacing: 0.5 },
  back: { fontSize: 17, color: c.primary, fontWeight: '700' },
  walletChip: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: c.card, borderColor: c.line, borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.green },
  heroTitle: { color: '#fff', fontSize: 24, fontWeight: '800', lineHeight: 30 },
  heroBody: { color: '#e7e9f6', fontSize: 15, lineHeight: 22 },
  cardTitle: { fontSize: 17, fontWeight: '800', color: c.ink },
  status: { textAlign: 'center', color: c.ink, fontSize: 15, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  round: { width: 24, height: 24, borderRadius: 12, backgroundColor: c.goldSoft, textAlign: 'center', lineHeight: 24, color: c.gold, fontWeight: '800' },
  member: { flex: 1, color: c.ink, fontFamily: mono },
  missed: { color: c.red, backgroundColor: c.redSoft, paddingHorizontal: 6, borderRadius: 6, fontSize: 12 },
  badge: { color: c.muted, fontSize: 12 },
});
