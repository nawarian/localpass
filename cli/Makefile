.PHONY: build test clean

# Build the binary
build:
	@mkdir -p bin
	go build -ldflags="-s -w" -o bin/localpass ./cmd/localpass/

# Run all tests
test:
	go test ./...

# Clean built binary and temp files
clean:
	rm -rf bin/

# Run go mod tidy
tidy:
	go mod tidy

# Verify dependencies
verify:
	go mod verify
