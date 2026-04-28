# LocalPass Features

LocalPass is a FOSS, offline-first password manager with two components:
a **command line application (Go)** for managing passwords locally/remotely,
and a **Firefox extension** for browser integration.

---

## 1. Core Functionality

Each component (CLI and Firefox extension) is **fully standalone** — they share the same concept of a password vault but manage their own storage independently.

### 1.1 Set Password
- Store a new password entry with a unique identifier/key.
- Each entry must contain at minimum: key (name/label), password, and optional metadata (e.g., URL, username, notes).
- Updating an existing key overwrites its data.

### 1.2 Retrieve Password
- Look up a password entry by its key and return the decrypted data.
- Support listing all stored keys (without revealing passwords).
- Support searching/filtering entries by key or metadata.

### 1.3 Delete Password
- Remove a password entry by its key.

---

## 2. Data Storage

### 2.1 CLI — Encrypted JSON File
- All secrets are stored in a local encrypted JSON file (e.g., `~/.localpass/store.json`).
- The file is encrypted using strong symmetric encryption (e.g., AES-256-GCM).
- The encryption key is derived from a master password using a key derivation function (e.g., Argon2id or PBKDF2).
- The plaintext JSON structure is never written to disk.
- The encrypted file is re-written atomically on every write operation to prevent corruption.

### 2.2 Firefox Extension — Browser Storage API
- All secrets are stored inside the browser using `browser.storage.local` (or `chrome.storage.local`).
- Data is encrypted before being written to storage, using the Web Crypto API (e.g., AES-GCM).
- The encryption key is derived from a master password using PBKDF2 via the Web Crypto API.
- The extension is fully client-side — no external daemon, no network calls, no filesystem access.
- If the user clears browser data, the vault is gone (backup via export/import is a future feature).

### 2.3 Shared Data Format (Plaintext, in memory)
Both components use the same plaintext schema internally, making it possible to implement cross-component sync later:

---

## 3. S3 Sync (Command Line Application)

### 3.1 Connect to S3-Compatible Storage
- Sync the encrypted store file to any S3-compatible storage (AWS S3, MinIO, Backblaze B2, DigitalOcean Spaces, etc.).
- Support custom S3 endpoints (`--s3-endpoint` or config).
- Support configurable region, bucket, and path/prefix for the remote file.

### 3.2 Push / Pull
- **Push**: Upload the local encrypted file to the configured S3 bucket.
- **Pull**: Download the remote encrypted file from S3, merging or overwriting the local store.
- Handle conflicts gracefully (e.g., last-write-wins or prompt user).

### 3.3 Configuration
- S3 credentials stored in a local config file (not in the encrypted store).
- Config file is plaintext (e.g., `~/.localpass/config.json`) containing:
  - S3 endpoint URL
  - S3 region
  - S3 bucket name
  - S3 object key / path
  - AWS access key ID (or reference to env var)
  - AWS secret access key (or reference to env var)
- Support reading credentials from environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`) as fallback.

---

## 4. Firefox Extension

### 4.1 Browser Integration
- Auto-fill credentials on supported websites.
- Save new credentials when logging into a site for the first time.
- Toolbar popup for quick search and copy of passwords.
- Lock/unlock the vault (master password prompt).
- Vault locks automatically after a configurable timeout or when browser closes.

---

## 5. Command Line Interface (Go)

### 5.1 Commands
| Command       | Description                                  |
|---------------|----------------------------------------------|
| `localpass init`      | Initialize a new encrypted store             |
| `localpass set <key>` | Store or update a password entry (prompts for password and optionally URL, username, notes) |
| `localpass get <key>` | Retrieve and display a password entry        |
| `localpass list`       | List all stored keys                         |
| `localpass rm <key>`   | Delete a password entry                      |
| `localpass push`       | Upload encrypted store to S3                 |
| `localpass pull`       | Download encrypted store from S3             |
| `localpass import`     | Import entries from browser extension export  |
| `localpass export`     | Export vault to a format the extension can import |

### 5.2 Flags
- `--store-path` / `-s`: Path to the encrypted store file.
- `--config-path` / `-c`: Path to the config file.
- `--s3-endpoint`: Custom S3 endpoint URL.
- `--s3-region`: S3 region.
- `--s3-bucket`: S3 bucket name.
- `--s3-key`: S3 object key.

### 5.3 Environment Variables
- `LOCALPASS_STORE_PATH`
- `LOCALPASS_CONFIG_PATH`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_REGION`
- `S3_ENDPOINT`

---

## 6. Security Considerations

- Master password is never stored on disk or in browser storage.
- Encryption key is derived on-the-fly from the master password.
- All cryptographic operations happen client-side, in memory.
- The Firefox extension never sends secrets over the network — it is entirely local to the browser.
- S3 transport is encrypted via HTTPS/TLS.
- Code is open source (GPLv3) and auditable.

---

## 7. Cross-Component Sync (Future)

Currently the CLI and Firefox extension are **independent**. In the future, a sync mechanism could bridge them:

- **Export/Import**: The CLI exports the vault to an encrypted file; the extension imports it (and vice versa).
- **Optional daemon bridge**: A future `localpass serve` command could expose a local HTTP endpoint that the extension talks to for direct sync.
- **S3 as shared backend**: Both components could independently sync to the same S3 bucket, using the shared data format.

---

## 8. Future / Out of Scope (for now)

- WebDAV or other remote storage backends.
- Mobile applications.
- Built-in password generator (will be added later).
- TOTP / 2FA support.
- Shared vaults / multi-user.
- Browser sync via Firefox Sync (use S3 as the sync layer).
