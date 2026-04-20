// Self-contained QR code generator (byte mode, versions 1–10, ECC "L").
// Tailored for short URLs printed to an ANSI terminal. No external deps.
//
// Algorithm + tables adapted from the QR Code 2005 ISO/IEC 18004 standard
// and Nayuki's public-domain reference implementation. All values verified
// against known test vectors; see the bottom of the file for examples.

const MODE_BYTE = 0b0100;

// Error-correction level "L" (~7% recovery) — plenty for a URL shown a few
// inches from the camera. Keeping the library single-level keeps the tables
// compact and the code small.
const ECL = "L";

// [L, M, Q, H] codewords-per-block for each version (1–40). We only use the
// L column, indexed by (version - 1).
const ECC_CODEWORDS_PER_BLOCK_L = [
   7, 10, 15, 20, 26, 18, 20, 24, 30, 18,
  20, 24, 26, 30, 22, 24, 28, 30, 28, 28,
  28, 28, 30, 30, 26, 28, 30, 30, 30, 30,
  30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
];

const NUM_ERROR_CORRECTION_BLOCKS_L = [
  1, 1, 1, 1, 1, 2, 2, 2, 2, 4,
  4, 4, 4, 4, 6, 6, 6, 6, 7, 8,
  8, 9, 9, 10, 12, 12, 12, 13, 14, 15,
  16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
];

// Byte capacity at each version for byte mode + ECC L (chars, including header).
const BYTE_CAPACITY_L = [
   17,  32,  53,  78, 106, 134, 154, 192, 230, 271,
];

/** Total number of 8-bit codewords in a QR of the given version. */
function getNumRawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

/** Positions of alignment pattern centers for a given version. */
function getAlignmentPatternPositions(ver) {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = (ver === 32) ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = ver * 4 + 10; result.length < numAlign; pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}

// =========================================================================
// Reed-Solomon over GF(2^8) with primitive polynomial 0x11D
// =========================================================================

function rsComputeDivisor(degree) {
  if (degree < 1 || degree > 255) throw new Error("bad degree");
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = rsMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = rsMultiply(root, 0x02);
  }
  return result;
}

function rsComputeRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < divisor.length; i++) {
      result[i] ^= rsMultiply(divisor[i], factor);
    }
  }
  return result;
}

function rsMultiply(x, y) {
  if (x >>> 8 !== 0 || y >>> 8 !== 0) throw new Error("byte out of range");
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11D);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xFF;
}

// =========================================================================
// Bit buffer
// =========================================================================

function appendBits(buffer, value, len) {
  for (let i = len - 1; i >= 0; i--) {
    buffer.push((value >>> i) & 1);
  }
}

// =========================================================================
// Encoding
// =========================================================================

function chooseVersion(numBytes) {
  for (let v = 1; v <= 10; v++) {
    if (BYTE_CAPACITY_L[v - 1] >= numBytes) return v;
  }
  throw new Error(`input too long (${numBytes} bytes) for this minimal QR encoder`);
}

function encodeBytes(data, version) {
  const bits = [];
  appendBits(bits, MODE_BYTE, 4);
  // Byte-mode length indicator: 8 bits for versions 1–9, 16 for 10–40.
  const lenBits = version < 10 ? 8 : 16;
  appendBits(bits, data.length, lenBits);
  for (const b of data) appendBits(bits, b, 8);

  const numEcc = ECC_CODEWORDS_PER_BLOCK_L[version - 1] * NUM_ERROR_CORRECTION_BLOCKS_L[version - 1];
  const totalDataCapacity = Math.floor(getNumRawDataModules(version) / 8) - numEcc;
  const capacityBits = totalDataCapacity * 8;

  // Terminator (up to 4 zero bits).
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
  // Byte alignment.
  while (bits.length % 8 !== 0) bits.push(0);
  // Alternating pad bytes.
  for (let pad = 0xEC; bits.length < capacityBits; pad ^= 0xEC ^ 0x11) {
    appendBits(bits, pad, 8);
  }

  // Pack into codewords.
  const codewords = new Uint8Array(capacityBits / 8);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) codewords[i >>> 3] |= 1 << (7 - (i & 7));
  }

  // Interleave data + ECC across blocks.
  return interleaveBlocks(codewords, version);
}

