# LocalPass CLI — TODO

This file contains a structured task list for building the **command line application** (Go) component of LocalPass. The Firefox extension is **out of scope** for now.

Each task includes:
- **Description & Context** — what needs to be built and why.
- **Acceptance Criteria** — how to know the task is done.
- **Test Cases** — specific scenarios to verify.

---

## Prerequisites

- [Go 1.22+](https://go.dev/dl/) installed.
- `$GOPATH` or Go workspace configured.
- Familiarity with Go modules, `crypto/aes`, `crypto/rand`, `encoding/json`, `os`, `flag` (or `cobra`).

---

## T1 — Project Scaffolding

**Description & Context**
Create the Go module and directory structure for the CLI application. Place everything under a `cli/` directory since the repo root is a monorepo. Set up a `main.go` entry point and a basic command dispatcher.

**Directory layout (Go community standard):**
```
cli/
├── cmd/
│   └── localpass/
│       └── main.go      # Entry point, command routing
├── internal/
│   ├── store/
│   │   ├── store.go     # Vault data structures, CRUD operations
│   │   ├── crypto.go    # Encrypt / decrypt helpers
│   │   └── store_test.go
│   ├── s3/
│   │   └── s3.go        # S3 sync client
│   └── config/
│       └── config.go    # Config file read/write
├── go.mod
└── go.sum
```

- `cmd/localpass/main.go` is the only `package main` — the binary entry point.
- `internal/` packages are not importable by external modules, enforcing encapsulation.
- Each command (init, set, get, list, rm, push, pull) lives in its own file under `cmd/localpass/`.

**Acceptance Criteria**
1. `go build ./...` succeeds inside `cli/`.
2. Running `go run .` or the built binary prints usage text (no subcommand given).
3. Running `go run . init` prints "not implemented" (stub).

**Test Cases**
- Run `go build ./...` — must exit 0.
- Run the binary with no args — must print a help/usage message and exit non-zero.
- Run the binary with an unknown command — must print an error and exit non-zero.

---

## T2 — Vault Data Structures (In-Memory Model)

**Description & Context**
Define the plaintext data structures used to represent the password vault in memory. These are shared across all commands and will be serialised to/from encrypted JSON on disk.

**Structures:**
- `Vault` — top-level container: `Version int`, `Entries map[string]Entry`.
- `Entry` — single password entry: `Password string`, `URL string`, `Username string`, `Notes string`, `CreatedAt time.Time`, `UpdatedAt time.Time`.
- `Vault.Version` is always `1` for now.
- Helper methods: `AddEntry(key, entry)`, `GetEntry(key) (Entry, bool)`, `DeleteEntry(key)`, `ListKeys() []string`, `Search(query) []string`.

**Acceptance Criteria**
1. All structs and methods compile.
2. `Vault` can be serialised to/from JSON (plaintext, for testing).
3. CRUD operations on `Vault` work correctly.

**Test Cases**
- Create empty vault, add entry, get entry back — must match.
- Add entry, delete it, get it back — must return `false`.
- Add two entries, `ListKeys()` — must return both keys.
- `Search("git")` with entries "github", "gitlab", "email" — must return "github" and "gitlab".
- JSON round-trip: marshal vault with 1 entry, unmarshal — must produce identical struct.

---

## T3 — Encryption & Decryption (Crypto Layer)

**Description & Context**
Implement the encryption layer that protects the vault file on disk.

**Specs:**
- **Key derivation**: Use **Argon2id** (via `golang.org/x/crypto/argon2`). Parameters: `time=3`, `memory=64*1024` (64 MB), `threads=4`, key length = 32 bytes.
- **Symmetric encryption**: **AES-256-GCM** (via `crypto/aes` + `crypto/cipher`). Generate a random 12-byte nonce per encryption.
- **File format on disk**: `nonce (12 bytes) || ciphertext || auth_tag`. The auth tag is appended by GCM.
- Functions: `Encrypt(plaintext []byte, masterPassword string) ([]byte, error)` and `Decrypt(ciphertext []byte, masterPassword string) ([]byte, error)`.
- A **salt** is also required for Argon2. Store it as the **first 16 bytes** of the output file, before the nonce. So final layout: `salt (16) || nonce (12) || ciphertext || tag`.
- The salt is randomly generated on each encryption.

**Acceptance Criteria**
1. `Encrypt` produces different output each time for the same input (due to random salt + nonce).
2. `Decrypt(Encrypt(data, pass), pass)` returns the original `data`.
3. `Decrypt` with wrong password returns an error.
4. `Decrypt` with a corrupted ciphertext returns an error.

**Test Cases**
- Encrypt "hello", decrypt with same password — must return "hello".
- Encrypt "hello", decrypt with wrong password — must error.
- Encrypt twice with same input and same password — outputs must differ (salts differ).
- Decrypt nil/empty data — must error.
- Decrypt data with wrong length (< 28 bytes for salt+nonce) — must error.

---

## T4 — Store File Read/Write (Persistent Vault)

**Description & Context**
Implement the functions to load and save the encrypted vault to/from disk. Uses the crypto layer from T3.

**Functions:**
- `LoadStore(path string, masterPassword string) (*Vault, error)` — reads file, decrypts, JSON-unmarshal.
- `SaveStore(path string, vault *Vault, masterPassword string) error` — JSON-marshal, encrypts, writes atomically.
- **Atomic write**: Write to a `.tmp` file first, then `os.Rename` to the final path.
- If the file doesn't exist yet (first `init`), `LoadStore` returns an empty `Vault`.
- On `SaveStore`, create parent directories if they don't exist (`os.MkdirAll`).

**Acceptance Criteria**
1. Save a vault, load it back — the loaded vault is identical to the original.
2. Writing is atomic: if the process crashes during write, the old file remains intact.
3. Loading a non-existent file returns an empty vault (no error).
4. Loading a corrupted file returns an error.

**Test Cases**
- Create vault, add 1 entry, save to temp path, load from same path — entry matches.
- Save to a path in a non-existent directory — directory is created, file saved successfully.
- Manually corrupt the file contents — `LoadStore` returns error.
- Write large vault (1000 entries) — round-trip succeeds in < 1 second.

---

## T5 — `init` Command

**Description & Context**
Initialise a new encrypted password store.

**Behaviour:**
- `localpass init` — prompts the user for a **master password** (and a confirmation). If passwords don't match, retry.
- Uses `terminal.ReadPassword` (or similar) to avoid echoing the password.
- Creates an empty vault (no entries) and saves it to the default store path (`~/.localpass/store.json`).
- If the store already exists, prompts: "A vault already exists. Overwrite? (y/N)". If not confirmed, abort.
- After init, prints: "Vault initialised at ~/.localpass/store.json".

**Flags:**
- `--store-path` / `-s` — override default store path (can also be set via `LOCALPASS_STORE_PATH` env var).

**Environment variables:**
- `LOCALPASS_STORE_PATH` — overrides the default store path. CLI flag `--store-path` takes precedence over this env var.

**Acceptance Criteria**
1. Running `localpass init` creates a non-empty encrypted file at the default path.
2. Running `localpass init` with `LOCALPASS_STORE_PATH` set creates the file at the env var path.
3. Running `localpass init` with both `--store-path` and `LOCALPASS_STORE_PATH` set — the CLI flag wins.
4. The created file starts with a 16-byte salt (binary, not JSON).
5. Overwriting an existing vault requires confirmation.
6. The master password is never echoed or stored in bash history.

**Test Cases**
- Run `init` with a temp store path, then run `localpass list -s <path>` — lists 0 entries.
- Run `init` with `LOCALPASS_STORE_PATH=/tmp/alt-store.json` — file created at `/tmp/alt-store.json`.
- Run `init` with both `LOCALPASS_STORE_PATH=/tmp/alt.json` and `--store-path /tmp/explicit.json` — file created at `/tmp/explicit.json`.
- Run `init` twice on the same path — second run prompts for confirmation, "n" aborts without overwriting.
- Inspect the created file with `xxd` or `head -c 16` — first 16 bytes are non-zero (salt).
- Run `init` with mismatched password confirmation — should error and not create a file.

---

## T6 — `set` Command

**Description & Context**
Store a new password entry or update an existing one.

**Behaviour:**
- `localpass set <key>` — prompts for the master password, then for: password (masked), URL (optional), username (optional), notes (optional).
- If an entry with `<key>` already exists, prints: "Entry '<key>' already exists. Update? (y/N)". If not confirmed, abort.
- Saves the entry to the vault with `CreatedAt` (first time) and `UpdatedAt` (always current time).
- Prints: "Entry '<key>' saved."

**Flags:**
- `--store-path` / `-s` — store path override (can also be set via `LOCALPASS_STORE_PATH` env var).
- `--password` / `-p` — provide password inline (for scripting; unsafe, but useful for testing).
- `--url` — URL inline.
- `--username` — username inline.
- `--notes` — notes inline.
- `--no-prompt` — do not prompt for master password; read it from `LOCALPASS_MASTER_PASSWORD` env var (intended for scripting).

**Error handling:**
- If store doesn't exist (not initialised), print: "No vault found. Run 'localpass init' first." and exit non-zero.

**Acceptance Criteria**
1. Entry is saved and can be retrieved with `localpass get <key>`.
2. Updating an existing key overwrites data and updates `UpdatedAt`.
3. Using `--password` flag stores the given password without interactive prompt.
4. Using `--no-prompt` reads master password from env var.

**Test Cases**
- `init`, then `set mykey` — entry exists.
- `set mykey` again — prompts for confirmation, "y" updates, "n" aborts.
- `set key1` with `--password secret --url https://x.com` — entry has correct password and URL.
- `set key2` with `--no-prompt` and `LOCALPASS_MASTER_PASSWORD=pass` — succeeds without interactive prompt.
- `set key` on a non-initialised store — prints error and exits non-zero.

---

## T7 — `get` Command

**Description & Context**
Retrieve and display a stored password entry.

**Behaviour:**
- `localpass get <key>` — prompts for master password, decrypts vault, displays the entry.
- Display format:
  ```
  Key:        github
  Username:   user@example.com
  Password:   supersecret
  URL:        https://github.com
  Notes:      Personal account
  Created:    2026-04-28 12:00:00
  Updated:    2026-04-28 12:30:00
  ```
- By default, the password is **copied to clipboard** (platform-specific: `xclip`/`xsel` on Linux, `pbcopy` on macOS, `clip` on Windows) instead of printed. The CLI prints: "Password for 'github' copied to clipboard."
- **Flag** `--display` / `-d` — show the password in the terminal instead of copying.
- If the key doesn't exist, print: "Entry '<key>' not found." and exit non-zero.
- If the vault doesn't exist, print: "No vault found. Run 'localpass init' first." and exit non-zero.

**Acceptance Criteria**
1. Existing entry is displayed (or password copied to clipboard).
2. Non-existing key prints error and exits non-zero.
3. Non-existing vault prints error and exits non-zero.
4. `--display` flag shows password in terminal instead of clipboard.
5. Clipboard copy only contains the password (no extra whitespace).

**Test Cases**
- `init`, `set key1`, `get key1` — password copied to clipboard.
- `get key1 --display` — password printed in terminal.
- `get nonexistent` — "Entry 'nonexistent' not found." and exit non-zero.
- `get key1` on non-initialised store — "No vault found." and exit non-zero.

---

## T8 — `list` Command

**Description & Context**
List all stored keys without revealing their passwords.

**Behaviour:**
- `localpass list` — prompts for master password, decrypts vault, prints all keys.
- Output format (one per line):
  ```
  github
  gitlab
  email
  ```
- If the vault is empty, print: "No entries in vault." and exit 0.
- If the vault doesn't exist, print: "No vault found. Run 'localpass init' first." and exit non-zero.

**Flags:**
- `--search` / `-s <query>` — filter keys that contain the query string (case-insensitive).

**Acceptance Criteria**
1. Lists all keys after init and set.
2. Empty vault prints "No entries in vault.".
3. Non-existing vault prints error.
4. `--search` filters results correctly.

**Test Cases**
- `init`, `set a`, `set b`, `set abc`, `list` — prints "a", "b", "abc" (order not important).
- `list --search a` — prints "a", "abc".
- `list --search xyz` — prints nothing (or empty).
- Empty vault — prints "No entries in vault.".

---

## T9 — `rm` Command

**Description & Context**
Delete a password entry by key.

**Behaviour:**
- `localpass rm <key>` — prompts for master password, decrypts vault.
- If key exists, prompts: "Delete entry '<key>'? (y/N)". If not confirmed, abort.
- Deletes the entry, saves vault, prints: "Entry '<key>' deleted."
- If key doesn't exist, prints: "Entry '<key>' not found." and exits non-zero.
- If vault doesn't exist, prints: "No vault found. Run 'localpass init' first." and exits non-zero.

**Acceptance Criteria**
1. Deleting an existing entry removes it from the vault.
2. Attempting to delete a non-existing key prints error.
3. Deletion requires confirmation ("y").

**Test Cases**
- `init`, `set key1`, `rm key1` (confirm), `list` — no entries.
- `rm key1` again — "Entry 'key1' not found."
- `rm key1` without confirming — entry still exists.
- `rm key1` on non-initialised store — "No vault found."

---

## T10 — Config File for S3 Settings

**Description & Context**
Implement a plaintext JSON config file (`~/.localpass/config.json`) to store S3 connection settings. This config is **not encrypted** — it only contains connection details, no secrets (credentials may be loaded from env vars instead).

**Config structure:**
```json
{
  "s3_endpoint": "https://s3.us-east-1.amazonaws.com",
  "s3_region": "us-east-1",
  "s3_bucket": "my-localpass-vault",
  "s3_key": "store.json",
  "aws_access_key_id": "",
  "aws_secret_access_key": ""
}
```

**Functions:**
- `LoadConfig(path string) (*Config, error)` — reads and parses the config file. If file doesn't exist, returns defaults (empty fields).
- `SaveConfig(path string, config *Config) error` — writes config to disk.
- `ResolveCredentials(config *Config) (accessKey, secretKey, region string)` — merges config values with environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_ENDPOINT`). Env vars take precedence.

**Acceptance Criteria**
1. Config file can be read and written.
2. Missing config file returns default config (empty strings), not an error.
3. `ResolveCredentials` correctly prefers env vars over config file values.
4. Setting `aws_access_key_id` to empty string in config and providing `AWS_ACCESS_KEY_ID` env var — the env var value is used.

**Test Cases**
- Write config, read it back — all fields match.
- Read non-existent config — returns default config with empty fields.
- Set `s3_endpoint` in config to "https://minio.example.com", set `S3_ENDPOINT` env var to "https://custom.example.com" — ResolveCredentials returns the env var value.
- Set `AWS_REGION` env var but no config file — `ResolveCredentials` returns the env var value.

---

## T11 — `push` Command (S3 Sync)

**Description & Context**
Upload the local encrypted vault file to an S3-compatible bucket.

**Behaviour:**
- `localpass push` — prompts for master password, encrypts the vault, reads config, uploads to S3.
- Uses the **AWS SDK for Go v2** (`github.com/aws/aws-sdk-go-v2`) with configurable endpoint.
- In the absence of any config or env vars, print: "No S3 configuration found. Configure via 'localpass config' or env vars." and exit non-zero.
- On success, print: "Vault pushed to s3://<bucket>/<key>".
- On failure (network, auth), print the error and exit non-zero.

**Flags:**
- `--store-path` / `-s` — store path (can also be set via `LOCALPASS_STORE_PATH` env var).
- `--config-path` / `-c` — config path (can also be set via `LOCALPASS_CONFIG_PATH` env var).
- `--s3-endpoint`, `--s3-region`, `--s3-bucket`, `--s3-key` — override any config/env values.
- `--force` — skip confirmation if the remote file is newer than the local file.

**Conflict detection:**
- Before uploading, fetch the remote file's `LastModified` timestamp (via HEAD request).
- If local file's `mtime` is older than remote's `LastModified`, warn: "Remote vault is newer. Push anyway? (y/N)". Default is no.
- `--force` skips this check.

**Acceptance Criteria**
1. Uploads the encrypted store to the configured S3 bucket.
2. Custom endpoint works (e.g., MinIO at `http://localhost:9000`).
3. Conflict warning triggers if remote is newer.
4. `--force` skips the conflict warning.

**Test Cases**
- Unit test: mock S3 client, verify `PutObject` is called with the correct bucket and key.
- Integration test: run a MinIO Docker container, push to it — file exists in the bucket.
- Integration test: set remote file's `LastModified` to future — push warns and aborts unless `--force`.
- Push without config — "No S3 configuration found." error.
- Push with `--s3-endpoint http://localhost:9000 --s3-region us-east-1 --s3-bucket test --s3-key vault.json` — uploads to specified endpoint (all flags provided).

---

## T12 — `pull` Command (S3 Sync)

**Description & Context**
Download the encrypted vault file from S3 and replace the local vault.

**Behaviour:**
- `localpass pull` — prompts for master password, downloads from S3, saves to local store path.
- On success, print: "Vault pulled from s3://<bucket>/<key>".
- On failure (network, auth, file not found on remote), print error and exit non-zero.
- If remote file doesn't exist on S3, print: "No vault found on remote." and exit non-zero.

**Flags:**
- Same as `push`: `--store-path`, `--config-path`, `--s3-endpoint`, `--s3-region`, `--s3-bucket`, `--s3-key`.
- All path flags also accept the corresponding env vars (`LOCALPASS_STORE_PATH`, `LOCALPASS_CONFIG_PATH`).
- `--force` — skip confirmation if local vault is newer.

**Conflict detection:**
- Before downloading, check local file's `mtime` vs remote's `LastModified`.
- If local is newer, warn: "Local vault is newer. Pulling will overwrite it. Continue? (y/N)". Default is no.
- `--force` skips this check.

**Acceptance Criteria**
1. Downloads the encrypted store from S3 and saves it locally.
2. Custom endpoint works.
3. Conflict warning triggers if local is newer.
4. `--force` skips conflict warning.
5. Remote file not found prints a clear error.

**Test Cases**
- Unit test: mock S3 client, verify `GetObject` is called with correct bucket and key, local file is written.
- Integration test: push to MinIO, delete local file, pull — local file exists and matches remote.
- Pull when local is newer — warns and aborts unless `--force`.
- Pull from an S3 path where no file exists — "No vault found on remote." error.

---

## T13 — Master Password Management

**Description & Context**
Every command that touches the vault needs the master password. Implement a consistent, reusable approach across all commands.

**Priority for resolving the master password:**
1. If `--no-prompt` flag is set, read from `LOCALPASS_MASTER_PASSWORD` env var.
2. Otherwise, prompt the user interactively using `terminal.ReadPassword`.

**Helper function:**
- `resolveMasterPassword(noPrompt bool) (string, error)` — returns the password or an error.
- If `--no-prompt` is set but the env var is empty, error: "LOCALPASS_MASTER_PASSWORD is not set."

**Interactions with other commands:**
- `init` — always prompts (env var is not used for init, to avoid scripting accidental overwrites).
- `set`, `get`, `list`, `rm`, `push`, `pull` — uses the standard resolution (env var or prompt).

**Acceptance Criteria**
1. All protected commands (set, get, list, rm, push, pull) accept `--no-prompt` and read master password from env var.
2. `init` always ignores `--no-prompt` and always prompts interactively.
3. If `--no-prompt` is used and env var is missing, a clear error is printed.

**Test Cases**
- `set key --no-prompt` without env var — error: "LOCALPASS_MASTER_PASSWORD is not set."
- `set key --no-prompt` with env var set — succeeds.
- `init --no-prompt` — still prompts interactively (no env var reading).
- `get key` without `--no-prompt` — prompts interactively.

---

## T14 — Help & Usage Output

**Description & Context**
Provide a clean, user-friendly help text when running `localpass --help`, `localpass <cmd> --help`, or any unrecognised input.

**Behaviour:**
- `localpass` or `localpass --help` prints:
  ```
  Usage: localpass <command> [<args>]

  A FOSS, offline-first password manager.

  Commands:
    init          Initialize a new encrypted vault
    set <key>     Store or update a password entry
    get <key>     Retrieve a password entry
    list          List all stored keys
    rm <key>      Delete a password entry
    push          Upload vault to S3
    pull          Download vault from S3
    help          Show this help message

  Flags:
    --store-path, -s   Path to encrypted store file (default: ~/.localpass/store.json, env: LOCALPASS_STORE_PATH)
    --config-path, -c  Path to config file (default: ~/.localpass/config.json, env: LOCALPASS_CONFIG_PATH)
    --help, -h         Show this help message
  ```
- `localpass set --help` prints subcommand-specific help:
  ```
  Usage: localpass set <key> [flags]

  Store or update a password entry.

  Flags:
    --password, -p   Password (inline, for scripting)
    --url            URL for the entry
    --username       Username for the entry
    --notes          Notes for the entry
    --no-prompt      Read master password from LOCALPASS_MASTER_PASSWORD env var
    --store-path, -s Path to encrypted store file (env: LOCALPASS_STORE_PATH)
  ```

**Acceptance Criteria**
1. Running `localpass` prints the usage text and exits non-zero.
2. Running `localpass --help` prints the same usage text and exits 0.
3. Running `localpass set --help` prints subcommand help.
4. Running `localpass unknown` prints "unknown command: unknown" and exits non-zero.

**Test Cases**
- `localpass` — prints usage, exit code 1.
- `localpass --help` — prints usage, exit code 0.
- `localpass init --help` — prints init-specific help.
- `localpass bogus` — prints error, exit code 1.

---

## T15 — Dependency Management & Build

**Description & Context**
Ensure the project is properly set up with all required Go dependencies and a build script.

**Dependencies:**
- `golang.org/x/crypto` — for Argon2id.
- `github.com/aws/aws-sdk-go-v2` — S3 client.
- `github.com/aws/aws-sdk-go-v2/config` — AWS config loader.
- `github.com/aws/aws-sdk-go-v2/service/s3` — S3 service.
- `golang.org/x/term` — for terminal password reading.

**Scripts (in `cli/Makefile` or just documented):**
- `make build` — builds the binary to `cli/bin/localpass` (from `cmd/localpass/main.go`).
- `make test` — runs `go test ./...`.
- `make clean` — removes the built binary.

**Acceptance Criteria**
1. `make build` produces a working binary.
2. `make test` passes all tests.
3. `go mod tidy` runs without errors.
4. The binary is statically linked (runs on systems without Go installed).

**Test Cases**
- Run `make build` — binary exists at `cli/bin/localpass`.
- Run the built binary with `--help` — output matches expected usage.
- Run `make test` — all tests pass (exit code 0).
- `go mod verify` — passes.

---

## Legend

- Unit tests should go in `*_test.go` files alongside the code.
- Integration tests (S3) should be tagged with `//go:build integration` and run separately.
- All prompts involving "y/N" should default to **No** (capital N), requiring explicit "y" or "Y" to proceed.
- Environment variable precedence: CLI flags > env vars > config file values.
