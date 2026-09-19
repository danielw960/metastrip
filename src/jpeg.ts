const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const TEM = 0x01;
const APP1 = 0xe1;
const APP13 = 0xed;

// APP1 usually carries EXIF (and sometimes XMP); APP13 is where Photoshop
// puts its resource block, which is how IPTC fields end up in a JPEG. Both
// are squarely "identifying metadata" in the sense this tool cares about.
const METADATA_MARKERS = new Set([APP1, APP13]);

export class JpegFormatError extends Error {
  override readonly name = 'JpegFormatError';
}

export interface ParseOptions {
  lenient: boolean;
}

interface JpegSegment {
  marker: number;
  data: Buffer;
  // raw entropy-coded bytes immediately following an SOS header; only ever
  // set on SOS segments, since scan data has no marker/length of its own
  scan?: Buffer;
}

interface ParseResult {
  segments: JpegSegment[];
  warnings: string[];
}

function isStandalone(marker: number): boolean {
  return marker === SOI || marker === EOI || marker === TEM || (marker >= 0xd0 && marker <= 0xd7);
}

export function isMetadataSegment(marker: number): boolean {
  return METADATA_MARKERS.has(marker);
}

export function markerName(marker: number): string {
  switch (marker) {
    case APP1:
      return 'APP1';
    case APP13:
      return 'APP13';
    default:
      return `0x${marker.toString(16).padStart(2, '0')}`;
  }
}

export function parseJpeg(buf: Buffer, opts: ParseOptions): ParseResult {
  const warnings: string[] = [];

  function fail(message: string): void {
    if (!opts.lenient) {
      throw new JpegFormatError(message);
    }
    warnings.push(message);
  }

  if (buf.length < 2 || buf[0] !== 0xff || buf[1] !== SOI) {
    // Same reasoning as the PNG signature check: without SOI there's no
    // JPEG structure to salvage, lenient or not.
    throw new JpegFormatError('not a JPEG file (missing SOI marker)');
  }

  const segments: JpegSegment[] = [{ marker: SOI, data: Buffer.alloc(0) }];
  let offset = 2;
  let sawEOI = false;

  while (offset < buf.length && !sawEOI) {
    if (buf[offset] !== 0xff) {
      fail(`expected a marker at offset ${offset} but found byte 0x${buf[offset]!.toString(16)}`);
      break;
    }

    // The encoder may pad with extra 0xff fill bytes before the real marker
    // byte; skip past them to find it.
    let markerOffset = offset + 1;
    while (markerOffset < buf.length && buf[markerOffset] === 0xff) {
      markerOffset++;
    }
    if (markerOffset >= buf.length) {
      fail(`truncated marker at offset ${offset}`);
      break;
    }

    const marker = buf[markerOffset]!;
    offset = markerOffset + 1;

    if (marker === EOI) {
      segments.push({ marker: EOI, data: Buffer.alloc(0) });
      sawEOI = true;
      break;
    }

    if (isStandalone(marker)) {
      segments.push({ marker, data: Buffer.alloc(0) });
      continue;
    }

    if (offset + 2 > buf.length) {
      fail(`truncated segment length at offset ${offset}`);
      break;
    }

    const length = buf.readUInt16BE(offset);
    if (length < 2) {
      fail(`segment ${markerName(marker)} at offset ${offset} has an invalid length of ${length}`);
      break;
    }

    const dataStart = offset + 2;
    const dataEnd = offset + length;
    if (dataEnd > buf.length) {
      fail(`segment ${markerName(marker)} at offset ${offset} claims a length of ${length} bytes, which runs past the end of the file`);
      break;
    }

    const data = Buffer.from(buf.subarray(dataStart, dataEnd));
    offset = dataEnd;

    if (marker !== SOS) {
      segments.push({ marker, data });
      continue;
    }

    // Scan (entropy-coded) data follows the SOS header with no length
    // prefix. It runs until the next byte that is genuinely a marker, which
    // means skipping stuffed 0xff00 bytes and restart markers that are
    // themselves part of the entropy stream rather than the next segment.
    const scanStart = offset;
    let scanEnd = buf.length;
    let i = offset;
    while (i < buf.length - 1) {
      if (buf[i] === 0xff) {
        const next = buf[i + 1]!;
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          i += 2;
          continue;
        }
        if (next === 0xff) {
          i += 1;
          continue;
        }
        scanEnd = i;
        break;
      }
      i += 1;
    }

    if (scanEnd === buf.length) {
      fail(`scan data starting at offset ${scanStart} runs to the end of the file without a terminating marker`);
    }

    segments.push({ marker: SOS, data, scan: Buffer.from(buf.subarray(scanStart, scanEnd)) });
    offset = scanEnd;
  }

  if (!sawEOI) {
    fail('no EOI marker found (file may be truncated)');
  }

  return { segments, warnings };
}

export interface StripResult {
  output: Buffer;
  removed: { marker: number; bytes: number }[];
  warnings: string[];
}

export function stripMetadata(buf: Buffer, opts: ParseOptions): StripResult {
  const { segments, warnings } = parseJpeg(buf, opts);
  const removed: { marker: number; bytes: number }[] = [];
  const parts: Buffer[] = [];

  for (const segment of segments) {
    if (isMetadataSegment(segment.marker)) {
      removed.push({ marker: segment.marker, bytes: segment.data.length });
      continue;
    }
    parts.push(encodeSegment(segment));
  }

  return { output: Buffer.concat(parts), removed, warnings };
}

function encodeSegment(segment: JpegSegment): Buffer {
  if (isStandalone(segment.marker)) {
    return Buffer.from([0xff, segment.marker]);
  }
  const length = Buffer.alloc(2);
  length.writeUInt16BE(segment.data.length + 2, 0);
  const parts = [Buffer.from([0xff, segment.marker]), length, segment.data];
  if (segment.scan) {
    parts.push(segment.scan);
  }
  return Buffer.concat(parts);
}
