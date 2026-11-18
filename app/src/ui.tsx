import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  View,
  ViewStyle,
} from 'react-native';
import { Transaction, TransactionInstruction } from '@solana/web3.js';
import { useMobileWallet } from '@wallet-ui/react-native-web3js';
import { c } from './theme';

export function Button({
  title,
  onPress,
  kind = 'primary',
  busy,
  disabled,
  style,
}: {
  title: string;
  onPress?: () => void;
  kind?: 'primary' | 'gold' | 'ghost' | 'danger';
  busy?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
}) {
  const bg = { primary: c.primary, gold: c.marigold, ghost: 'transparent', danger: c.red }[kind];
  const fg = { primary: c.onPrimary, gold: c.onMarigold, ghost: c.primary, danger: '#fff' }[kind];
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={off ? undefined : onPress}
      style={({ pressed }) => [
        styles.btn,
        { backgroundColor: bg, opacity: off ? 0.55 : pressed ? 0.85 : 1 },
        kind === 'ghost' && styles.ghost,
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[styles.btnText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Field({ label, hint, ...props }: TextInputProps & { label: string; hint?: string }) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput placeholderTextColor={c.muted} style={styles.input} {...props} />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Chips<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.chips}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <Pressable
              key={String(o.value)}
              onPress={() => onChange(o.value)}
              style={[styles.chip, on && { backgroundColor: c.primary, borderColor: c.primary }]}
            >
              <Text style={{ color: on ? c.onPrimary : c.ink, fontWeight: '600' }}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function H1({ children }: { children: React.ReactNode }) {
  return <Text style={styles.h1}>{children}</Text>;
}

export function Muted({ children, style }: { children: React.ReactNode; style?: object }) {
  return <Text style={[styles.muted, style]}>{children}</Text>;
}

/** Build, sign with the phone wallet (MWA) and confirm a transaction. */
export function useSend() {
  const { account, connection, signAndSendTransaction } = useMobileWallet();
  return async (ixs: TransactionInstruction[]): Promise<string> => {
    if (!account) throw new Error('Connect your wallet first');
    const {
      context: { slot: minContextSlot },
      value: { blockhash, lastValidBlockHeight },
    } = await connection.getLatestBlockhashAndContext();
    const tx = new Transaction({ feePayer: account.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
    const sig = (await signAndSendTransaction(tx, minContextSlot)) as unknown as string;
    const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    if (res.value.err) throw new Error(`Transaction failed: ${JSON.stringify(res.value.err)}`);
    return sig;
  };
}

/** Turn a wallet or program error into one line a person can act on. */
export function explain(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  const known: [RegExp, string][] = [
    [/insufficient funds|0x1\b/i, 'Not enough test USDC or SOL in this wallet. See Settings for how to get some.'],
    [/declined|rejected|cancel/i, 'You cancelled in the wallet.'],
    [/AlreadyPaid|0x177d/i, 'You have already paid this round.'],
    [/RoundNotReady|0x177f/i, 'Not everyone has paid yet, and the grace period is still running.'],
    [/CircleFull|0x1777/i, 'This circle is full.'],
    [/AlreadyMember|0x1778/i, 'You are already in this circle.'],
    [/NotForming|0x1776/i, 'This circle has already started.'],
  ];
  for (const [re, msg] of known) if (re.test(s)) return msg;
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

const styles = StyleSheet.create({
  btn: { paddingVertical: 15, paddingHorizontal: 18, borderRadius: 14, alignItems: 'center', minHeight: 52, justifyContent: 'center' },
  ghost: { borderWidth: 1.5, borderColor: c.primary },
  btnText: { fontSize: 16, fontWeight: '700' },
  card: { backgroundColor: c.card, borderRadius: 18, padding: 16, borderWidth: 1, borderColor: c.line },
  label: { color: c.ink, fontWeight: '700', marginBottom: 6 },
  input: {
    backgroundColor: c.field,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: c.ink,
  },
  hint: { color: c.muted, fontSize: 13, marginTop: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 9, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: c.line, backgroundColor: c.card },
  h1: { fontSize: 26, fontWeight: '800', color: c.ink },
  muted: { color: c.muted, fontSize: 14, lineHeight: 20 },
});
