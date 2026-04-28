package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/nawarian/localpass/cli/internal/config"
	s3pkg "github.com/nawarian/localpass/cli/internal/s3"
	"github.com/nawarian/localpass/cli/internal/store"
	"golang.org/x/term"
)

// stdinReader is a buffered reader for stdin, used by readLine, promptYesNo, and
// readPassword (non-TTY fallback). Tests that swap os.Stdin must call resetStdinReader().
var stdinReader *bufio.Reader

func getStdinReader() *bufio.Reader {
	if stdinReader == nil {
		stdinReader = bufio.NewReader(os.Stdin)
	}
	return stdinReader
}

// resetStdinReader resets the stdin reader. Used by tests after swapping os.Stdin.
func resetStdinReader() {
	stdinReader = nil
}

// readPassword reads a password from the terminal without echoing.
// If stdin is not a terminal, it falls back to reading a line from stdin.
var readPassword = func(fd int) ([]byte, error) {
	if term.IsTerminal(fd) {
		return term.ReadPassword(fd)
	}
	// Fallback for non-TTY (e.g., piped input): read one line from stdin
	line, err := getStdinReader().ReadString('\n')
	if err != nil {
		return nil, err
	}
	return []byte(strings.TrimRight(line, "\n\r")), nil
}

// standardFields are the well-known metadata keys that get dedicated prompts.
var standardFields = map[string]bool{
	"password": true,
	"url":      true,
	"username": true,
	"notes":    true,
}

// osExit is a variable so tests can override it.
var osExit = os.Exit

func main() {
	if len(os.Args) < 2 {
		printUsage()
		osExit(1)
	}

	cmd := os.Args[1]
	args := os.Args[2:]

	switch cmd {
	case "init":
		runInit(args)
	case "configure":
		runConfigure(args)
	case "set":
		runSet(args)
	case "get":
		runGet(args)
	case "list":
		runList(args)
	case "rm":
		runRm(args)
	case "push":
		runPush(args)
	case "pull":
		runPull(args)
	case "help", "--help", "-h":
		printUsage()
		osExit(0)
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", cmd)
		printUsage()
		osExit(1)
	}
}

func printUsage() {
	fmt.Print(`Usage: localpass <command> [<args>]

A FOSS, offline-first password manager.

Commands:
  init          Initialize a new encrypted vault
  configure     Configure S3 sync settings
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
`)
}

// resolveStorePath returns the store path from flag, env var, or default.
// CLI flag takes precedence over env var, which takes precedence over default.
func resolveStorePath(args []string) string {
	if path, ok := parseFlag(args, "--store-path", "-s"); ok && path != "" {
		return path
	}
	if path := os.Getenv("LOCALPASS_STORE_PATH"); path != "" {
		return path
	}
	path, err := config.DefaultStorePath()
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}
	return path
}

// resolveConfigPath returns the config path from flag, env var, or default.
func resolveConfigPath(args []string) string {
	if path, ok := parseFlag(args, "--config-path", "-c"); ok && path != "" {
		return path
	}
	if path := os.Getenv("LOCALPASS_CONFIG_PATH"); path != "" {
		return path
	}
	path, err := config.DefaultConfigPath()
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}
	return path
}

// resolveMasterPassword returns the master password based on the noPrompt flag.
// If noPrompt is true, reads from LOCALPASS_MASTER_PASSWORD env var.
// Otherwise, prompts the user interactively.
func resolveMasterPassword(noPrompt bool, prompt string) (string, error) {
	if noPrompt {
		pass := os.Getenv("LOCALPASS_MASTER_PASSWORD")
		if pass == "" {
			return "", fmt.Errorf("LOCALPASS_MASTER_PASSWORD is not set")
		}
		return pass, nil
	}

	fmt.Print(prompt)
	passBytes, err := readPassword(int(os.Stdin.Fd()))
	fmt.Println()
	if err != nil {
		return "", fmt.Errorf("failed to read password: %w", err)
	}
	return strings.TrimSpace(string(passBytes)), nil
}

// promptYesNo asks the user a yes/no question. Returns true if the user answered "y" or "Y".
func promptYesNo(format string, a ...interface{}) bool {
	fmt.Printf(format, a...)
	line, err := getStdinReader().ReadString('\n')
	if err != nil {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(line), "y")
}

