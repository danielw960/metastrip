import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from './crc32.js';
import { isMetadataChunk, parsePng, stripMetadata, PngFormatError } from './png.js';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

// A 1x1 8-bit grayscale image is the smallest legal IHDR payload; the exact
// pixel values in IDAT don't matter to anything this file tests.
const IHDR_DATA = Buffer.from([
  0x00, 0x00, 0x00, 0x01, // width
  0x00, 0x00, 0x00, 0x01, // height
  0x08, // bit depth
  0x00, // color type: grayscale
  0x00, // compression
  0x00, // filter
  0x00, // interlace
]);
const IDAT_DATA = Buffer.from([0x78, 0x9c, 0x01, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01]);

function minimalPng(extraChunks: { type: string; data: Buffer }[] = []): Buffer {
  const parts = [
    SIGNATURE,
    chunk('IHDR', IHDR_DATA),
    ...extraChunks.map((c) => chunk(c.type, c.data)),
    chunk('IDAT', IDAT_DATA),
    chunk('IEND', Buffer.alloc(0)),
  ];
  return Buffer.concat(parts);
}

test('isMetadataChunk identifies known metadata types and nothing else', () => {
  for (const type of ['tEXt', 'zTXt', 'iTXt', 'tIME', 'eXIf']) {
    assert.equal(isMetadataChunk(type), true);
  }
  for (const type of ['IHDR', 'IDAT', 'IEND', 'PLTE', 'gAMA']) {
    assert.equal(isMetadataChunk(type), false);
  }
});

test('parsePng reads a well-formed file with no warnings', () => {
  const buf = minimalPng([{ type: 'tEXt', data: Buffer.from('Comment\x00hello') }]);
  const { chunks, warnings } = parsePng(buf, { lenient: false });
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    chunks.map((c) => c.type),
    ['IHDR', 'tEXt', 'IDAT', 'IEND'],
  );
});

test('parsePng rejects a bad signature even in lenient mode', () => {
  const buf = Buffer.from('not a png at all');
  assert.throws(() => parsePng(buf, { lenient: true }), PngFormatError);
});

test('parsePng throws on a bad CRC by default', () => {
  const buf = minimalPng();
  const tExtOffset = 8 + 12 + IHDR_DATA.length; // signature + IHDR chunk
  // corrupt one byte of the length-prefixed IDAT chunk's CRC
  const idatChunkStart = tExtOffset;
  const idatCrcOffset = idatChunkStart + 8 + IDAT_DATA.length;
  buf[idatCrcOffset] = buf[idatCrcOffset]! ^ 0xff;
  assert.throws(() => parsePng(buf, { lenient: false }), PngFormatError);
});

test('parsePng warns instead of throwing on a bad CRC in lenient mode', () => {
  const buf = minimalPng();
  const idatChunkStart = 8 + 12 + IHDR_DATA.length;
  const idatCrcOffset = idatChunkStart + 8 + IDAT_DATA.length;
  buf[idatCrcOffset] = buf[idatCrcOffset]! ^ 0xff;
  const { chunks, warnings } = parsePng(buf, { lenient: true });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /bad CRC/);
  // parsing still recovers the full chunk list
  assert.deepEqual(
    chunks.map((c) => c.type),
    ['IHDR', 'IDAT', 'IEND'],
  );
});

test('parsePng throws on a chunk length that runs past the end of the file', () => {
  const buf = minimalPng();
  const idatChunkStart = 8 + 12 + IHDR_DATA.length;
  buf.writeUInt32BE(0xffffff, idatChunkStart); // absurd length for the IDAT chunk
  assert.throws(() => parsePng(buf, { lenient: false }), PngFormatError);
});

test('parsePng flags a missing IEND as a warning in lenient mode, an error otherwise', () => {
  const full = minimalPng();
  const withoutIend = full.subarray(0, full.length - chunk('IEND', Buffer.alloc(0)).length);

  assert.throws(() => parsePng(withoutIend, { lenient: false }), PngFormatError);

  const { warnings } = parsePng(Buffer.from(withoutIend), { lenient: true });
  assert.ok(warnings.some((w) => w.includes('IEND')));
});

test('stripMetadata removes all metadata chunk types and keeps everything else', () => {
  const buf = minimalPng([
    { type: 'tEXt', data: Buffer.from('Comment\x00hi') },
    { type: 'tIME', data: Buffer.from([0x07, 0xe8, 0x01, 0x01, 0x00, 0x00, 0x00]) },
    { type: 'eXIf', data: Buffer.from([0x4d, 0x4d, 0x00, 0x2a]) },
  ]);

  const { output, removed, warnings } = stripMetadata(buf, { lenient: false });
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    removed.map((r) => r.type),
    ['tEXt', 'tIME', 'eXIf'],
  );

  const { chunks } = parsePng(output, { lenient: false });
  assert.deepEqual(
    chunks.map((c) => c.type),
    ['IHDR', 'IDAT', 'IEND'],
  );
});

test('stripMetadata output is itself a valid PNG with correct CRCs', () => {
  const buf = minimalPng([{ type: 'tEXt', data: Buffer.from('Comment\x00hi') }]);
  const { output } = stripMetadata(buf, { lenient: false });
  assert.equal(output.subarray(0, 8).toString('hex'), SIGNATURE.toString('hex'));
  // re-parsing in strict mode throws on any CRC mismatch, so a clean parse
  // is proof the re-encoded chunks are byte-correct.
  assert.doesNotThrow(() => parsePng(output, { lenient: false }));
});

test('stripMetadata is a no-op on a file with no metadata chunks', () => {
  const buf = minimalPng();
  const { output, removed } = stripMetadata(buf, { lenient: false });
  assert.deepEqual(removed, []);
  assert.equal(output.toString('hex'), buf.toString('hex'));
});
