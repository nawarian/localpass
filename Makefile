.PHONY: all build build-cli build-core build-firefox package-firefox publish-firefox clean clean-cli clean-core clean-firefox icons

# Optional local secrets for publishing to AMO (WEB_EXT_API_KEY / WEB_EXT_API_SECRET).
# The leading '-' makes the include non-fatal when .env is absent; `export` pushes
# every variable (including those from .env) into recipe sub-shells, where
# `web-ext sign` auto-consumes the WEB_EXT_* credentials. .env is gitignored.
-include .env
export

all: build

# Build everything
build: build-core build-cli build-firefox

# Build the Go CLI application
build-cli:
	$(MAKE) -C cli build

# Build the shared TypeScript core library
build-core:
	cd core && npm run build

# Generate extension icons from the square LocalPass mark.
# 16/32 (toolbar) come from logo-small.svg, which is tuned for tiny sizes;
# 48/96/128 (add-ons manager, AMO listing) come from logo.svg.
# -density rasterises the SVG at high resolution before downscaling.
# The same two SVGs are also emitted as Preact components into
# firefox-ext/src/generated/logo.tsx for the in-app mark (popup, options,
# autofill overlay), so every surface ships the exact same logo.
icons:
	mkdir -p firefox-ext/icons
	for s in 16 32; do convert -background none -density 384 core/logo-small.svg -resize $${s}x$${s} firefox-ext/icons/icon-$$s.png; done
	for s in 48 96 128; do convert -background none -density 384 core/logo.svg -resize $${s}x$${s} firefox-ext/icons/icon-$$s.png; done
	node firefox-ext/scripts/gen-logo.mjs

# Build the Firefox extension (depends on icons + core)
# Parcel enforces service_worker for MV3, but Firefox temporary add-on loading
# needs background.scripts. We patch the dist manifest post-build.
build-firefox: icons build-core
	cd firefox-ext && npx parcel build manifest.json --no-scope-hoist
	cd firefox-ext/dist && mv manifest.json manifest_.json && \
	  jq '.background.scripts = [.background.service_worker] | del(.background.service_worker)' manifest_.json > manifest.json && \
	  rm manifest_.json

# Produce the uploadable .zip artifact for addons.mozilla.org
package-firefox: build-firefox
	cd firefox-ext && npx web-ext build --source-dir=dist --overwrite-dest

# Publish a new LISTED version of the Firefox extension to addons.mozilla.org.
# End-to-end release path (leaves package-firefox untouched):
#   1. prompt for the bump level (major/minor/patch)
#   2. bump firefox-ext/{package.json,manifest.json} in lockstep (no git tag)
#   3. rebuild so dist/manifest.json carries the bumped version
#   4. preflight `web-ext lint` gate (fails on errors; documented warnings tolerated)
#   5. build the AMO source archive from tracked files only (Parcel minifies dist)
#   6. sign & upload (fire-and-forget; returns once AMO accepts the upload)
#   7. commit the bump ONLY on success — a failed step leaves the bump uncommitted
# Credentials come from the gitignored .env (see `-include .env` / `export` above).
publish-firefox:
	@set -e; \
	read -p "Bump level (major/minor/patch): " level; \
	case "$$level" in \
	  major|minor|patch) ;; \
	  *) echo "Invalid bump level '$$level' (expected major/minor/patch)" >&2; exit 1 ;; \
	esac; \
	( cd firefox-ext && npm version "$$level" --no-git-tag-version >/dev/null ); \
	version=$$(jq -r .version firefox-ext/package.json); \
	jq --arg v "$$version" '.version = $$v' firefox-ext/manifest.json > firefox-ext/manifest.json.tmp \
	  && mv firefox-ext/manifest.json.tmp firefox-ext/manifest.json; \
	echo ">> Releasing firefox-ext v$$version"; \
	$(MAKE) build-firefox; \
	echo ">> Linting built artifact (errors block the publish)"; \
	( cd firefox-ext && npx web-ext lint --source-dir=dist ); \
	mkdir -p firefox-ext/web-ext-artifacts; \
	src="firefox-ext/web-ext-artifacts/localpass-src-$$version.zip"; \
	ref=$$(git stash create); ref=$${ref:-HEAD}; \
	echo ">> Writing source archive $$src (tracked files only)"; \
	git archive --format=zip -o "$$src" "$$ref"; \
	echo ">> Signing & uploading to AMO (listed)"; \
	( cd firefox-ext && npx web-ext sign --channel listed --source-dir=dist \
	  --upload-source-code "web-ext-artifacts/localpass-src-$$version.zip" \
	  --approval-timeout 0 ); \
	echo ">> Upload accepted — committing the version bump"; \
	git commit firefox-ext/package.json firefox-ext/package-lock.json firefox-ext/manifest.json \
	  -m "chore(ext) release firefox-ext v$$version"

# Clean all build artifacts
clean: clean-cli clean-core clean-firefox

clean-cli:
	$(MAKE) -C cli clean

clean-core:
	rm -rf core/dist

clean-firefox:
	rm -rf firefox-ext/dist