// createStoreIfNotExist loads the vault from the store path, creating an empty one if it doesn't exist.
func loadStoreWithPassword(storePath, masterPassword string) (*store.Vault, error) {
	return store.LoadStore(storePath, masterPassword)
}

// readLine reads a full line from stdin, trimming leading/trailing whitespace.
func readLine() string {
	line, err := getStdinReader().ReadString('\n')
	if err != nil {
		return ""
	}
	return strings.TrimSpace(line)
}

// -- init command -----------------------------------------------------------

func runInit(args []string) {
	storePath := resolveStorePath(args)

	// Check if store already exists
	if _, err := os.Stat(storePath); err == nil {
		if !promptYesNo("A vault already exists. Overwrite? (y/N) ") {
			fmt.Println("Aborted.")
			return
		}
	}

	// Always prompt for master password (init ignores --no-prompt)
	fmt.Print("Enter master password: ")
	passBytes, err := readPassword(int(os.Stdin.Fd()))
	fmt.Println()
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: failed to read password: %v\n", err)
		osExit(1)
	}
	masterPassword := strings.TrimSpace(string(passBytes))

	if masterPassword == "" {
		fmt.Fprintln(os.Stderr, "error: master password cannot be empty")
		osExit(1)
	}

	fmt.Print("Confirm master password: ")
	confirmBytes, err := readPassword(int(os.Stdin.Fd()))
	fmt.Println()
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: failed to read password: %v\n", err)
		osExit(1)
	}
	confirmPassword := strings.TrimSpace(string(confirmBytes))

	if masterPassword != confirmPassword {
		fmt.Fprintln(os.Stderr, "error: passwords do not match")
		osExit(1)
	}

	// Create empty vault and save
	vault := store.NewVault()
	if err := store.SaveStore(storePath, vault, masterPassword); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}

	fmt.Printf("Vault initialised at %s\n", storePath)
}

// -- set command ------------------------------------------------------------

