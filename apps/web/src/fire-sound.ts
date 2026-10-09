/** Loopable combustion sound: soft body plus irregular short crackles. */
export function fireSoundSamples(sampleRate: number, seconds: number, jet = false): Float32Array {
  const samples = new Float32Array(Math.ceil(sampleRate * seconds));
  let seed = jet ? 0x17ef : 0xc4ac, low = 0, pop = 0, remaining = 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < samples.length; i++) {
    const noise = random() * 2 - 1;
    low = low * .985 + noise * .015;
    if (!remaining && random() < (jet ? 8 : 32) / sampleRate) {
      remaining = Math.round(sampleRate * (.003 + random() * .035)); pop = .3 + random() * .6;
    }
    let crackle = 0;
    if (remaining > 0) { crackle = noise * pop; pop *= .992; remaining--; }
    const t = i / sampleRate;
    const body = jet ? noise * .24 + low * 1.8 + Math.sin(t * Math.PI * 2 * 72) * .06 : noise * .018 + low * .3;
    // Fade the loop seam only, keeping the individual crackle transients sharp.
    const seam = Math.min(1, i / (sampleRate * .015), (samples.length - 1 - i) / (sampleRate * .015));
    samples[i] = Math.max(-1, Math.min(1, body + crackle * (jet ? .25 : 1))) * seam;
  }
  return samples;
}
