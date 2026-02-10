#!/usr/bin/env node

/**
 * Media Fixture Generator for Upload & Asset Editing Tests
 *
 * Generates small, deterministic binary test files covering every major
 * asset type the app supports (images, video, audio, documents).
 *
 * Phase 1 -- Pure Node.js (no external deps):
 *   PNG, GIF, BMP, SVG, WAV, PDF, TXT
 *
 * Phase 2 -- Requires FFmpeg (graceful skip if absent):
 *   MP4, MP3, WebP
 *
 * Usage:
 *   node test/fixtures/media/generate-media-fixtures.js          # skip existing
 *   node test/fixtures/media/generate-media-fixtures.js --force   # regenerate all
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');

// ── helpers ──────────────────────────────────────────────────────────────────

const BASE = path.resolve(__dirname);
const force = process.argv.includes('--force');

function writeFixture(filePath, content) {
  const rel = path.relative(process.cwd(), filePath);
  if (!force && fs.existsSync(filePath)) {
    console.log(`  SKIP (exists): ${rel}`);
    return false;
  }
  if (typeof content === 'string') {
    fs.writeFileSync(filePath, content, 'utf-8');
  } else {
    fs.writeFileSync(filePath, content);
  }
  console.log(`  WROTE: ${rel}`);
  return true;
}

function hasFfmpeg() {
  try {
    execSync('ffmpeg -version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function runFfmpeg(args, outputFile) {
  const rel = path.relative(process.cwd(), outputFile);
  if (!force && fs.existsSync(outputFile)) {
    console.log(`  SKIP (exists): ${rel}`);
    return false;
  }
  try {
    execSync(`ffmpeg -y ${args}`, { stdio: 'pipe' });
    console.log(`  WROTE: ${rel}`);
    return true;
  } catch (err) {
    console.log(`  FAIL (ffmpeg): ${rel} -- ${err.message.split('\n')[0]}`);
    return false;
  }
}

// ── CRC32 for PNG ────────────────────────────────────────────────────────────

function crc32(buf) {
  let table = crc32._table;
  if (!table) {
    table = crc32._table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([typeBytes, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// ── Phase 1 generators (pure Node.js) ────────────────────────────────────────

function generatePNG() {
  // 16x16 RGBA PNG with a red/blue gradient pattern
  const width = 16;
  const height = 16;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // IDAT -- raw pixel rows with filter byte
  const rawRows = [];
  for (let y = 0; y < height; y++) {
    const row = [0]; // filter: none
    for (let x = 0; x < width; x++) {
      const r = Math.round((x / (width - 1)) * 255);
      const g = Math.round(((x + y) / (width + height - 2)) * 128);
      const b = Math.round((y / (height - 1)) * 255);
      row.push(r, g, b);
    }
    rawRows.push(Buffer.from(row));
  }
  const rawData = Buffer.concat(rawRows);
  const compressed = zlib.deflateSync(rawData);

  // IEND
  const iend = Buffer.alloc(0);

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', iend),
  ]);
}

function generateGIF() {
  // 8x8 static GIF89a with a 4-color palette
  const width = 8;
  const height = 8;
  const parts = [];

  // Header
  parts.push(Buffer.from('GIF89a'));

  // Logical Screen Descriptor
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0);
  lsd.writeUInt16LE(height, 2);
  lsd[4] = 0x91; // GCT flag, 2 bits color resolution, sorted=0, GCT size=2 (4 colors)
  lsd[5] = 0;    // bg color index
  lsd[6] = 0;    // pixel aspect ratio
  parts.push(lsd);

  // Global Color Table (4 colors: red, green, blue, white)
  parts.push(Buffer.from([
    255, 0, 0,     // 0: red
    0, 255, 0,     // 1: green
    0, 0, 255,     // 2: blue
    255, 255, 255, // 3: white
  ]));

  // Image Descriptor
  const imgDesc = Buffer.alloc(10);
  imgDesc[0] = 0x2C; // image separator
  imgDesc.writeUInt16LE(0, 1); // left
  imgDesc.writeUInt16LE(0, 3); // top
  imgDesc.writeUInt16LE(width, 5);
  imgDesc.writeUInt16LE(height, 7);
  imgDesc[9] = 0; // no local color table
  parts.push(imgDesc);

  // Image Data (LZW minimum code size = 2)
  const lzwMin = 2;
  // Build pixel indices: checkerboard of 4 colors
  const pixels = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels.push(((x >> 2) + (y >> 2)) % 4);
    }
  }

  // Simple LZW encoding
  const lzwData = lzwEncode(pixels, lzwMin);
  parts.push(Buffer.from([lzwMin]));

  // Sub-blocks
  let offset = 0;
  while (offset < lzwData.length) {
    const chunk = lzwData.slice(offset, offset + 255);
    parts.push(Buffer.from([chunk.length]));
    parts.push(chunk);
    offset += 255;
  }
  parts.push(Buffer.from([0])); // block terminator

  // Trailer
  parts.push(Buffer.from([0x3B]));

  return Buffer.concat(parts);
}

function lzwEncode(pixels, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  const maxCode = 4096;

  // Init dictionary
  let dict = new Map();
  for (let i = 0; i < clearCode; i++) {
    dict.set(String(i), i);
  }

  const output = [];
  let bitBuffer = 0;
  let bitsInBuffer = 0;

  function writeBits(code, size) {
    bitBuffer |= (code << bitsInBuffer);
    bitsInBuffer += size;
    while (bitsInBuffer >= 8) {
      output.push(bitBuffer & 0xFF);
      bitBuffer >>= 8;
      bitsInBuffer -= 8;
    }
  }

  writeBits(clearCode, codeSize);

  let current = String(pixels[0]);
  for (let i = 1; i < pixels.length; i++) {
    const next = current + ',' + pixels[i];
    if (dict.has(next)) {
      current = next;
    } else {
      writeBits(dict.get(current), codeSize);
      if (nextCode < maxCode) {
        dict.set(next, nextCode++);
        if (nextCode > (1 << codeSize) && codeSize < 12) {
          codeSize++;
        }
      } else {
        // Reset dictionary
        writeBits(clearCode, codeSize);
        dict = new Map();
        for (let j = 0; j < clearCode; j++) {
          dict.set(String(j), j);
        }
        nextCode = eoiCode + 1;
        codeSize = minCodeSize + 1;
      }
      current = String(pixels[i]);
    }
  }
  writeBits(dict.get(current), codeSize);
  writeBits(eoiCode, codeSize);

  // Flush remaining bits
  if (bitsInBuffer > 0) {
    output.push(bitBuffer & 0xFF);
  }

  return Buffer.from(output);
}

function generateBMP() {
  // 4x4 24-bit BMP with a color gradient
  const width = 4;
  const height = 4;
  const rowSize = Math.ceil((width * 3) / 4) * 4; // rows padded to 4 bytes
  const pixelDataSize = rowSize * height;
  const fileSize = 54 + pixelDataSize;

  const buf = Buffer.alloc(fileSize);

  // File Header (14 bytes)
  buf.write('BM', 0);
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(0, 6);     // reserved
  buf.writeUInt32LE(54, 10);   // pixel data offset

  // DIB Header (40 bytes -- BITMAPINFOHEADER)
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22); // positive = bottom-up
  buf.writeUInt16LE(1, 26);     // color planes
  buf.writeUInt16LE(24, 28);    // bits per pixel
  buf.writeUInt32LE(0, 30);     // compression (none)
  buf.writeUInt32LE(pixelDataSize, 34);
  buf.writeInt32LE(2835, 38);   // h resolution (72 DPI)
  buf.writeInt32LE(2835, 42);   // v resolution
  buf.writeUInt32LE(0, 46);     // colors in palette
  buf.writeUInt32LE(0, 50);     // important colors

  // Pixel data (bottom-up, BGR)
  const colors = [
    [255, 0, 0],   // red
    [0, 255, 0],   // green
    [0, 0, 255],   // blue
    [255, 255, 0], // yellow
  ];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colors[(x + y) % 4];
      const off = 54 + y * rowSize + x * 3;
      buf[off] = b;     // BMP is BGR
      buf[off + 1] = g;
      buf[off + 2] = r;
    }
  }

  return buf;
}

function generateSVG() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect x="4" y="4" width="56" height="56" rx="8"
        fill="none" stroke="#333" stroke-width="1.5"/>
  <circle cx="32" cy="28" r="12"
          fill="none" stroke="#0066cc" stroke-width="1.5"/>
  <line x1="16" y1="48" x2="48" y2="48"
        stroke="#666" stroke-width="1.5" stroke-linecap="round"/>
</svg>
`;
}

function generateWAV() {
  // 1-second 440Hz sine wave, 44100 Hz, 16-bit mono
  const sampleRate = 44100;
  const duration = 1;
  const freq = 440;
  const numSamples = sampleRate * duration;
  const bytesPerSample = 2;
  const dataSize = numSamples * bytesPerSample;

  const buf = Buffer.alloc(44 + dataSize);

  // RIFF header
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);

  // fmt chunk
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);         // chunk size
  buf.writeUInt16LE(1, 20);          // PCM format
  buf.writeUInt16LE(1, 22);          // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
  buf.writeUInt16LE(bytesPerSample, 32);               // block align
  buf.writeUInt16LE(16, 34);                            // bits per sample

  // data chunk
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  // Samples
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.round(Math.sin(2 * Math.PI * freq * t) * 16000);
    buf.writeInt16LE(sample, 44 + i * bytesPerSample);
  }

  return buf;
}

function generatePDF() {
  // Minimal valid single-page PDF with text
  const objects = [];
  let objNum = 0;

  function addObj(content) {
    objNum++;
    const str = `${objNum} 0 obj\n${content}\nendobj\n`;
    objects.push({ num: objNum, offset: -1, str });
    return objNum;
  }

  // Catalog
  const catalogId = addObj(`<< /Type /Catalog /Pages 2 0 R >>`);

  // Pages
  const pagesId = addObj(`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`);

  // Page
  const pageId = addObj(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100]
   /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`);

  // Content stream
  const text = 'Test PDF - media fixture for upload and asset editing tests';
  const stream = `BT\n/F1 10 Tf\n20 60 Td\n(${text}) Tj\nET`;
  const contentId = addObj(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);

  // Font
  const fontId = addObj(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);

  // Build file
  let body = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  for (const obj of objects) {
    obj.offset = body.length;
    body += obj.str;
  }

  // Cross-reference table
  const xrefOffset = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n`;
  xref += '0000000000 65535 f \n';
  for (const obj of objects) {
    xref += `${String(obj.offset).padStart(10, '0')} 00000 n \n`;
  }

  // Trailer
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return body + xref + trailer;
}

function generateTXT() {
  return `Test Document
=============

This is a plain text fixture file for upload and asset editing tests.

It contains multiple lines, some formatting conventions, and enough
content to exercise metadata generation and content preview features.

Key details:
- Format: Plain text (UTF-8)
- Purpose: Testing file upload, content display, and inline editing
- Size: Small (~500 bytes)

Line with special characters: curly quotes, em-dash, ellipsis...
Final line for boundary testing.
`;
}

// ── Phase 2 generators (FFmpeg) ──────────────────────────────────────────────

function generateMP4(wavPath) {
  const output = path.join(BASE, 'sample.mp4');
  // 1-second 64x64 blue video with the WAV as audio
  const audioArgs = fs.existsSync(wavPath)
    ? `-i "${wavPath}" -c:a aac -b:a 64k -shortest`
    : `-f lavfi -i anullsrc=r=44100:cl=mono -t 1 -c:a aac -b:a 64k`;
  return runFfmpeg(
    `-f lavfi -i "color=c=0x336699:s=64x64:d=1:r=15" ${audioArgs} ` +
    `-c:v libx264 -pix_fmt yuv420p -preset ultrafast -crf 35 "${output}"`,
    output
  );
}

function generateMP3(wavPath) {
  const output = path.join(BASE, 'sample.mp3');
  if (!fs.existsSync(wavPath)) {
    console.log(`  SKIP (no WAV source): ${path.relative(process.cwd(), output)}`);
    return false;
  }
  return runFfmpeg(
    `-i "${wavPath}" -codec:a libmp3lame -b:a 64k -ar 44100 "${output}"`,
    output
  );
}

function generateWebP(pngPath) {
  const output = path.join(BASE, 'sample.webp');
  const rel = path.relative(process.cwd(), output);
  if (!force && fs.existsSync(output)) {
    console.log(`  SKIP (exists): ${rel}`);
    return false;
  }
  if (!fs.existsSync(pngPath)) {
    console.log(`  SKIP (no PNG source): ${rel}`);
    return false;
  }
  // Try cwebp first (more widely available for WebP encoding)
  try {
    execSync(`cwebp -q 50 "${pngPath}" -o "${output}"`, { stdio: 'pipe' });
    console.log(`  WROTE: ${rel}`);
    return true;
  } catch {
    // Fall back to FFmpeg with explicit codec
    return runFfmpeg(
      `-i "${pngPath}" -c:v libwebp "${output}"`,
      output
    );
  }
}

// ── JPEG generator (minimal valid JFIF) ──────────────────────────────────────

function generateJPEG() {
  // We create a minimal valid JPEG using FFmpeg from the generated PNG.
  // If FFmpeg is not available, we skip (JPEG encoding requires DCT which
  // is non-trivial to implement in pure JS without dependencies).
  const pngPath = path.join(BASE, 'sample.png');
  const output = path.join(BASE, 'sample.jpg');
  if (!fs.existsSync(pngPath)) {
    console.log(`  SKIP (no PNG source): ${path.relative(process.cwd(), output)}`);
    return false;
  }
  return runFfmpeg(
    `-i "${pngPath}" -q:v 5 "${output}"`,
    output
  );
}

// ── main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log('\nGenerating media test fixtures...\n');

  const ffmpegAvailable = hasFfmpeg();
  if (!ffmpegAvailable) {
    console.log('  WARNING: FFmpeg not found. Phase 2 files (MP4, MP3, WebP, JPEG) will be skipped.');
    console.log('  Install FFmpeg to generate all fixtures.\n');
  }

  let written = 0;
  let skipped = 0;
  let failed = 0;

  function track(result) {
    if (result === true) written++;
    else if (result === false) skipped++;
    else failed++;
  }

  // ── Phase 1: Pure Node.js ──
  console.log('Phase 1: Generating files with Node.js...\n');

  track(writeFixture(path.join(BASE, 'sample.png'), generatePNG()));
  track(writeFixture(path.join(BASE, 'sample.gif'), generateGIF()));
  track(writeFixture(path.join(BASE, 'sample.bmp'), generateBMP()));
  track(writeFixture(path.join(BASE, 'sample.svg'), generateSVG()));
  track(writeFixture(path.join(BASE, 'sample.wav'), generateWAV()));
  track(writeFixture(path.join(BASE, 'sample.pdf'), generatePDF()));
  track(writeFixture(path.join(BASE, 'sample.txt'), generateTXT()));

  // ── Phase 2: FFmpeg ──
  if (ffmpegAvailable) {
    console.log('\nPhase 2: Generating files with FFmpeg...\n');

    const wavPath = path.join(BASE, 'sample.wav');
    const pngPath = path.join(BASE, 'sample.png');

    track(generateJPEG());
    track(generateMP4(wavPath));
    track(generateMP3(wavPath));
    track(generateWebP(pngPath));
  }

  // ── Summary ──
  console.log(`\nDone. ${written} written, ${skipped} skipped${failed ? `, ${failed} failed` : ''}.`);
  console.log(`Fixture directory: ${path.relative(process.cwd(), BASE)}`);

  if (ffmpegAvailable) {
    const allFiles = [
      'sample.png', 'sample.gif', 'sample.bmp', 'sample.svg',
      'sample.wav', 'sample.pdf', 'sample.txt',
      'sample.jpg', 'sample.mp4', 'sample.mp3', 'sample.webp',
    ];
    const existing = allFiles.filter(f => fs.existsSync(path.join(BASE, f)));
    console.log(`Files present: ${existing.length}/${allFiles.length}`);
    for (const f of existing) {
      const stat = fs.statSync(path.join(BASE, f));
      const sizeKB = (stat.size / 1024).toFixed(1);
      console.log(`  ${f.padEnd(16)} ${sizeKB.padStart(8)} KB`);
    }
  }

  console.log('');
}

main();
