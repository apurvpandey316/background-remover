// Turns the model's raw alpha mask into a clean cutout: optional upscaling,
// lifting faint foreground to full opacity, hole filling, speck removal,
// edge shrinking (to drop background halos) and feathering.
import sharp from "sharp";

export const DEFAULTS = {
  scale: 1,        // 1, 2 or 4
  rescue: 95,      // 0-100: how aggressively faint mask areas become solid
  fillHoles: true,
  close: 2,        // gap-bridging radius, in source pixels
  minSpeck: 0.1,   // drop blobs smaller than this % of the image
  shrink: 1.5,     // erode the edge by this many source pixels
  feather: 0.4,    // edge blur sigma, in source pixels
  sharpen: true,   // sharpen colours when upscaling
};

export const MAX_SIDE = 6000;

export function clampScale(scale, width, height) {
  let s = [1, 2, 4].includes(scale) ? scale : 1;
  while (s > 1 && Math.max(width, height) * s > MAX_SIDE) s /= 2;
  return s;
}

// Separable square-window min/max filter on a 0/1 mask: O(N * r).
function morph(inp, W, H, r, dilate) {
  if (r <= 0) return inp;
  const pass = (src, horizontal) => {
    const out = new Uint8Array(src.length);
    const [outer, inner] = horizontal ? [H, W] : [W, H];
    for (let o = 0; o < outer; o++) {
      const idx = (i) => (horizontal ? o * W + i : i * W + o);
      // Running count of set pixels in the window [i - r, i + r].
      let count = 0;
      for (let i = 0; i <= Math.min(r, inner - 1); i++) count += src[idx(i)];
      for (let i = 0; i < inner; i++) {
        const lo = Math.max(0, i - r), hi = Math.min(inner - 1, i + r);
        out[idx(i)] = dilate ? (count > 0 ? 1 : 0) : (count === hi - lo + 1 ? 1 : 0);
        if (i + r + 1 < inner) count += src[idx(i + r + 1)];
        if (i - r >= 0) count -= src[idx(i - r)];
      }
    }
    return out;
  };
  return pass(pass(inp, true), false);
}

// Border pixels that may seed the "outside" flood fill. On each edge, short gaps
// between foreground runs are skipped: they're usually a subject cropped by the
// frame (e.g. a torso along the bottom), not background.
function borderSeeds(fg, W, H) {
  const edges = [
    Array.from({ length: W }, (_, x) => x),
    Array.from({ length: W }, (_, x) => (H - 1) * W + x),
    Array.from({ length: H }, (_, y) => y * W),
    Array.from({ length: H }, (_, y) => y * W + W - 1),
  ];
  const seeds = [];
  for (const edge of edges) {
    const maxGap = edge.length * 0.25;
    const fgIdx = edge.map((p, i) => (fg[p] ? i : -1)).filter((i) => i >= 0);
    const blocked = new Uint8Array(edge.length);
    for (let k = 1; k < fgIdx.length; k++) {
      const a = fgIdx[k - 1], b = fgIdx[k];
      if (b - a > 1 && b - a - 1 < maxGap) blocked.fill(1, a + 1, b);
    }
    edge.forEach((p, i) => { if (!fg[p] && !blocked[i]) seeds.push(p); });
  }
  return seeds;
}

/**
 * @param {Buffer} original  encoded source image
 * @param {Uint8Array} mask  raw alpha from the model, srcW x srcH
 */
export async function renderCutout(original, mask, srcW, srcH, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const S = clampScale(Number(o.scale), srcW, srcH);
  const W = srcW * S, H = srcH * S, N = W * H;

  let colour = sharp(original).rotate().ensureAlpha();
  if (S > 1) {
    colour = colour.resize(W, H, { kernel: "lanczos3" });
    if (o.sharpen) colour = colour.sharpen({ sigma: 0.6 * S / 2 + 0.6 });
  }
  const src = await colour.raw().toBuffer();

  const m = S > 1
    ? await sharp(Buffer.from(mask), { raw: { width: srcW, height: srcH, channels: 1 } })
        .resize(W, H, { kernel: "lanczos3" }).extractChannel(0).raw().toBuffer()
    : mask;

  // rescue 0 -> standard 64..192 ramp; rescue 100 -> anything above 1 counts.
  const r = Math.min(100, Math.max(0, Number(o.rescue))) / 100;
  const LO = Math.pow(64, 1 - r), HI = 4 * Math.pow(48, 1 - r);
  const alpha = new Uint8Array(N);
  for (let p = 0; p < N; p++) {
    const t = (m[p] - LO) / (HI - LO);
    alpha[p] = Math.round(255 * Math.min(1, Math.max(0, t)));
  }

  let fg = Uint8Array.from(alpha, (a) => (a > 0 ? 1 : 0));
  const R = Math.round(Number(o.close) * S);
  const closed = morph(morph(fg, W, H, R, true), W, H, R, false);

  // Flood-fill background from the border; anything unreached is an enclosed hole.
  const outside = new Uint8Array(N);
  if (o.fillHoles) {
    const stack = borderSeeds(closed, W, H);
    while (stack.length) {
      const p = stack.pop();
      if (outside[p] || closed[p]) continue;
      outside[p] = 1;
      const x = p % W;
      if (x > 0) stack.push(p - 1);
      if (x < W - 1) stack.push(p + 1);
      if (p >= W) stack.push(p - W);
      if (p < N - W) stack.push(p + W);
    }
  } else {
    for (let p = 0; p < N; p++) outside[p] = closed[p] ? 0 : 1;
  }

  const solid = new Uint8Array(N);
  for (let p = 0; p < N; p++) solid[p] = outside[p] ? alpha[p] : 255;

  // Drop small foreground specks.
  const minArea = (Number(o.minSpeck) / 100) * N;
  if (minArea > 0) {
    const seen = new Uint8Array(N);
    for (let s = 0; s < N; s++) {
      if (seen[s] || !solid[s]) continue;
      const comp = [], q = [s];
      seen[s] = 1;
      while (q.length) {
        const p = q.pop();
        comp.push(p);
        const x = p % W;
        for (const n of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W]) {
          if (n < 0 || n >= N || seen[n] || !solid[n]) continue;
          seen[n] = 1;
          q.push(n);
        }
      }
      if (comp.length < minArea) for (const p of comp) solid[p] = 0;
    }
  }

  // Shrink the edge to cut off background the mask overshoots by.
  const E = Math.round(Number(o.shrink) * S);
  let final = solid;
  if (E > 0) {
    const bin = Uint8Array.from(solid, (a) => (a >= 128 ? 1 : 0));
    final = Uint8Array.from(morph(bin, W, H, E, false), (b) => (b ? 255 : 0));
  }

  const F = Number(o.feather) * S;
  if (F >= 0.3) {
    final = await sharp(Buffer.from(final), { raw: { width: W, height: H, channels: 1 } })
      .blur(F).extractChannel(0).raw().toBuffer();
  }

  for (let p = 0; p < N; p++) src[p * 4 + 3] = final[p];
  const png = await sharp(src, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  return { png, width: W, height: H, scale: S };
}
