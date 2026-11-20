import React, { useEffect, useState } from 'react';
import { BackHandler, LogBox, Linking, StatusBar, View } from 'react-native';

// The public devnet RPC rate-limits now and then; web3.js retries by itself, so don't pop the dev overlay.
LogBox.ignoreLogs(['Server responded with 429']);
import { MobileWalletProvider } from '@wallet-ui/react-native-web3js';
import { DEVNET_RPC } from './src/ajo';
import { CircleScreen, Create, Home, Join, Nav, Route, Settings } from './src/screens';
import { c } from './src/theme';

/**
 * fetch for the Solana connection that aborts after 20 s. Without it, a request caught in a network
 * blip can hang forever and hold one of the few connections to the RPC host, so later calls queue.
 */
const fetchWithTimeout: typeof fetch = (input, init) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20000);
  return fetch(input, { ...init, signal: ac.signal }).finally(() => clearTimeout(t));
};

const identity = { name: 'Ajo', uri: 'https://g-ojies.github.io/ajo-solana-mobile/', icon: 'icon-192.png' };

/** ajo://join/<circle address> or ajo://circle/<address> opens that circle. */
function routeFromUrl(url: string | null | undefined): Route | null {
  const m =
    url?.match(/^ajo:\/\/(?:join|circle)\/([1-9A-HJ-NP-Za-km-z]{32,44})/) ??
    url?.match(/^https:\/\/g-ojies\.github\.io\/ajo-solana-mobile\/join\/?\?c=([1-9A-HJ-NP-Za-km-z]{32,44})/);
  return m ? { name: 'circle', address: m[1] } : null;
}

export default function App() {
  const [stack, setStack] = useState<Route[]>([{ name: 'home' }]);
  const nav: Nav = {
    go: (r) => setStack((s) => (r.name === 'home' ? [r] : [...s, r])),
    replace: (r) => setStack((s) => [...s.slice(0, -1), r]),
    back: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
  };

  useEffect(() => {
    Linking.getInitialURL().then((u) => {
      const r = routeFromUrl(u);
      if (r) setStack([{ name: 'home' }, r]);
    });
    const sub = Linking.addEventListener('url', ({ url }) => {
      const r = routeFromUrl(url);
      if (r) setStack([{ name: 'home' }, r]);
    });
    const hw = BackHandler.addEventListener('hardwareBackPress', () => {
      let handled = false;
      setStack((s) => {
        if (s.length > 1) {
          handled = true;
          return s.slice(0, -1);
        }
        return s;
      });
      return handled;
    });
    return () => {
      sub.remove();
      hw.remove();
    };
  }, []);

  const route = stack[stack.length - 1];
  return (
    <MobileWalletProvider chain="solana:devnet" endpoint={DEVNET_RPC} identity={identity} commitmentOrConfig={{ commitment: 'confirmed', fetch: fetchWithTimeout }}>
      <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: StatusBar.currentHeight ?? 24 }}>
        <StatusBar barStyle="dark-content" />
        {route.name === 'home' && <Home nav={nav} />}
        {route.name === 'create' && <Create nav={nav} />}
        {route.name === 'join' && <Join nav={nav} code={route.code} />}
        {route.name === 'circle' && <CircleScreen key={route.address} nav={nav} address={route.address} />}
        {route.name === 'settings' && <Settings nav={nav} />}
      </View>
    </MobileWalletProvider>
  );
}