func runSet(args []string) {
	if len(args) < 1 || args[0] == "" || strings.HasPrefix(args[0], "-") {
		fmt.Fprintf(os.Stderr, "Usage: localpass set <key> [flags]\n")
		osExit(1)
	}

	key := args[0]
	flagArgs := args[1:]

	storePath := resolveStorePath(flagArgs)
	noPrompt := hasFlag(flagArgs, "--no-prompt", "")

	// Resolve master password
	masterPassword, err := resolveMasterPassword(noPrompt, "Enter master password: ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}

	// Load vault
	vault, err := loadStoreWithPassword(storePath, masterPassword)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}

	// Check if vault is not initialized (empty vault is fine, but file must exist)
	if _, statErr := os.Stat(storePath); os.IsNotExist(statErr) {
		// If file doesn't exist and vault is empty, it means no init was run
		if len(vault.Entries) == 0 {
			fmt.Fprintln(os.Stderr, "No vault found. Run 'localpass init' first.")
			osExit(1)
		}
	}

	// Get entry fields from flags or interactive prompts
	password, hasPassword := parseFlag(flagArgs, "--password", "-p")
	url, hasURL := parseFlag(flagArgs, "--url", "")
	username, hasUsername := parseFlag(flagArgs, "--username", "")
	notes, hasNotes := parseFlag(flagArgs, "--notes", "")

	// Parse --meta / -m flags (can be repeated: --meta key1=val1 --meta key2=val2)
	metadata := parseMetaFlags(flagArgs)
	hasMetaFlags := len(metadata) > 0

	if !hasPassword {
		fmt.Print("Password: ")
		p, err := readPassword(int(os.Stdin.Fd()))
		fmt.Println()
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: failed to read password: %v\n", err)
			osExit(1)
		}
		password = strings.TrimSpace(string(p))
	}
	if !hasURL {
		fmt.Print("URL (optional): ")
		url = readLine()
	}
	if !hasUsername {
		fmt.Print("Username (optional): ")
		username = readLine()
	}
	if !hasNotes {
		fmt.Print("Notes (optional): ")
		notes = readLine()
	}

	// Check if entry already exists — after standard prompts so the user has
	// context of what they're updating, but before custom metadata to avoid
	// consuming input intended for the confirmation.
	if _, exists := vault.GetEntry(key); exists {
		if !promptYesNo("Entry '%s' already exists. Update? (y/N) ", key) {
			fmt.Println("Aborted.")
			return
		}
	}

	// Store known fields in metadata map
	if metadata == nil {
		metadata = make(map[string]string)
	}
	if password != "" {
		metadata["password"] = password
	}
	if url != "" {
		metadata["url"] = url
	}
	if username != "" {
		metadata["username"] = username
	}
	if notes != "" {
		metadata["notes"] = notes
	}

	// Interactive metadata prompt for custom fields (only if no --meta flags given)
	if !hasMetaFlags {
		fmt.Println("Custom metadata (key=value, one per line). Leave empty to finish.")
		for {
			fmt.Print("  Key: ")
			metaKey := readLine()
			if metaKey == "" {
				break
			}
			// Skip keys that overlap with standard fields (already prompted)
			if _, isStandard := standardFields[metaKey]; isStandard {
				fmt.Printf("  (skipping '%s' — use the dedicated prompt above)\n", metaKey)
				// We still need to consume the value line
				readLine()
				continue
			}
			fmt.Print("  Value: ")
			metaValue := readLine()
			metadata[metaKey] = metaValue
		}
		if len(metadata) > 0 {
			// Count only non-standard keys for the summary
			customCount := 0
			for k := range metadata {
				if _, isStandard := standardFields[k]; !isStandard {
					customCount++
				}
			}
			if customCount > 0 {
				fmt.Printf("  (%d custom field(s) set)\n", customCount)
			}
		}
	}

	now := time.Now()

	existingEntry, exists := vault.GetEntry(key)
	entry := store.Entry{
		Metadata:  metadata,
		CreatedAt: now,
		UpdatedAt: now,
	}

	if exists {
		entry.CreatedAt = existingEntry.CreatedAt
		// Carry over any existing metadata keys not being overwritten
		if entry.Metadata == nil {
			entry.Metadata = make(map[string]string)
		}
		for k, v := range existingEntry.Metadata {
			if _, overwritten := entry.Metadata[k]; !overwritten {
				entry.Metadata[k] = v
			}
		}
	}

	vault.AddEntry(key, entry)

	if err := store.SaveStore(storePath, vault, masterPassword); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}

	configPath := resolveConfigPath(flagArgs)
	autoSyncAfterSave(storePath, configPath, masterPassword)

	fmt.Printf("Entry '%s' saved.\n", key)
}

// -- get command ------------------------------------------------------------

func runGet(args []string) {
	if len(args) < 1 || args[0] == "" || strings.HasPrefix(args[0], "-") {
		fmt.Fprintf(os.Stderr, "Usage: localpass get <key> [flags]\n")
		osExit(1)
	}

	key := args[0]
	flagArgs := args[1:]

	storePath := resolveStorePath(flagArgs)
	noPrompt := hasFlag(flagArgs, "--no-prompt", "")
	display := hasFlag(flagArgs, "--display", "-d")
	showAll := hasFlag(flagArgs, "--all", "-a")

	masterPassword, err := resolveMasterPassword(noPrompt, "Enter master password: ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}

	vault, err := loadStoreWithPassword(storePath, masterPassword)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}

	if _, statErr := os.Stat(storePath); os.IsNotExist(statErr) {
		if len(vault.Entries) == 0 {
			fmt.Fprintln(os.Stderr, "No vault found. Run 'localpass init' first.")
			osExit(1)
		}
	}

	entry, ok := vault.GetEntry(key)
	if !ok {
		fmt.Fprintf(os.Stderr, "Entry '%s' not found.\n", key)
		osExit(1)
	}

	if display || showAll {
		if showAll {
			// Print all key-value pairs sorted, no special formatting
			var allKeys []string
			for k := range entry.Metadata {
				allKeys = append(allKeys, k)
			}
			sort.Strings(allKeys)

			fmt.Printf("Key:        %s\n", key)
			for _, k := range allKeys {
				fmt.Printf("  %-10s %s\n", k+":", entry.Metadata[k])
			}
		} else {
			// Known keys displayed in a fixed order
			knownOrder := []string{"username", "password", "url", "notes"}
			knownLabels := map[string]string{
				"username": "Username",
				"password": "Password",
				"url":      "URL",
				"notes":    "Notes",
			}

			fmt.Printf("Key:        %s\n", key)
			for _, k := range knownOrder {
				if v, ok := entry.Metadata[k]; ok {
					fmt.Printf("%-12s %s\n", knownLabels[k]+":", v)
				}
			}

			// Collect and display any extra (non-standard) metadata keys
			var extraKeys []string
			for k := range entry.Metadata {
				if !standardFields[k] {
					extraKeys = append(extraKeys, k)
				}
			}
			if len(extraKeys) > 0 {
				sort.Strings(extraKeys)
				for _, k := range extraKeys {
					fmt.Printf("  %-10s %s\n", k+":", entry.Metadata[k])
				}
			}
		}

		fmt.Printf("Created:    %s\n", entry.CreatedAt.Format("2006-01-02 15:04:05"))
		fmt.Printf("Updated:    %s\n", entry.UpdatedAt.Format("2006-01-02 15:04:05"))
	} else {
		// Copy password to clipboard
		password := entry.Metadata["password"]
		if err := copyToClipboard(password); err != nil {
			fmt.Fprintf(os.Stderr, "warning: failed to copy to clipboard: %v\n", err)
			if password != "" {
				fmt.Printf("Password: %s\n", password)
			}
		} else {
			fmt.Printf("Password for '%s' copied to clipboard.\n", key)
		}
	}
}

