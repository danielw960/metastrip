import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMetadataSegment, markerName, parseJpeg, stripMetadata, JpegFormatError } from './jpeg.js';

const APP0 = 0xe0;
const APP1 = 0xe1;
const APP13 = 0xed;
const SOS = 0xda;

function segment(marker: number, data: Buffer): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(data.length + 2, 0);
  return Buffer.concat([Buffer.from([0xff, marker]), length, data]);
}

const SOS_HEADER = Buffer.from([0x00, 0x3f, 0x00]);
// includes a stuffed 0xff00 byte and an embedded restart marker, both of
// which are part of the entropy-coded stream rather than the next segment
const SCAN_DATA = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]);

function minimalJpeg(extraSegments: { marker: number; data: Buffer }[] = []): Buffer {
  const parts = [
    Buffer.from([0xff, 0xd8]), // SOI
    ...extraSegments.map((s) => segment(s.marker, s.data)),
    segment(SOS, SOS_HEADER),
    SCAN_DATA,
    Buffer.from([0xff, 0xd9]), // EOI
  ];
  return Buffer.concat(parts);
}

test('isMetadataSegment and markerName identify APP1/APP13 and nothing else', () => {
  assert.equal(isMetadataSegment(APP1), true);
  assert.equal(isMetadataSegment(APP13), true);
  assert.equal(isMetadataSegment(APP0), false);
  assert.equal(markerName(APP1), 'APP1');
  assert.equal(markerName(APP13), 'APP13');
  assert.equal(markerName(APP0), '0xe0');
});

test('parseJpeg reads a well-formed file with no warnings', () => {
  const buf = minimalJpeg([{ marker: APP0, data: Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00]) }]);
  const { segments, warnings } = parseJpeg(buf, { lenient: false });
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    segments.map((s) => s.marker),
    [0xd8, APP0, SOS, 0xd9],
  );
});

test('parseJpeg captures scan data between SOS and EOI, skipping stuffed bytes and restart markers', () => {
  const buf = minimalJpeg();
  const { segments } = parseJpeg(buf, { lenient: false });
  const sos = segments.find((s) => s.marker === SOS);
  assert.equal(sos?.scan?.toString('hex'), SCAN_DATA.toString('hex'));
});

test('parseJpeg rejects a file missing the SOI marker even in lenient mode', () => {
  const buf = Buffer.from('not a jpeg at all');
  assert.throws(() => parseJpeg(buf, { lenient: true }), JpegFormatError);
});

test('parseJpeg throws on a segment length that runs past the end of the file', () => {
  const buf = minimalJpeg([{ marker: APP1, data: Buffer.from([0x01, 0x02]) }]);
  const app1LengthOffset = 2 + 2; // SOI + marker bytes
  buf.writeUInt16BE(0xff00, app1LengthOffset);
  assert.throws(() => parseJpeg(buf, { lenient: false }), JpegFormatError);
});

test('parseJpeg warns instead of throwing on a truncated segment in lenient mode', () => {
  const buf = minimalJpeg([{ marker: APP1, data: Buffer.from([0x01, 0x02]) }]);
  const app1LengthOffset = 2 + 2;
  buf.writeUInt16BE(0xff00, app1LengthOffset);
  const { warnings } = parseJpeg(buf, { lenient: true });
  assert.ok(warnings.some((w) => w.includes('runs past the end of the file')));
});

test('parseJpeg flags a missing EOI as a warning in lenient mode, an error otherwise', () => {
  const full = minimalJpeg();
  const withoutEoi = full.subarray(0, full.length - 2);

  assert.throws(() => parseJpeg(withoutEoi, { lenient: false }), JpegFormatError);

  const { warnings } = parseJpeg(Buffer.from(withoutEoi), { lenient: true });
  assert.ok(warnings.some((w) => w.includes('EOI')));
});

test('stripMetadata removes APP1 and APP13 segments and keeps everything else', () => {
  const buf = minimalJpeg([
    { marker: APP0, data: Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00]) },
    { marker: APP1, data: Buffer.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]) },
    { marker: APP13, data: Buffer.from([0x50, 0x68, 0x6f, 0x74, 0x6f, 0x73, 0x68, 0x6f, 0x70]) },
  ]);

  const { output, removed, warnings } = stripMetadata(buf, { lenient: false });
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    removed.map((r) => r.marker),
    [APP1, APP13],
  );

  const { segments } = parseJpeg(output, { lenient: false });
  assert.deepEqual(
    segments.map((s) => s.marker),
    [0xd8, APP0, SOS, 0xd9],
  );
});

test('stripMetadata output is itself a valid JPEG that reparses cleanly', () => {
  const buf = minimalJpeg([{ marker: APP1, data: Buffer.from([0x45, 0x78, 0x69, 0x66]) }]);
  const { output } = stripMetadata(buf, { lenient: false });
  assert.equal(output[0], 0xff);
  assert.equal(output[1], 0xd8);
  assert.doesNotThrow(() => parseJpeg(output, { lenient: false }));
});

test('stripMetadata is a no-op on a file with no APP1/APP13 segments', () => {
  const buf = minimalJpeg([{ marker: APP0, data: Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00]) }]);
  const { output, removed } = stripMetadata(buf, { lenient: false });
  assert.deepEqual(removed, []);
  assert.equal(output.toString('hex'), buf.toString('hex'));
});
