#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import { stripMetadata, PngFormatError } from './png.js';

function printUsage(): void {
  console.error(`usage: metastrip <input.png> [-o output.png] [--lenient] [--dry-run]

  -o, --output <path>   write the stripped image here (default: <input>.stripped<ext>)
      --lenient         tolerate structural problems (bad CRCs, truncated chunks)
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
  const looksLikePng = buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50;
  if (!looksLikePng) {
    console.error('metastrip: only PNG files are supported right now (JPEG support is planned)');
    process.exitCode = 1;
    return;
  }

  try {
    const { output, removed, warnings } = stripMetadata(buf, { lenient: args.lenient });

    for (const warning of warnings) {
      console.error(`metastrip: warning: ${warning}`);
    }

    if (removed.length === 0) {
      console.log('no metadata chunks found');
    } else {
      for (const chunk of removed) {
        console.log(`removed ${chunk.type} (${chunk.bytes} bytes)`);
      }
    }

    if (!args.dryRun) {
      const outPath = args.output ?? defaultOutputPath(args.input);
      writeFileSync(outPath, output);
      console.log(`wrote ${outPath}`);
    }
  } catch (err) {
    if (err instanceof PngFormatError) {
      console.error(`metastrip: ${err.message}`);
      console.error('metastrip: pass --lenient to continue past structural problems');
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

main();