// -- list command -----------------------------------------------------------

func runList(args []string) {
	storePath := resolveStorePath(args)
	noPrompt := hasFlag(args, "--no-prompt", "")
	searchQuery, _ := parseFlag(args, "--search", "-S")

	masterPassword, err := resolveMasterPassword(noPrompt, "Enter master password: ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}

	vault, err := loadStoreWithPassword(storePath, masterPassword)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}

	if _, statErr := os.Stat(storePath); os.IsNotExist(statErr) {
		if len(vault.Entries) == 0 {
			fmt.Fprintln(os.Stderr, "No vault found. Run 'localpass init' first.")
			osExit(1)
		}
	}

	var keys []string
	if searchQuery != "" {
		keys = vault.Search(searchQuery)
	} else {
		keys = vault.ListKeys()
	}

	if len(keys) == 0 {
		fmt.Println("No entries in vault.")
		return
	}

	for _, key := range keys {
		fmt.Println(key)
	}
}

// -- rm command -------------------------------------------------------------

func runRm(args []string) {
	if len(args) < 1 || args[0] == "" || strings.HasPrefix(args[0], "-") {
		fmt.Fprintf(os.Stderr, "Usage: localpass rm <key> [flags]\n")
		osExit(1)
	}

	key := args[0]
	flagArgs := args[1:]

	storePath := resolveStorePath(flagArgs)
	noPrompt := hasFlag(flagArgs, "--no-prompt", "")

	masterPassword, err := resolveMasterPassword(noPrompt, "Enter master password: ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}

	vault, err := loadStoreWithPassword(storePath, masterPassword)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}

	if _, statErr := os.Stat(storePath); os.IsNotExist(statErr) {
		if len(vault.Entries) == 0 {
			fmt.Fprintln(os.Stderr, "No vault found. Run 'localpass init' first.")
			osExit(1)
		}
	}

	if _, exists := vault.GetEntry(key); !exists {
		fmt.Fprintf(os.Stderr, "Entry '%s' not found.\n", key)
		osExit(1)
	}

	if !promptYesNo("Delete entry '%s'? (y/N) ", key) {
		fmt.Println("Aborted.")
		return
	}

	vault.DeleteEntry(key)

	if err := store.SaveStore(storePath, vault, masterPassword); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}

	configPath := resolveConfigPath(flagArgs)
	autoSyncAfterSave(storePath, configPath, masterPassword)

	fmt.Printf("Entry '%s' deleted.\n", key)
}

// -- configure command ------------------------------------------------------

