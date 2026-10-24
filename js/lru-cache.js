// Small LRU on top of Map.
//
// The preset cache used to be a plain Map, so every PCL2 preset the user opened
// stayed resident for the tab's lifetime (each source is up to 4 MiB). Evicting
// the least recently used entry keeps the "switch back and forth is instant"
// behaviour for the handful of presets people actually compare while bounding
// the memory to `limit` entries.
export class LruCache extends Map {
  constructor(limit = 10) {
    super();
    this.limit = Math.max(1, Math.trunc(limit) || 1);
  }

  has(key) {
    return super.has(key);
  }

  get(key) {
    if (!super.has(key)) return undefined;
    const value = super.get(key);
    // Re-insert so the key moves to the tail (most recently used).
    super.delete(key);
    super.set(key, value);
    return value;
  }

  set(key, value) {
    super.delete(key);
    super.set(key, value);
    while (this.size > this.limit) {
      const oldest = this.keys().next();
      if (oldest.done) break;
      super.delete(oldest.value);
    }
    return this;
  }
}
