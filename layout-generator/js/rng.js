/* Seeded randomness. Every variation is reproducible from (seed, intent, brand). */
const RNG = (() => {
  function make(seed) {
    let a = seed >>> 0;
    const next = () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
      next,
      int(min, max) { return min + Math.floor(next() * (max - min + 1)); },
      pick(arr) { return arr[Math.floor(next() * arr.length)]; },
      chance(p) { return next() < p; },
      // items: [{v, w}] -> v
      weighted(items) {
        const total = items.reduce((s, i) => s + (i.w || 0), 0);
        let r = next() * total;
        for (const it of items) { r -= (it.w || 0); if (r <= 0) return it.v; }
        return items[items.length - 1].v;
      },
      shuffle(arr) {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
        return a;
      },
    };
  }
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  return { make, hashStr };
})();
