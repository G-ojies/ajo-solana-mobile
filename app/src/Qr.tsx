// QR code drawn with plain Views (no native module): one row of cells per QR row.
import React, { useMemo } from 'react';
import { View } from 'react-native';
import QRCode from 'qrcode';
import { c } from './theme';

export function Qr({ value, size = 200 }: { value: string; size?: number }) {
  const rows = useMemo(() => {
    const m = QRCode.create(value, { errorCorrectionLevel: 'M' }).modules;
    const out: boolean[][] = [];
    for (let y = 0; y < m.size; y++) {
      const row: boolean[] = [];
      for (let x = 0; x < m.size; x++) row.push(!!m.get(x, y));
      out.push(row);
    }
    return out;
  }, [value]);
  const quiet = 4;
  const n = rows.length + quiet * 2;
  const cell = Math.floor(size / n);
  const pad = quiet * cell;
  return (
    <View style={{ backgroundColor: '#fff', padding: pad, borderRadius: 12 }}>
      {rows.map((row, y) => (
        <View key={y} style={{ flexDirection: 'row' }}>
          {row.map((on, x) => (
            <View key={x} style={{ width: cell, height: cell, backgroundColor: on ? c.ink : '#fff' }} />
          ))}
        </View>
      ))}
    </View>
  );
}
