# @electron-internal/extract-zip

> [!WARNING]
> **Internal to the Electron project.** This package exists to serve Electron's
> own tooling. Use from non-Electron packages is not supported: the API may
> change to suit Electron's needs, and bug reports or feature requests from
> outside use cases may be closed without action. If you need a general-purpose
> extractor, use [`extract-zip`](https://github.com/max-mapper/extract-zip).

Fast, safe, native zip extraction for Node.js. Drop-in replacement for [`extract-zip`](https://github.com/max-mapper/extract-zip).

- **Native**: Rust core via N-API, decompression runs off the event loop.
- **Fast**: ~2x faster on entry-heavy archives, never slower. See [benchmarks](#benchmarks).
- **Safe**: hardened against Zip Slip, symlink escapes, absolute paths, NUL injection, Windows reserved names, and zip bombs.
- **Zero runtime deps**: no `debug`/`yauzl`/`get-stream` in your tree.
- **Cross-platform**: prebuilt binaries for macOS, Linux (glibc/musl), and Windows (x64/arm64).

## Install

```sh
yarn add @electron-internal/extract-zip
```

## Usage

ESM only:

```js
import extract from '@electron-internal/extract-zip';

await extract('archive.zip', { dir: '/absolute/output/path' });
```

`dir` (required, absolute) is the only option. Everything else is fixed: existing
files are overwritten, archive mode bits (masked to `0o777`) and mtimes are
preserved, symlinks are created (skipped on Windows without symlink privilege),
and writes are parallelised across `min(cpus, 8)` workers. The original's
`onEntry`, `defaultDirMode`, and `defaultFileMode` are not supported, since no
consumer in the `electron` org uses them.

## Security

Every entry path is verified to land inside `dir`:

- `..` traversal is rejected and absolute paths are stripped, via the `zip` crate's audited `enclosed_name()`.
- Directories are created one component at a time without following symlinks; an entry whose path crosses a symlink is rejected.
- Symlinks are created after all files. Each target is walked against the on-disk tree and the archive's own symlink set, with relative-only hops bounded by `dir` and a hop cap, so a chain resolving outside `dir` is rejected before any link is created.
- NUL bytes and Windows reserved device names (`CON`, `AUX`, `COM1`, trailing space/dot) are rejected on every platform.
- Symlink targets are capped at 4 KiB; per-file output is capped at `max(2 x declared size, 1 MB)` to catch entries that lie about their size.

`test/security.test.js` exercises these escapes end-to-end with hand-crafted archives.

## Benchmarks

`yarn bench` (Apple M-series, Node 24, median of 5):

| Corpus | Zip size | `extract-zip` (JS) | this | Speedup |
|---|--:|--:|--:|--:|
| electron-v42.2.0-darwin-arm64 | 112 MB | 817 ms | 441 ms | 1.9x |
| 8 x 4 MB compressible | 0.1 MB | 24 ms | 3 ms | 9.4x |
| 2000 small text files | 0.4 MB | 372 ms | 199 ms | 1.9x |
| 200 incompressible files | 6.2 MB | 40 ms | 22 ms | 1.8x |
| `node_modules` | 2.9 MB | 68 ms | 37 ms | 1.9x |

Extraction runs in phases: validate paths and create directories, inflate and
write files in parallel with zlib-ng, then apply symlinks and directory
metadata. The Electron number is gated by its single 182 MB framework binary,
which can't be split further.

## Distribution

One package ships all prebuilt binaries (~2 MB gzipped): macOS
`darwin-universal`, Windows `x64`/`arm64`, and Linux `x64`/`arm64` for both glibc
and musl. `binding.js` picks the right one at load time. No
`optionalDependencies`, no postinstall, no network at install.

## Building from source

Requires a Rust toolchain (and `cmake` for zlib-ng).

```sh
yarn install
yarn build     # builds index.<your-platform>.node
yarn test
```

## Releasing

Releases are driven by [semantic-release](https://semantic-release.gitbook.io/)
on every push to `main`: conventional commit messages decide the version bump,
CI builds all targets, and the fat package is published to npm via trusted
publishing. No manual version bumps or tags.

## License

BSD-2-Clause
