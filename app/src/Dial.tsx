// The circle dial: every member is a seat on the ring, filled once they have paid
// this round. The member who collects this round gets the marigold ring.
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Circle, formatUsdc, hasPaid, recipientIndex } from './ajo';
import { c, naira } from './theme';

type Props = { circle: Circle; size?: number; me?: string; showCenter?: boolean };

export function Dial({ circle, size = 220, me, showCenter = true }: Props) {
  const n = circle.state === 'forming' ? circle.capacity : circle.members.length;
  const seat = Math.max(18, Math.min(40, size / (n > 8 ? 6.5 : 5)));
  const radius = size / 2 - seat / 2 - 4;
  const recipient = recipientIndex(circle);
  // While forming, show the pot the circle will have once full.
  const pot = circle.contribution * BigInt(circle.state === 'forming' ? circle.capacity : circle.members.length);

  return (
    <View style={{ width: size, height: size }}>
      <View
        style={[
          styles.ring,
          { width: radius * 2, height: radius * 2, borderRadius: radius, left: size / 2 - radius, top: size / 2 - radius },
        ]}
      />
      {Array.from({ length: n }, (_, i) => {
        const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
        const x = size / 2 + radius * Math.cos(angle) - seat / 2;
        const y = size / 2 + radius * Math.sin(angle) - seat / 2;
        const member = circle.members[i];
        const empty = !member;
        const paid = !empty && circle.state === 'active' && hasPaid(circle, i);
        const collecting = recipient === i;
        const isMe = !!member && member.toBase58() === me;
        return (
          <View
            key={i}
            style={[
              styles.seat,
              { left: x, top: y, width: seat, height: seat, borderRadius: seat / 2 },
              empty && styles.empty,
              paid && styles.paid,
              collecting && styles.collecting,
            ]}
          >
            <Text style={[styles.seatText, { fontSize: seat * 0.36 }, paid && { color: c.onMarigold }]}>
              {empty ? '' : isMe ? 'You' : member.toBase58().slice(0, 2)}
            </Text>
          </View>
        );
      })}
      {showCenter && (
        <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
          <Text style={styles.potLabel}>{circle.state === 'done' ? 'paid out' : 'pot'}</Text>
          <Text style={[styles.pot, { fontSize: size / 7 }]}>
            {formatUsdc(circle.state === 'done' ? circle.totalPaidOut : pot)}
          </Text>
          <Text style={styles.potSub}>
            USDC · {naira(Number(circle.state === 'done' ? circle.totalPaidOut : pot) / 1e6)}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  ring: { position: 'absolute', borderWidth: 2, borderColor: c.line },
  seat: {
    position: 'absolute',
    backgroundColor: c.card,
    borderWidth: 2,
    borderStyle: 'solid',
    borderColor: c.indigo,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: { borderStyle: 'dashed', borderColor: c.line },
  paid: { backgroundColor: c.marigold, borderColor: c.marigold },
  collecting: { borderColor: c.green, borderWidth: 4 },
  seatText: { color: c.indigo, fontWeight: '700' },
  center: { alignItems: 'center', justifyContent: 'center' },
  potLabel: { color: c.muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 },
  pot: { color: c.ink, fontWeight: '800' },
  potSub: { color: c.muted, fontSize: 12 },
});
