import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";

const outDir = resolve("public/icons");
mkdirSync(outDir, { recursive: true });

const sizes = [16, 32, 48, 128];

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function createPng(width, height, pixelFn) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type 0
    for (let x = 0; x < width; x += 1) {
      const idx = y * (stride + 1) + 1 + x * 4;
      const [r, g, b, a] = pixelFn(x, y);
      raw[idx] = r;
      raw[idx + 1] = g;
      raw[idx + 2] = b;
      raw[idx + 3] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // color type RGBA
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // interlace

  const idat = deflateSync(raw);

  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const out = Buffer.concat([
    pngSig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0))
  ]);

  return out;
}

const palette = {
  bgTop: [235, 224, 248, 255],
  bgBottom: [222, 206, 242, 255],
  outerRing: [126, 85, 177, 255],
  cardStroke: [149, 112, 197, 255],
  barPrimary: [132, 40, 210, 245],
  barSecondary: [176, 108, 236, 245],
  pill: [164, 53, 240, 220]
};

function mix(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function inRoundedRect(x, y, left, top, width, height, radius) {
  const right = left + width;
  const bottom = top + height;
  if (x < left || x >= right || y < top || y >= bottom) {
    return false;
  }

  const innerLeft = left + radius;
  const innerRight = right - radius;
  const innerTop = top + radius;
  const innerBottom = bottom - radius;

  if (x >= innerLeft && x < innerRight) {
    return true;
  }
  if (y >= innerTop && y < innerBottom) {
    return true;
  }

  const cx = x < innerLeft ? innerLeft : innerRight - 1;
  const cy = y < innerTop ? innerTop : innerBottom - 1;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function buildIcon(size) {
  const isSmall = size <= 32;
  const pad = Math.max(1, Math.round(size * 0.08));
  const cardSize = size - pad * 2;
  const cardRadius = Math.max(2, Math.round(cardSize * (isSmall ? 0.2 : 0.24)));

  const barHeight = Math.max(2, Math.round(size * (isSmall ? 0.16 : 0.11)));
  const barRadius = Math.max(1, Math.round(barHeight / 2));
  const bar1Width = Math.round(size * (isSmall ? 0.46 : 0.5));
  const bar2Width = Math.round(size * (isSmall ? 0.58 : 0.62));
  const bar1Y = Math.round(size * (isSmall ? 0.33 : 0.36));
  const bar2Y = Math.round(size * (isSmall ? 0.56 : 0.53));
  const barOffsetX = Math.round(size * (isSmall ? 0.06 : 0.08));
  const bar1X = Math.round((size - bar1Width) / 2) + barOffsetX;
  const bar2X = Math.round((size - bar2Width) / 2) + barOffsetX;

  const pillSize = Math.max(2, Math.round(size * (isSmall ? 0.14 : 0.12)));
  const pillRadius = Math.max(1, Math.round(pillSize / 2));
  const pillX = Math.round(size * (isSmall ? 0.17 : 0.2));
  const pill1Y = bar1Y;
  const pill2Y = bar2Y;

  const innerInset = 1;
  const innerRectRadius = Math.max(1, cardRadius - 1);
  const innerCardSize = Math.max(1, cardSize - innerInset * 2);

  return createPng(size, size, (x, y) => {
    if (!inRoundedRect(x, y, pad, pad, cardSize, cardSize, cardRadius)) {
      return [0, 0, 0, 0];
    }

    const inOuterRingInner = inRoundedRect(
      x,
      y,
      pad + 1,
      pad + 1,
      Math.max(1, cardSize - 2),
      Math.max(1, cardSize - 2),
      Math.max(1, cardRadius - 1)
    );
    if (!inOuterRingInner) {
      return palette.outerRing;
    }

    const t = y / Math.max(1, size - 1);
    const bg = [
      mix(palette.bgTop[0], palette.bgBottom[0], t),
      mix(palette.bgTop[1], palette.bgBottom[1], t),
      mix(palette.bgTop[2], palette.bgBottom[2], t),
      255
    ];

    const inInnerCard = inRoundedRect(
      x,
      y,
      pad + innerInset,
      pad + innerInset,
      innerCardSize,
      innerCardSize,
      innerRectRadius
    );
    if (!inInnerCard) {
      return palette.cardStroke;
    }

    if (inRoundedRect(x, y, bar1X, bar1Y, bar1Width, barHeight, barRadius)) {
      return palette.barPrimary;
    }

    if (inRoundedRect(x, y, bar2X, bar2Y, bar2Width, barHeight, barRadius)) {
      return palette.barSecondary;
    }

    if (inRoundedRect(x, y, pillX, pill1Y, pillSize, pillSize, pillRadius)) {
      return palette.pill;
    }

    if (
      !isSmall &&
      inRoundedRect(x, y, pillX, pill2Y, pillSize, pillSize, pillRadius)
    ) {
      return [188, 132, 241, 230];
    }

    return bg;
  });
}

for (const size of sizes) {
  const buffer = buildIcon(size);
  const filePath = resolve(outDir, `icon-${size}.png`);
  writeFileSync(filePath, buffer);
}

console.log("Icons generated:", sizes.map((s) => `icon-${s}.png`).join(", "));
