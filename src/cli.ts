#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import { stripMetadata as stripPng, PngFormatError } from './png.js';
import { stripMetadata as stripJpeg, JpegFormatError, markerName } from './jpeg.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type Format = 'png' | 'jpeg';

function detectFormat(buf: Buffer): Format | undefined {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return 'png';
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) {
    return 'jpeg';
  }
  return undefined;
}

interface StripOutcome {
  output: Buffer;
  removed: { label: string; bytes: number }[];
  warnings: string[];
}

function stripFile(format: Format, buf: Buffer, lenient: boolean): StripOutcome {
  if (format === 'png') {
    const { output, removed, warnings } = stripPng(buf, { lenient });
    return { output, warnings, removed: removed.map((r) => ({ label: r.type, bytes: r.bytes })) };
  }
  const { output, removed, warnings } = stripJpeg(buf, { lenient });
  return { output, warnings, removed: removed.map((r) => ({ label: markerName(r.marker), bytes: r.bytes })) };
}

function printUsage(): void {
  console.error(`usage: metastrip <input.png|input.jpg> [-o output] [--lenient] [--dry-run]

  -o, --output <path>   write the stripped image here (default: <input>.stripped<ext>)
      --lenient         tolerate structural problems (bad CRCs, truncated chunks/segments)
                        instead of stopping at the first one
      --dry-run         report what would be removed without writing a file
  -h, --help            show this message`);
}

interface Args {
  input: string;
  output: string | undefined;
  lenient: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  let input: string | undefined;
  let output: string | undefined;
  let lenient = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    switch (arg) {
      case '-h':
      case '--help':
        printUsage();
        process.exit(0);
      case '--lenient':
        lenient = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '-o':
      case '--output': {
        const next = argv[++i];
        if (next === undefined) {
          throw new Error(`${arg} requires a path argument`);
        }
        output = next;
        break;
      }
      default:
        if (arg.startsWith('-')) {
          throw new Error(`unrecognized option: ${arg}`);
        }
        if (input !== undefined) {
          throw new Error(`unexpected extra argument: ${arg}`);
        }
        input = arg;
    }
  }

  if (input === undefined) {
    throw new Error('missing required <input> argument');
  }

  return { input, output, lenient, dryRun };
}

function defaultOutputPath(input: string): string {
  const ext = extname(input);
  const base = ext ? input.slice(0, -ext.length) : input;
  return `${base}.stripped${ext}`;
}

function main(): void {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`metastrip: ${(err as Error).message}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  const buf = readFileSync(args.input);
  const format = detectFormat(buf);
  if (format === undefined) {
    console.error('metastrip: unrecognized file format (only PNG and JPEG are supported)');
    process.exitCode = 1;
    return;
  }

  try {
    const { output, removed, warnings } = stripFile(format, buf, args.lenient);

    for (const warning of warnings) {
      console.error(`metastrip: warning: ${warning}`);
    }

    if (removed.length === 0) {
      console.log('no metadata found');
    } else {
      for (const item of removed) {
        console.log(`removed ${item.label} (${item.bytes} bytes)`);
      }
    }

    if (!args.dryRun) {
      const outPath = args.output ?? defaultOutputPath(args.input);
      writeFileSync(outPath, output);
      console.log(`wrote ${outPath}`);
    }
  } catch (err) {
    if (err instanceof PngFormatError || err instanceof JpegFormatError) {
      console.error(`metastrip: ${err.message}`);
      console.error('metastrip: pass --lenient to continue past structural problems');
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

main();