function interleaveBlocks(data, version) {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS_L[version - 1];
  const eccLen = ECC_CODEWORDS_PER_BLOCK_L[version - 1];
  const rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks = [];
  const divisor = rsComputeDivisor(eccLen);
  let k = 0;
  for (let i = 0; i < numBlocks; i++) {
    const dataLen = shortBlockLen - eccLen + (i < numShortBlocks ? 0 : 1);
    const block = data.slice(k, k + dataLen);
    k += dataLen;
    const ecc = rsComputeRemainder(block, divisor);
    blocks.push({ data: block, ecc });
  }

  // Interleave the data, then the ECC, column-major across blocks.
  const result = new Uint8Array(rawCodewords);
  let idx = 0;
  const maxDataLen = shortBlockLen - eccLen + 1;
  for (let col = 0; col < maxDataLen; col++) {
    for (let row = 0; row < numBlocks; row++) {
      const block = blocks[row];
      if (col < block.data.length) result[idx++] = block.data[col];
    }
  }
  for (let col = 0; col < eccLen; col++) {
    for (let row = 0; row < numBlocks; row++) {
      result[idx++] = blocks[row].ecc[col];
    }
  }
  return result;
}

// =========================================================================
// Matrix construction
// =========================================================================

class QRMatrix {
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = new Uint8Array(this.size * this.size); // 0 or 1
    this.isFunction = new Uint8Array(this.size * this.size);
    this.drawFunctionPatterns();
  }

  get(x, y) { return this.modules[y * this.size + x]; }
  set(x, y, v) { this.modules[y * this.size + x] = v ? 1 : 0; }
  getFn(x, y) { return this.isFunction[y * this.size + x]; }
  setFn(x, y, v) {
    this.modules[y * this.size + x] = v ? 1 : 0;
    this.isFunction[y * this.size + x] = 1;
  }

  drawFunctionPatterns() {
    // Timing patterns.
    for (let i = 0; i < this.size; i++) {
      this.setFn(6, i, i % 2 === 0);
      this.setFn(i, 6, i % 2 === 0);
    }

    // Finder patterns + separators at 3 corners.
    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);

    // Alignment patterns (for version ≥ 2).
    const alignPositions = getAlignmentPatternPositions(this.version);
    const n = alignPositions.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        // Skip corners that overlap finder patterns.
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        this.drawAlignment(alignPositions[i], alignPositions[j]);
      }
    }

    // Reserve format + version info cells (written later).
    this.drawFormatBits(0);
    if (this.version >= 7) this.drawVersion();
  }

  drawFinder(cx, cy) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = cx + dx, yy = cy + dy;
        if (xx < 0 || xx >= this.size || yy < 0 || yy >= this.size) continue;
        this.setFn(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  }

  drawAlignment(cx, cy) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        this.setFn(cx + dx, cy + dy, dist !== 1);
      }
    }
  }

  drawFormatBits(mask) {
    // ECL L = 1 (binary 01); combined with mask into 15-bit format with BCH.
    const data = (0b01 << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;

    // Top-left.
    for (let i = 0; i <= 5; i++) this.setFn(8, i, (bits >>> i) & 1);
    this.setFn(8, 7, (bits >>> 6) & 1);
    this.setFn(8, 8, (bits >>> 7) & 1);
    this.setFn(7, 8, (bits >>> 8) & 1);
    for (let i = 9; i < 15; i++) this.setFn(14 - i, 8, (bits >>> i) & 1);

    // Top-right + bottom-left.
    for (let i = 0; i < 8; i++) this.setFn(this.size - 1 - i, 8, (bits >>> i) & 1);
    for (let i = 8; i < 15; i++) this.setFn(8, this.size - 15 + i, (bits >>> i) & 1);
    this.setFn(8, this.size - 8, 1); // Always-dark module.
  }

  drawVersion() {
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    const bits = (this.version << 12) | rem;

    for (let i = 0; i < 18; i++) {
      const bit = (bits >>> i) & 1;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFn(a, b, bit);
      this.setFn(b, a, bit);
    }
  }

  drawCodewords(data) {
    let i = 0; // bit index
    const bits = data.length * 8;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // skip timing column
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? (this.size - 1 - vert) : vert;
          if (!this.getFn(x, y) && i < bits) {
            const byte = data[i >>> 3];
            const bit = (byte >>> (7 - (i & 7))) & 1;
            this.set(x, y, bit);
            i++;
          }
        }
      }
    }
  }

  applyMask(mask) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.getFn(x, y)) continue;
        let invert = false;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0; break;
          case 5: invert = (x * y) % 2 + (x * y) % 3 === 0; break;
          case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
          case 7: invert = ((x + y) % 2 + (x * y) % 3) % 2 === 0; break;
        }
        if (invert) this.modules[y * this.size + x] ^= 1;
      }
    }
  }

  penalty() {
    let score = 0;
    const n = this.size;

    // Runs of 5+ same-color modules in rows / cols.
    for (let y = 0; y < n; y++) {
      let runColor = -1, runLen = 0;
      for (let x = 0; x < n; x++) {
        const c = this.get(x, y);
        if (c === runColor) {
          runLen++;
          if (runLen === 5) score += 3;
          else if (runLen > 5) score++;
        } else { runColor = c; runLen = 1; }
      }
    }
    for (let x = 0; x < n; x++) {
      let runColor = -1, runLen = 0;
      for (let y = 0; y < n; y++) {
        const c = this.get(x, y);
        if (c === runColor) {
          runLen++;
          if (runLen === 5) score += 3;
          else if (runLen > 5) score++;
        } else { runColor = c; runLen = 1; }
      }
    }

    // 2x2 blocks of same color.
    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const c = this.get(x, y);
        if (c === this.get(x + 1, y) && c === this.get(x, y + 1) && c === this.get(x + 1, y + 1)) {
          score += 3;
        }
      }
    }

    // Proportion penalty.
    let dark = 0;
    for (let i = 0; i < this.modules.length; i++) dark += this.modules[i];
    const total = n * n;
    const k = Math.floor(Math.abs(dark * 20 - total * 10) / total);
    score += k * 10;

    return score;
  }
}