func runConfigure(args []string) {
	configPath := resolveConfigPath(args)

	// Load existing config (or default)
	cfg, err := config.LoadConfig(configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}

	fmt.Println("Configure S3 sync settings.")
	fmt.Println("Press Enter to keep the current value shown in brackets.")
	fmt.Println()

	// Prompt for each field, showing current value as default
	s3Endpoint := promptWithDefault("S3 Endpoint", cfg.S3Endpoint, "")

	s3Region := promptWithDefault("S3 Region", cfg.S3Region, "")
	s3Bucket := promptWithDefault("S3 Bucket", cfg.S3Bucket, "")
	s3Key := promptWithDefault("S3 Key (store path in bucket)", cfg.S3Key, "")

	accessKey := promptWithDefault("AWS Access Key ID", cfg.AWSAccessKeyID, "")
	secretKey := promptWithDefault("AWS Secret Access Key", cfg.AWSSecretAccessKey, "")

	// Auto-sync prompt: show current value as (y/n)
	autoSyncStr := "n"
	if cfg.AutoSync {
		autoSyncStr = "y"
	}
	fmt.Printf("Auto-sync to S3 on mutations [%s] (y/N): ", autoSyncStr)
	line, err := getStdinReader().ReadString('\n')
	autoSyncInput := strings.TrimSpace(line)
	if err == nil && autoSyncInput != "" {
		cfg.AutoSync = strings.EqualFold(autoSyncInput, "y")
	} // else keep existing value

	cfg.S3Endpoint = s3Endpoint
	cfg.S3Region = s3Region
	cfg.S3Bucket = s3Bucket
	cfg.S3Key = s3Key
	cfg.AWSAccessKeyID = accessKey
	cfg.AWSSecretAccessKey = secretKey

	// Show a summary before saving
	fmt.Println()
	fmt.Println("Configuration summary:")
	fmt.Printf("  S3 Endpoint:       %s\n", cfg.S3Endpoint)
	fmt.Printf("  S3 Region:         %s\n", cfg.S3Region)
	fmt.Printf("  S3 Bucket:         %s\n", cfg.S3Bucket)
	fmt.Printf("  S3 Key:            %s\n", cfg.S3Key)
	fmt.Printf("  AWS Access Key ID: %s\n", maskSecret(cfg.AWSAccessKeyID, 8))
	fmt.Printf("  AWS Secret Key:    %s\n", maskSecret(cfg.AWSSecretAccessKey, 4))
	fmt.Printf("  Auto-sync:         %v\n", cfg.AutoSync)

	if !promptYesNo("Save configuration? (y/N) ") {
		fmt.Println("Aborted.")
		return
	}

	if err := config.SaveConfig(configPath, cfg); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}

	fmt.Printf("Configuration saved to %s\n", configPath)
}

// promptWithDefault prompts the user for a value, showing the current/default in brackets.
func promptWithDefault(fieldName, currentValue, defaultHint string) string {
	display := currentValue
	if display == "" {
		display = defaultHint
	}

	fmt.Printf("%s [%s]: ", fieldName, display)
	line, err := getStdinReader().ReadString('\n')
	if err != nil {
		return currentValue
	}
	input := strings.TrimSpace(line)

	if input == "" {
		return currentValue
	}
	return input
}

// maskSecret returns a masked version of a secret for display.
// If keep > 0, shows the last `keep` characters.
func maskSecret(s string, keep int) string {
	if s == "" {
		return "(not set)"
	}
	if keep <= 0 {
		return "******"
	}
	if len(s) <= keep {
		return s
	}
	return strings.Repeat("*", len(s)-keep) + s[len(s)-keep:]
}

// autoSyncAfterSave pushes the vault to S3 if auto-sync is enabled in config.
// It silently skips if config doesn't exist or S3 settings are incomplete.
func autoSyncAfterSave(storePath, configPath, masterPassword string) {
	cfg, err := config.LoadConfig(configPath)
	if err != nil || !cfg.AutoSync {
		return
	}

	// Check that we have enough config to push
	if cfg.S3Bucket == "" || cfg.S3Key == "" {
		return
	}

	accessKey, secretKey, region, endpoint := config.ResolveCredentials(cfg)

	s3c, err := s3pkg.NewClient(s3pkg.Config{
		Endpoint:        endpoint,
		Region:          region,
		Bucket:          cfg.S3Bucket,
		Key:             cfg.S3Key,
		AccessKeyID:     accessKey,
		SecretAccessKey: secretKey,
	})
	if err != nil {
		return
	}

	storeData, err := os.ReadFile(storePath)
	if err != nil {
		return
	}

	if err := s3c.Upload(context.Background(), storeData); err != nil {
		fmt.Fprintf(os.Stderr, "warning: auto-sync to S3 failed: %v\n", err)
		return
	}

	fmt.Println("Vault auto-synced to S3.")
}

