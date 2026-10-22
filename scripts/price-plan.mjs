#!/usr/bin/env node
// Prints the list of Yahoo chart requests the updater needs, for scripts/fetch_prices.py.
import { INSTRUMENTS, MACRO } from './config.mjs';

// [range, interval, minutes a cached copy stays good before it is fetched again]
// (5-minute bars are reused for 3 minutes, so back-to-back runs don't re-ask Yahoo)
const SERIES = [['1y', '1d', 60], ['3mo', '60m', 30], ['5d', '5m', 3]];

console.log(JSON.stringify({
  instruments: INSTRUMENTS.map((i) => ({ id: i.id, symbols: i.yahoo, stooq: i.stooq || null, series: SERIES })),
  macro: MACRO.map((m) => ({ id: m.id, symbols: [m.yahoo], series: [['1mo', '1d', 30]] })),
}, null, 1));