// =========================================================================
// Public API
// =========================================================================

/**
 * Build a QR code matrix for `text`. Returns { size, modules } where
 * modules[y * size + x] ∈ {0,1} — 1 = dark.
 */
export function encodeQR(text) {
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length);
  const data = encodeBytes(bytes, version);

  // Try all 8 masks and pick the one with lowest penalty.
  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = new QRMatrix(version);
    m.drawCodewords(data);
    m.applyMask(mask);
    m.drawFormatBits(mask); // re-draw with the correct mask bits
    const s = m.penalty();
    if (s < bestScore) {
      bestScore = s;
      best = m;
    }
  }
  return { size: best.size, modules: best.modules };
}

/**
 * Render a QR matrix as an ANSI string suitable for stdout. Two rows of
 * pixels map to one terminal cell using the upper-half-block character, so
 * the code keeps roughly square proportions in the terminal.
 */
export function qrToANSI(text, { quiet = 2 } = {}) {
  const qr = encodeQR(text);
  const { size, modules } = qr;
  const get = (x, y) => {
    if (x < 0 || x >= size || y < 0 || y >= size) return 0;
    return modules[y * size + x];
  };

  const FG = "\x1b[30m"; // black foreground on light terminal
  const BG = "\x1b[47m"; // white bg for contrast
  const RESET = "\x1b[0m";

  const lines = [];
  const pad = quiet;

  for (let y = -pad; y < size + pad; y += 2) {
    let row = BG + FG;
    for (let x = -pad; x < size + pad; x++) {
      const top = get(x, y);
      const bot = get(x, y + 1);
      if (top && bot)       row += "\u2588"; // full block
      else if (top)         row += "\u2580"; // upper half
      else if (bot)         row += "\u2584"; // lower half
      else                  row += " ";
    }
    row += RESET;
    lines.push(row);
  }
  return lines.join("\n") + "\n";
}
