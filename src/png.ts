import { crc32 } from './crc32.js';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Chunk types that exist to carry information about the image's history or
// origin rather than the pixels themselves. This is what gets removed.
const METADATA_CHUNK_TYPES = new Set(['tEXt', 'zTXt', 'iTXt', 'tIME', 'eXIf']);

export class PngFormatError extends Error {
  override readonly name = 'PngFormatError';
}

export interface ParseOptions {
  lenient: boolean;
}

interface PngChunk {
  type: string;
  data: Buffer;
}

interface ParseResult {
  chunks: PngChunk[];
  warnings: string[];
}

export function isMetadataChunk(type: string): boolean {
  return METADATA_CHUNK_TYPES.has(type);
}

export function parsePng(buf: Buffer, opts: ParseOptions): ParseResult {
  const warnings: string[] = [];

  function fail(message: string): void {
    if (!opts.lenient) {
      throw new PngFormatError(message);
    }
    warnings.push(message);
  }

  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    // A bad signature means we're almost certainly not looking at a PNG at
    // all, so there is nothing sensible to salvage even in lenient mode.
    throw new PngFormatError('not a PNG file (signature does not match)');
  }

  const chunks: PngChunk[] = [];
  let offset = 8;
  let sawIHDR = false;
  let sawIEND = false;

  while (offset < buf.length && !sawIEND) {
    if (offset + 8 > buf.length) {
      fail(`truncated chunk header at offset ${offset}`);
      break;
    }

    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;

    if (length > 0x7fffffff || crcEnd > buf.length) {
      fail(`chunk "${type}" at offset ${offset} claims a length of ${length} bytes, which runs past the end of the file`);
      break;
    }

    const data = buf.subarray(dataStart, dataEnd);
    const storedCrc = buf.readUInt32BE(dataEnd);
    const computedCrc = crc32(buf.subarray(offset + 4, dataEnd));
    if (storedCrc !== computedCrc) {
      fail(
        `chunk "${type}" at offset ${offset} has a bad CRC (stored 0x${storedCrc.toString(16)}, computed 0x${computedCrc.toString(16)})`,
      );
    }

    if (type === 'IHDR') sawIHDR = true;
    if (type === 'IEND') sawIEND = true;

    chunks.push({ type, data: Buffer.from(data) });
    offset = crcEnd;
  }

  if (!sawIHDR) {
    fail('no IHDR chunk found');
  }
  if (!sawIEND) {
    fail('no IEND chunk found (file may be truncated)');
  }

  return { chunks, warnings };
}

export interface StripResult {
  output: Buffer;
  removed: { type: string; bytes: number }[];
  warnings: string[];
}

export function stripMetadata(buf: Buffer, opts: ParseOptions): StripResult {
  const { chunks, warnings } = parsePng(buf, opts);
  const removed: { type: string; bytes: number }[] = [];
  const parts: Buffer[] = [SIGNATURE];

  for (const chunk of chunks) {
    if (isMetadataChunk(chunk.type)) {
      removed.push({ type: chunk.type, bytes: chunk.data.length });
      continue;
    }
    parts.push(encodeChunk(chunk.type, chunk.data));
  }

  return { output: Buffer.concat(parts), removed, warnings };
}

function encodeChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}
