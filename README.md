# metastrip

A command-line tool that strips identifying metadata out of image files
before you share them.

## the problem

PNG files carry more than pixels. Text chunks (`tEXt`, `zTXt`, `iTXt`) often
hold the name of the software that last touched the file, sometimes an
author or a comment someone typed years ago. `tIME` records when it was last
modified. `eXIf` can carry a full EXIF block, including camera make/model
and, if the photo was taken on a phone with location services on, GPS
coordinates. JPEG files carry the same kind of thing in `APP1` (EXIF) and
`APP13` (Photoshop's IPTC resource block) segments. None of that is visible
when you look at the image, and most people uploading a screenshot or a
photo have no idea it's riding along.

`metastrip` reads the chunk or segment structure of a file, tells you what
it found, and writes a copy with the identifying pieces removed. Pixel
data, color profile, and everything needed to actually render the image is
left alone.

## strict by default

Both formats have chunk/segment structures that are simple, but "simple"
and "always well-formed in the wild" are different things. By default
`metastrip` treats anything unexpected — a chunk length that runs past the
end of the file, a bad CRC, a missing `IHDR`/`IEND` or `SOI`/`EOI` — as a
reason to stop and report an error rather than guess at what the file
"probably" meant. Silently producing an output file from a file it didn't
fully understand is worse than refusing.

If you know your input is messy (some encoders write sloppy CRCs, or a file
got truncated) and you want `metastrip` to do its best anyway, pass
`--lenient`. It will keep going, print a warning for each problem it worked
around, and still produce output.

## usage

Build once:

```
npx tsc
```

Then run it against a file:

```
node dist/cli.js photo.png
```

```
removed tEXt (23 bytes)
removed eXIf (412 bytes)
wrote photo.stripped.png
```

See what's in a file without writing anything:

```
node dist/cli.js photo.png --dry-run
```

Pick your own output path:

```
node dist/cli.js photo.png -o for-upload.png
```

Push through structural problems instead of stopping:

```
node dist/cli.js weird-export.png --lenient
```

If you install it as a package with a `bin` entry, the same commands work as
`metastrip photo.png` instead of `node dist/cli.js photo.png`.

## tests

```
npm test
```

runs the unit tests in `src/png.test.ts` against hand-built PNG buffers
(Node's built-in test runner, no extra dependencies).

## current limitations

PNG and JPEG are supported. JPEG's `COM` (comment) segments aren't touched
yet, and there's no way to keep a specific chunk or segment type instead of
stripping everything metastrip recognizes — both are next on the list.

## license

MIT, see `LICENSE`.