// -- push command -----------------------------------------------------------

func runPush(args []string) {
	storePath := resolveStorePath(args)
	configPath := resolveConfigPath(args)
	noPrompt := hasFlag(args, "--no-prompt", "")

	// Override config with CLI flags
	s3Endpoint, hasEndpoint := parseFlag(args, "--s3-endpoint", "")
	s3Region, hasRegion := parseFlag(args, "--s3-region", "")
	flagBucket, hasBucket := parseFlag(args, "--s3-bucket", "")
	flagKey, hasKey := parseFlag(args, "--s3-key", "")
	force := hasFlag(args, "--force", "")

	masterPassword, err := resolveMasterPassword(noPrompt, "Enter master password: ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}

	vault, err := loadStoreWithPassword(storePath, masterPassword)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}

	if _, statErr := os.Stat(storePath); os.IsNotExist(statErr) {
		if len(vault.Entries) == 0 {
			fmt.Fprintln(os.Stderr, "No vault found. Run 'localpass init' first.")
			osExit(1)
		}
	}

	// Load config
	cfg, err := config.LoadConfig(configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}

	accessKey, secretKey, region, endpoint := config.ResolveCredentials(cfg)

	// CLI flags override config and env vars
	if hasEndpoint {
		endpoint = s3Endpoint
	}
	if hasRegion {
		region = s3Region
	}

	s3Bucket := cfg.S3Bucket
	s3Key := cfg.S3Key

	if hasBucket {
		s3Bucket = flagBucket
	}
	if hasKey {
		s3Key = flagKey
	}

	if s3Bucket == "" || s3Key == "" {
		fmt.Fprintln(os.Stderr, "No S3 configuration found. Run 'localpass configure' or set env vars.")
		osExit(1)
	}

	s3c, err := s3pkg.NewClient(s3pkg.Config{
		Endpoint:        endpoint,
		Region:          region,
		Bucket:          s3Bucket,
		Key:             s3Key,
		AccessKeyID:     accessKey,
		SecretAccessKey: secretKey,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}

	ctx := context.Background()

	// Conflict detection
	if !force {
		// Check local file mtime vs remote LastModified
		localInfo, err := os.Stat(storePath)
		if err == nil {
			remoteTime, err := s3c.LastModified(ctx)
			if err == nil && !remoteTime.IsZero() {
				if localInfo.ModTime().Before(remoteTime) {
					if !promptYesNo("Remote vault is newer. Push anyway? (y/N) ") {
						fmt.Println("Aborted.")
						return
					}
				}
			}
		}
	}

	// Read local store file (already encrypted)
	storeData, err := os.ReadFile(storePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}

	if err := s3c.Upload(ctx, storeData); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}

	fmt.Printf("Vault pushed to s3://%s/%s\n", s3Bucket, s3Key)
}

// -- pull command -----------------------------------------------------------

