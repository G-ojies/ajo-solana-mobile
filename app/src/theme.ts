// Palette carried over from Ajo on Lightning (adire indigo, marigold, cream paper).
export const c = {
  bg: '#f7f1e3',
  card: '#fffaf0',
  field: '#fdf8ec',
  ink: '#171c3a',
  muted: '#565a73',
  line: '#e2d7bd',
  primary: '#1f2f6e',
  onPrimary: '#ffffff',
  indigo: '#1a2763',
  indigoDeep: '#121b49',
  marigold: '#f4ab1f',
  onMarigold: '#2a1b00',
  green: '#0f6b45',
  greenSoft: '#dcefe3',
  gold: '#7c5200',
  goldSoft: '#fbeccb',
  red: '#b4372b',
  redSoft: '#fbe3df',
};

export const mono = 'monospace';

/** Shown as an approximate naira value next to USDC amounts. Update before demoing. */
export const NGN_PER_USDC = 1500;

export function naira(usdc: number): string {
  const n = usdc * NGN_PER_USDC;
  if (n >= 1_000_000) return `≈ ₦${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
  if (n >= 1_000) return `≈ ₦${Math.round(n / 1_000)}k`;
  return `≈ ₦${Math.round(n)}`;
}

export function short(a: string): string {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}
