# LocalPass Firefox Extension — Build Instructions

This document explains how to reproduce the submitted add-on artifact from
source. It is written for Mozilla Add-ons (AMO) reviewers and any contributor
who needs to build the extension locally.

## Source tarball layout

The reviewer source upload contains the full repository, because the extension
depends on a sibling workspace package (`@localpass/core`) that is not published
to npm and is consumed via a local file reference.

Expected top-level contents after extracting the tarball:

```
localpass/
├── Makefile            # build orchestrator (entry point)
├── core/               # @localpass/core — shared TypeScript library
│   ├── logo.svg        # source of the extension icons
│   ├── package.json
│   └── src/
├── firefox-ext/        # this extension
│   ├── manifest.json
│   ├── package.json
│   ├── src/
│   └── README.md       # this file
└── LICENSE
```

The `cli/` directory (a Go-based command-line client) is **not** required for
building the extension and may be omitted from the review tarball.

## Build environment

| Item              | Required version    | Notes                                  |
|-------------------|---------------------|----------------------------------------|
| Operating system  | Linux or macOS      | Tested on Ubuntu 24.04 and macOS 14    |
| Node.js           | 22.x (LTS)          | Used for Parcel, TypeScript, web-ext   |
| npm               | 10.x                | Bundled with Node.js 22                |
| GNU Make          | 4.x                 | Build orchestrator                     |
| ImageMagick       | 6.9+ or 7.x         | Provides `convert` for icon generation |
| jq                | 1.6+                | Patches the built manifest             |

The exact toolchain used to produce the uploaded artifact:

- Ubuntu 24.04 LTS
- Node.js v22.22.2
- npm 10.9.7
- GNU Make 4.3
- ImageMagick 6.9.12-98
- jq 1.6

### Installing the build tools

**Ubuntu / Debian:**

```sh
# Node.js 22 LTS via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Other build tools
sudo apt-get install -y make imagemagick jq
```

**macOS (Homebrew):**

```sh
brew install node@22 make imagemagick jq
```

**Other platforms / version managers:**

- Node.js: https://nodejs.org/en/download (choose 22 LTS) or via `nvm`:
  `nvm install 22 && nvm use 22`
- ImageMagick: https://imagemagick.org/script/download.php
- jq: https://jqlang.github.io/jq/download/

## Build steps

Run the following commands from the **repository root** (the directory that
contains the `Makefile`):

```sh
# 1. Install the shared core library's dependencies and build it
cd core && npm ci && cd ..

# 2. Install the extension's dependencies (npm will symlink @localpass/core)
cd firefox-ext && npm ci && cd ..

# 3. Produce the uploadable .zip artifact for AMO
make package-firefox
```

The final command runs, in order:

1. `make icons` — regenerates `firefox-ext/icons/icon-{48,96}.png` from
   `core/logo.svg` using ImageMagick, padded to square dimensions with a
   transparent background.
2. `make build-core` — compiles `core/` via `tsc` into `core/dist/`.
3. `make build-firefox` — runs `parcel build manifest.json` inside
   `firefox-ext/`, then patches the built `dist/manifest.json` with `jq` to
   remove `background.service_worker` (Parcel requires this field at the
   source manifest for Chrome MV3 compatibility, but Firefox uses
   `background.scripts` instead, and `web-ext lint` flags the unused field).
4. `npx web-ext build` — zips the contents of `firefox-ext/dist/` into the
   final artifact.

## Output artifact

After a successful build the uploadable zip is placed at:

```
firefox-ext/web-ext-artifacts/localpass-<version>.zip
```

The `<version>` segment matches the `version` field in
`firefox-ext/manifest.json` (currently `1.0.0`).

## Verifying the build

To lint the built artifact with the same tooling AMO uses:

```sh
cd firefox-ext
npx web-ext lint --source-dir=dist
```

The reproducible build should report `0 errors, 0 notices`. Some informational
warnings (`ANDROID_INCOMPATIBLE_API` for `permissions.request`, and
`UNSAFE_VAR_ASSIGNMENT` for Parcel's bundler shim and a static SVG path
assignment in the icon helper) are expected and are not blockers.

## Cleaning

```sh
make clean-firefox    # removes firefox-ext/dist
make clean-core       # removes core/dist
make clean            # removes everything (also cleans cli/)
```

## Troubleshooting

- **`npm ci` fails inside `firefox-ext/` complaining about `@localpass/core`** —
  Run `npm ci` inside `core/` first. The extension's `package-lock.json`
  references the sibling `../core` directory; that directory must exist with
  its `package.json` intact before installing the extension.
- **`convert: command not found`** — Install ImageMagick (see above). On newer
  systems the binary may be called `magick`; in that case create an alias
  (`alias convert='magick'`) or symlink before running `make icons`.
- **`parcel` reports "Missing property service_worker"** — Confirm that
  `firefox-ext/manifest.json` (the source manifest, not the dist one) contains
  `background.service_worker`. The Makefile strips it from the built output
  after Parcel runs.