func runPull(args []string) {
	storePath := resolveStorePath(args)
	configPath := resolveConfigPath(args)
	noPrompt := hasFlag(args, "--no-prompt", "")

	s3Endpoint, hasEndpoint := parseFlag(args, "--s3-endpoint", "")
	s3Region, hasRegion := parseFlag(args, "--s3-region", "")
	flagBucket, hasBucket := parseFlag(args, "--s3-bucket", "")
	flagKey, hasKey := parseFlag(args, "--s3-key", "")
	force := hasFlag(args, "--force", "")

	masterPassword, err := resolveMasterPassword(noPrompt, "Enter master password: ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}

	// Load config
	cfg, err := config.LoadConfig(configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}

	accessKey, secretKey, region, endpoint := config.ResolveCredentials(cfg)

	if hasEndpoint {
		endpoint = s3Endpoint
	}
	if hasRegion {
		region = s3Region
	}

	s3Bucket := cfg.S3Bucket
	s3Key := cfg.S3Key

	if hasBucket {
		s3Bucket = flagBucket
	}
	if hasKey {
		s3Key = flagKey
	}

	if s3Bucket == "" || s3Key == "" {
		fmt.Fprintln(os.Stderr, "No S3 configuration found. Run 'localpass configure' or set env vars.")
		osExit(1)
	}

	s3c, err := s3pkg.NewClient(s3pkg.Config{
		Endpoint:        endpoint,
		Region:          region,
		Bucket:          s3Bucket,
		Key:             s3Key,
		AccessKeyID:     accessKey,
		SecretAccessKey: secretKey,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}

	ctx := context.Background()

	// Check if remote exists
	exists, err := s3c.ObjectExists(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}
	if !exists {
		fmt.Fprintln(os.Stderr, "No vault found on remote.")
		osExit(1)
	}

	// Conflict detection
	if !force {
		localInfo, err := os.Stat(storePath)
		if err == nil {
			remoteTime, err := s3c.LastModified(ctx)
			if err == nil && !remoteTime.IsZero() {
				if localInfo.ModTime().After(remoteTime) {
					if !promptYesNo("Local vault is newer. Pulling will overwrite it. Continue? (y/N) ") {
						fmt.Println("Aborted.")
						return
					}
				}
			}
		}
	}

	// Download from S3
	remoteData, err := s3c.Download(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}

	// Verify we can decrypt with the given master password
	if _, err := store.Decrypt(remoteData, masterPassword); err != nil {
		fmt.Fprintf(os.Stderr, "error: remote vault cannot be decrypted with the given master password: %v\n", err)
		osExit(1)
	}

	// Write to local store atomically
	dir := filepath.Dir(storePath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}

	tmpPath := storePath + ".tmp"
	if err := os.WriteFile(tmpPath, remoteData, 0600); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}
	if err := os.Rename(tmpPath, storePath); err != nil {
		os.Remove(tmpPath)
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		osExit(1)
	}

	fmt.Printf("Vault pulled from s3://%s/%s\n", s3Bucket, s3Key)
}

// Helper to check if a flag exists in args and optionally return its value.
// Supports both --flag value and --flag=value forms.
func parseFlag(args []string, long, short string) (string, bool) {
	for i, a := range args {
		switch {
		case a == long || (short != "" && a == short):
			if i+1 < len(args) {
				return args[i+1], true
			}
			return "", true
		case strings.HasPrefix(a, long+"="):
			return strings.TrimPrefix(a, long+"="), true
		case short != "" && strings.HasPrefix(a, short) && len(a) > len(short):
			return a[len(short):], true
		}
	}
	return "", false
}

func hasFlag(args []string, long, short string) bool {
	for _, a := range args {
		if a == long || (short != "" && a == short) {
			return true
		}
		if strings.HasPrefix(a, long+"=") {
			return true
		}
	}
	return false
}

// parseMetaFlags extracts all --meta / -m key=value pairs from args.
func parseMetaFlags(args []string) map[string]string {
	result := make(map[string]string)
	for i := 0; i < len(args); i++ {
		a := args[i]
		var kv string
		switch {
		case a == "--meta" || a == "-m":
			if i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
				kv = args[i+1]
				i++ // skip the value
			}
		case strings.HasPrefix(a, "--meta="):
			kv = strings.TrimPrefix(a, "--meta=")
		case strings.HasPrefix(a, "-m") && len(a) > 2:
			kv = a[2:]
		default:
			continue
		}
		if idx := strings.Index(kv, "="); idx > 0 {
			key := kv[:idx]
			val := kv[idx+1:]
			result[key] = val
		}
	}
	return result
}

// copyToClipboard copies text to the system clipboard.
func copyToClipboard(text string) error {
	// Determine which clipboard command to use based on platform
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("pbcopy")
	case "linux":
		// Try xclip first, then xsel
		if _, err := exec.LookPath("xclip"); err == nil {
			cmd = exec.Command("xclip", "-selection", "clipboard")
		} else if _, err := exec.LookPath("xsel"); err == nil {
			cmd = exec.Command("xsel", "--clipboard", "--input")
		} else {
			return fmt.Errorf("neither xclip nor xsel found")
		}
	case "windows":
		cmd = exec.Command("clip")
	default:
		return fmt.Errorf("unsupported platform: %s", runtime.GOOS)
	}

	cmd.Stdin = strings.NewReader(text)
	return cmd.Run()
}
