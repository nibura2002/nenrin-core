// Seeded RNG (mulberry32) so simulated works are reproducible per profile.
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    f: next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    hex: (n) => {
      let s = '';
      for (let i = 0; i < n; i++) s += '0123456789abcdef'[Math.floor(next() * 16)];
      return s;
    },
  };
}
