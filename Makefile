.PHONY: all build build-cli build-core build-firefox package-firefox clean clean-cli clean-core clean-firefox icons

all: build

# Build everything
build: build-core build-cli build-firefox

# Build the Go CLI application
build-cli:
	$(MAKE) -C cli build

# Build the shared TypeScript core library
build-core:
	cd core && npm run build

# Generate extension icons from core/logo.svg.
# AMO requires square icons; logo.svg is not square, so we pad with a
# transparent background after resizing to keep aspect ratio.
icons:
	convert core/logo.svg -resize 48x48 -background none -gravity center -extent 48x48 firefox-ext/icons/icon-48.png
	convert core/logo.svg -resize 96x96 -background none -gravity center -extent 96x96 firefox-ext/icons/icon-96.png

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

# Clean all build artifacts
clean: clean-cli clean-core clean-firefox

clean-cli:
	$(MAKE) -C cli clean

clean-core:
	rm -rf core/dist

clean-firefox:
	rm -rf firefox-ext/dist
