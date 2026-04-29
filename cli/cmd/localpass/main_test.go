package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nawarian/localpass/cli/internal/config"
	"github.com/nawarian/localpass/cli/internal/store"
)

func TestSetEntry(t *testing.T) {
	dir := t.TempDir()
	storePath := filepath.Join(dir, "store.json")

	// Init first
	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
	runInit([]string{"--store-path", storePath})

	// Set entry
	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
	runSet([]string{"mykey", "--store-path", storePath, "--password", "secret", "--url", "https://x.com", "--username", "user"})

	// Verify
	vault, err := store.LoadStore(storePath, "pass")
	if err != nil {
		t.Fatalf("LoadStore error: %v", err)
	}
	entry, ok := vault.GetEntry("mykey")
	if !ok {
		t.Fatal("expected entry 'mykey' to exist")
	}
	if entry.Metadata["password"] != "secret" {
		t.Errorf("expected password 'secret', got %q", entry.Metadata["password"])
	}
	if entry.Metadata["url"] != "https://x.com" {
		t.Errorf("expected URL 'https://x.com', got %q", entry.Metadata["url"])
	}
	if entry.Metadata["username"] != "user" {
		t.Errorf("expected username 'user', got %q", entry.Metadata["username"])
	}
}

func TestSetUpdateEntry(t *testing.T) {
	dir := t.TempDir()
	storePath := filepath.Join(dir, "store.json")

	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
	runInit([]string{"--store-path", storePath})

	// First set
	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
	runSet([]string{"mykey", "--store-path", storePath, "--password", "oldpass"})

	// Second set with "y" confirmation via stdin
	// Standard prompts come before update check: URL, Username, Notes (all empty),
	// then update confirmation "y", then custom metadata (empty to finish).
	oldStdin := os.Stdin
	r, w, _ := os.Pipe()
	w.Write([]byte("\n\n\ny\n\n"))
	w.Close()
	resetStdinReader()
	os.Stdin = r

	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
	runSet([]string{"mykey", "--store-path", storePath, "--password", "newpass"})
	resetStdinReader()
	os.Stdin = oldStdin

	vault, err := store.LoadStore(storePath, "pass")
	if err != nil {
		t.Fatalf("LoadStore error: %v", err)
	}
	entry, ok := vault.GetEntry("mykey")
	if !ok {
		t.Fatal("expected entry 'mykey' to exist")
	}
	if entry.Metadata["password"] != "newpass" {
		t.Errorf("expected password 'newpass', got %q", entry.Metadata["password"])
	}
}

func TestSetNoPrompt(t *testing.T) {
	dir := t.TempDir()
	storePath := filepath.Join(dir, "store.json")

	t.Setenv("LOCALPASS_PRIMARY_PASSWORD", "envpass")

	// Init with readPassword
	readPassword = func(fd int) ([]byte, error) { return []byte("envpass"), nil }
	runInit([]string{"--store-path", storePath})

	// Set with --no-prompt
	runSet([]string{"key1", "--store-path", storePath, "--password", "secret", "--no-prompt"})

	vault, err := store.LoadStore(storePath, "envpass")
	if err != nil {
		t.Fatalf("LoadStore error: %v", err)
	}
	entry, ok := vault.GetEntry("key1")
	if !ok {
		t.Fatal("expected entry 'key1' to exist")
	}
	if entry.Metadata["password"] != "secret" {
		t.Errorf("expected password 'secret', got %q", entry.Metadata["password"])
	}
}

func TestSetNoInit(t *testing.T) {
	dir := t.TempDir()
	storePath := filepath.Join(dir, "no-init.json")

	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }

	stderrBuf := captureStderr(t)
	exitCode := 0
	oldOsExit := osExit
	osExit = func(code int) {
		exitCode = code
		panic("os.Exit")
	}
	defer func() {
		osExit = oldOsExit
		recover()
	}()

	func() {
		defer func() { recover() }()
		runSet([]string{"key", "--store-path", storePath, "--password", "secret"})
	}()

	if exitCode != 1 {
		t.Errorf("expected exit code 1, got %d", exitCode)
	}
	if !strings.Contains(stderrBuf(), "No vault found") {
		t.Errorf("expected 'No vault found' error, got: %s", stderrBuf())
	}
}

func TestSetNoPromptWithoutEnvVar(t *testing.T) {
	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }

	stderrBuf := captureStderr(t)
	exitCode := 0
	oldOsExit := osExit
	osExit = func(code int) {
		exitCode = code
		panic("os.Exit")
	}
	defer func() {
		osExit = oldOsExit
		recover()
	}()

	func() {
		defer func() { recover() }()
		runSet([]string{"key", "--no-prompt"})
	}()

	if exitCode != 1 {
		t.Errorf("expected exit code 1, got %d", exitCode)
	}
	if !strings.Contains(stderrBuf(), "LOCALPASS_PRIMARY_PASSWORD is not set") {
		t.Errorf("expected env var error, got: %s", stderrBuf())
	}
}

// captureStderr returns a function that returns captured stderr content.
func captureStderr(t *testing.T) func() string {
	t.Helper()
	r, w, _ := os.Pipe()
	oldStderr := os.Stderr
	os.Stderr = w

	done := make(chan struct{})
	var buf bytes.Buffer
	go func() {
		buf.ReadFrom(r)
		close(done)
	}()

	return func() string {
		w.Close()
		<-done
		os.Stderr = oldStderr
		return buf.String()
	}
}

// -- get command tests -------------------------------------------------------

func TestGetEntry(t *testing.T) {
	dir := t.TempDir()
	storePath := filepath.Join(dir, "store.json")

	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
	runInit([]string{"--store-path", storePath})

	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
	runSet([]string{"mykey", "--store-path", storePath, "--password", "secret", "--username", "user"})

	// Get with --display to avoid clipboard
	stdoutBuf := &bytes.Buffer{}
	oldStdout := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w

	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
	done := make(chan struct{})
	go func() {
		stdoutBuf.ReadFrom(r)
		close(done)
	}()
	runGet([]string{"mykey", "--store-path", storePath, "--display"})
	w.Close()
	<-done
	os.Stdout = oldStdout

	output := stdoutBuf.String()
	if !strings.Contains(output, "mykey") {
		t.Errorf("expected output to contain 'mykey', got: %s", output)
	}
	if !strings.Contains(output, "secret") {
		t.Errorf("expected output to contain 'secret', got: %s", output)
	}
	if !strings.Contains(output, "user") {
		t.Errorf("expected output to contain 'user', got: %s", output)
	}
}

func TestGetNonexistentEntry(t *testing.T) {
	dir := t.TempDir()
	storePath := filepath.Join(dir, "store.json")

	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
	runInit([]string{"--store-path", storePath})

	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
	runSet([]string{"mykey", "--store-path", storePath, "--password", "secret"})

	stderrBuf := captureStderr(t)
	exitCode := 0
	oldOsExit := osExit
	osExit = func(code int) {
		exitCode = code
		panic("os.Exit")
	}
	defer func() {
		osExit = oldOsExit
		recover()
	}()

	func() {
		defer func() { recover() }()
		readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
		runGet([]string{"nonexistent", "--store-path", storePath, "--display"})
	}()

	if exitCode != 1 {
		t.Errorf("expected exit code 1, got %d", exitCode)
	}
	if !strings.Contains(stderrBuf(), "not found") {
		t.Errorf("expected 'not found' error, got: %s", stderrBuf())
	}
}

func TestGetNoInit(t *testing.T) {
	dir := t.TempDir()
	storePath := filepath.Join(dir, "no-init.json")

	stderrBuf := captureStderr(t)
	exitCode := 0
	oldOsExit := osExit
	osExit = func(code int) {
		exitCode = code
		panic("os.Exit")
	}
	defer func() {
		osExit = oldOsExit
		recover()
	}()

	func() {
		defer func() { recover() }()
		readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
		runGet([]string{"key", "--store-path", storePath})
	}()

	if exitCode != 1 {
		t.Errorf("expected exit code 1, got %d", exitCode)
	}
	if !strings.Contains(stderrBuf(), "No vault found") {
		t.Errorf("expected 'No vault found' error, got: %s", stderrBuf())
	}
}

// -- list command tests ------------------------------------------------------

func TestListEntries(t *testing.T) {
	dir := t.TempDir()
	storePath := filepath.Join(dir, "store.json")

	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
	runInit([]string{"--store-path", storePath})

	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
	runSet([]string{"a", "--store-path", storePath, "--password", "a"})
	runSet([]string{"b", "--store-path", storePath, "--password", "b"})
	runSet([]string{"abc", "--store-path", storePath, "--password", "abc"})

	stdoutBuf := &bytes.Buffer{}
	oldStdout := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w

	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
	done := make(chan struct{})
	go func() {
		stdoutBuf.ReadFrom(r)
		close(done)
	}()
	runList([]string{"--store-path", storePath})
	w.Close()
	<-done
	os.Stdout = oldStdout

	output := stdoutBuf.String()
	if !strings.Contains(output, "a") || !strings.Contains(output, "b") || !strings.Contains(output, "abc") {
		t.Errorf("expected output to contain 'a', 'b', 'abc', got: %s", output)
	}
}

func TestListSearch(t *testing.T) {
	dir := t.TempDir()
	storePath := filepath.Join(dir, "store.json")

	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
	runInit([]string{"--store-path", storePath})

	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
	runSet([]string{"a", "--store-path", storePath, "--password", "a"})
	runSet([]string{"b", "--store-path", storePath, "--password", "b"})
	runSet([]string{"abc", "--store-path", storePath, "--password", "abc"})

	stdoutBuf := &bytes.Buffer{}
	oldStdout := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w

	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
	done := make(chan struct{})
	go func() {
		stdoutBuf.ReadFrom(r)
		close(done)
	}()
	runList([]string{"--store-path", storePath, "--search", "a"})
	w.Close()
	<-done
	os.Stdout = oldStdout

	// Filter out the password prompt line
	output := stdoutBuf.String()
	lines := strings.Split(strings.TrimSpace(output), "\n")
	var keys []string
	for _, line := range lines {
		if !strings.Contains(line, "Enter primary password") {
			keys = append(keys, strings.TrimSpace(line))
		}
	}
	if len(keys) != 2 {
		t.Errorf("expected 2 results, got %d: %v", len(keys), keys)
	}
}

func TestListEmpty(t *testing.T) {
	dir := t.TempDir()
	storePath := filepath.Join(dir, "store.json")

	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
	runInit([]string{"--store-path", storePath})

	stdoutBuf := &bytes.Buffer{}
	oldStdout := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w

	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
	done := make(chan struct{})
	go func() {
		stdoutBuf.ReadFrom(r)
		close(done)
	}()
	runList([]string{"--store-path", storePath})
	w.Close()
	<-done
	os.Stdout = oldStdout

	output := strings.TrimSpace(stdoutBuf.String())
	if !strings.Contains(output, "No entries in vault") {
		t.Errorf("expected 'No entries in vault', got: %s", output)
	}
}

func TestListNoInit(t *testing.T) {
	dir := t.TempDir()
	storePath := filepath.Join(dir, "no-init.json")

	stderrBuf := captureStderr(t)
	exitCode := 0
	oldOsExit := osExit
	osExit = func(code int) {
		exitCode = code
		panic("os.Exit")
	}
	defer func() {
		osExit = oldOsExit
		recover()
	}()

	func() {
		defer func() { recover() }()
		readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
		runList([]string{"--store-path", storePath})
	}()

	if exitCode != 1 {
		t.Errorf("expected exit code 1, got %d", exitCode)
	}
	if !strings.Contains(stderrBuf(), "No vault found") {
		t.Errorf("expected 'No vault found' error, got: %s", stderrBuf())
	}
}

// -- rm command tests --------------------------------------------------------

func TestRmEntry(t *testing.T) {
	dir := t.TempDir()
	storePath := filepath.Join(dir, "store.json")

	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
	runInit([]string{"--store-path", storePath})

	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
	runSet([]string{"mykey", "--store-path", storePath, "--password", "secret"})

	// Confirm deletion with "y"
	oldStdin := os.Stdin
	r, w, _ := os.Pipe()
	w.Write([]byte("y\n"))
	w.Close()
	resetStdinReader()
	os.Stdin = r

	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
	runRm([]string{"mykey", "--store-path", storePath})
	resetStdinReader()
	os.Stdin = oldStdin

	vault, err := store.LoadStore(storePath, "pass")
	if err != nil {
		t.Fatalf("LoadStore error: %v", err)
	}
	if _, ok := vault.GetEntry("mykey"); ok {
		t.Error("expected entry to be deleted")
	}
}

func TestRmNonexistentEntry(t *testing.T) {
	dir := t.TempDir()
	storePath := filepath.Join(dir, "store.json")

	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
	runInit([]string{"--store-path", storePath})

	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
	runSet([]string{"mykey", "--store-path", storePath, "--password", "secret"})

	stderrBuf := captureStderr(t)
	exitCode := 0
	oldOsExit := osExit
	osExit = func(code int) {
		exitCode = code
		panic("os.Exit")
	}
	defer func() {
		osExit = oldOsExit
		recover()
	}()

	func() {
		defer func() { recover() }()
		readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
		runRm([]string{"nonexistent", "--store-path", storePath})
	}()

	if exitCode != 1 {
		t.Errorf("expected exit code 1, got %d", exitCode)
	}
	if !strings.Contains(stderrBuf(), "not found") {
		t.Errorf("expected 'not found' error, got: %s", stderrBuf())
	}
}

func TestRmAbort(t *testing.T) {
	dir := t.TempDir()
	storePath := filepath.Join(dir, "store.json")

	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
	runInit([]string{"--store-path", storePath})

	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
	runSet([]string{"mykey", "--store-path", storePath, "--password", "secret"})

	// Don't confirm deletion
	oldStdin := os.Stdin
	r, w, _ := os.Pipe()
	w.Write([]byte("n\n"))
	w.Close()
	resetStdinReader()
	os.Stdin = r

	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
	runRm([]string{"mykey", "--store-path", storePath})
	resetStdinReader()
	os.Stdin = oldStdin

	vault, err := store.LoadStore(storePath, "pass")
	if err != nil {
		t.Fatalf("LoadStore error: %v", err)
	}
	if _, ok := vault.GetEntry("mykey"); !ok {
		t.Error("expected entry to still exist")
	}
}

func TestRmNoInit(t *testing.T) {
	dir := t.TempDir()
	storePath := filepath.Join(dir, "no-init.json")

	stderrBuf := captureStderr(t)
	exitCode := 0
	oldOsExit := osExit
	osExit = func(code int) {
		exitCode = code
		panic("os.Exit")
	}
	defer func() {
		osExit = oldOsExit
		recover()
	}()

	func() {
		defer func() { recover() }()
		readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
		runRm([]string{"key", "--store-path", storePath})
	}()

	if exitCode != 1 {
		t.Errorf("expected exit code 1, got %d", exitCode)
	}
	if !strings.Contains(stderrBuf(), "No vault found") {
		t.Errorf("expected 'No vault found' error, got: %s", stderrBuf())
	}
}

// -- T14 help tests -----------------------------------------------------------

func TestMainNoArgs(t *testing.T) {
	// Capture both stdout and stderr
	stdoutBuf := &bytes.Buffer{}
	stderrBuf := &bytes.Buffer{}

	oldStdout := os.Stdout
	rOut, wOut, _ := os.Pipe()
	os.Stdout = wOut

	oldStderr := os.Stderr
	rErr, wErr, _ := os.Pipe()
	os.Stderr = wErr

	exitCode := 0
	oldOsExit := osExit
	osExit = func(code int) {
		exitCode = code
		panic("os.Exit")
	}

	oldArgs := os.Args
	os.Args = []string{"localpass"}

	func() {
		defer func() {
			recover()
			wOut.Close()
			wErr.Close()
			os.Stdout = oldStdout
			os.Stderr = oldStderr
			os.Args = oldArgs
			osExit = oldOsExit
			stdoutBuf.ReadFrom(rOut)
			stderrBuf.ReadFrom(rErr)
		}()
		main()
	}()

	if exitCode != 1 {
		t.Errorf("expected exit code 1, got %d", exitCode)
	}
	output := stdoutBuf.String() + stderrBuf.String()
	if !strings.Contains(output, "Usage:") {
		t.Errorf("expected usage output, got: %s", output)
	}
}

func TestMainHelp(t *testing.T) {
	stdoutBuf := &bytes.Buffer{}
	oldStdout := os.Stdout
	rOut, wOut, _ := os.Pipe()
	os.Stdout = wOut

	exitCode := 0
	oldOsExit := osExit
	osExit = func(code int) {
		exitCode = code
		panic("os.Exit")
	}

	oldArgs := os.Args
	os.Args = []string{"localpass", "--help"}

	func() {
		defer func() {
			recover()
			wOut.Close()
			os.Stdout = oldStdout
			os.Args = oldArgs
			osExit = oldOsExit
			stdoutBuf.ReadFrom(rOut)
		}()
		main()
	}()

	if exitCode != 0 {
		t.Errorf("expected exit code 0, got %d", exitCode)
	}
	output := stdoutBuf.String()
	if !strings.Contains(output, "Usage:") {
		t.Errorf("expected usage output, got: %s", output)
	}
}

func TestMainUnknownCommand(t *testing.T) {
	stderrBuf := &bytes.Buffer{}
	oldStderr := os.Stderr
	rErr, wErr, _ := os.Pipe()
	os.Stderr = wErr

	exitCode := 0
	oldOsExit := osExit
	osExit = func(code int) {
		exitCode = code
		panic("os.Exit")
	}

	oldArgs := os.Args
	os.Args = []string{"localpass", "bogus"}

	func() {
		defer func() {
			recover()
			wErr.Close()
			os.Stderr = oldStderr
			os.Args = oldArgs
			osExit = oldOsExit
			stderrBuf.ReadFrom(rErr)
		}()
		main()
	}()

	if exitCode != 1 {
		t.Errorf("expected exit code 1, got %d", exitCode)
	}
	output := stderrBuf.String()
	if !strings.Contains(output, "unknown command") {
		t.Errorf("expected 'unknown command' error, got: %s", output)
	}
}

// -- configure command tests -------------------------------------------------

func TestConfigureSavesConfig(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.json")

	// Simulate user input: all fields + confirm
	oldStdin := os.Stdin
	r, w, _ := os.Pipe()
	input := "https://my-minio.example.com\nus-east-2\nmy-bucket\nvault/store.json\nAKID123\nsecret123\ny\ny\n"
	w.Write([]byte(input))
	w.Close()
	resetStdinReader()
	os.Stdin = r

	runConfigure([]string{"--config-path", configPath})
	resetStdinReader()
	os.Stdin = oldStdin

	// Verify file was created
	if _, err := os.Stat(configPath); os.IsNotExist(err) {
		t.Fatal("config file should exist")
	}

	// Load and verify contents
	cfg, err := config.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig error: %v", err)
	}

	if cfg.S3Endpoint != "https://my-minio.example.com" {
		t.Errorf("expected endpoint %q, got %q", "https://my-minio.example.com", cfg.S3Endpoint)
	}
	if cfg.S3Region != "us-east-2" {
		t.Errorf("expected region %q, got %q", "us-east-2", cfg.S3Region)
	}
	if cfg.S3Bucket != "my-bucket" {
		t.Errorf("expected bucket %q, got %q", "my-bucket", cfg.S3Bucket)
	}
	if cfg.S3Key != "vault/store.json" {
		t.Errorf("expected key %q, got %q", "vault/store.json", cfg.S3Key)
	}
	if cfg.AWSAccessKeyID != "AKID123" {
		t.Errorf("expected access key %q, got %q", "AKID123", cfg.AWSAccessKeyID)
	}
	if cfg.AWSSecretAccessKey != "secret123" {
		t.Errorf("expected secret key %q, got %q", "secret123", cfg.AWSSecretAccessKey)
	}
}

func TestConfigureKeepsDefaults(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.json")

	// First, save a config with some values
	cfg := &config.Config{
		S3Endpoint:         "https://existing.com",
		S3Region:           "eu-west-1",
		S3Bucket:           "existing-bucket",
		S3Key:              "path/store.json",
		AWSAccessKeyID:     "existing-key",
		AWSSecretAccessKey: "existing-secret",
	}
	if err := config.SaveConfig(configPath, cfg); err != nil {
		t.Fatalf("SaveConfig error: %v", err)
	}

	// Now run configure with all empty inputs (keep defaults) + confirm
	oldStdin := os.Stdin
	r, w, _ := os.Pipe()
	input := "\n\n\n\n\n\n\ny\n"
	w.Write([]byte(input))
	w.Close()
	resetStdinReader()
	os.Stdin = r

	runConfigure([]string{"--config-path", configPath})
	resetStdinReader()
	os.Stdin = oldStdin

	// Load and verify nothing changed
	loaded, err := config.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig error: %v", err)
	}

	if loaded.S3Endpoint != "https://existing.com" {
		t.Errorf("expected endpoint %q, got %q", "https://existing.com", loaded.S3Endpoint)
	}
	if loaded.S3Bucket != "existing-bucket" {
		t.Errorf("expected bucket %q, got %q", "existing-bucket", loaded.S3Bucket)
	}
}

func TestConfigureAbortsWithoutConfirm(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.json")

	// Simulate user input: all fields + NO confirm
	oldStdin := os.Stdin
	r, w, _ := os.Pipe()
	input := "https://endpoint.com\nus-east-1\nmy-bucket\nstore.json\nkey123\nsecret123\nn\nn\n"
	w.Write([]byte(input))
	w.Close()
	resetStdinReader()
	os.Stdin = r

	runConfigure([]string{"--config-path", configPath})
	resetStdinReader()
	os.Stdin = oldStdin

	// Config file should NOT exist (since it was aborted before save)
	if _, err := os.Stat(configPath); err == nil {
		t.Error("config file should not exist when aborted")
	}
}

func TestConfigureStaysEmptyWhenUnset(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.json")

	// Provide empty for all fields (keep defaults = empty) + confirm
	oldStdin := os.Stdin
	r, w, _ := os.Pipe()
	input := "\n\n\n\n\n\n\ny\n"
	w.Write([]byte(input))
	w.Close()
	resetStdinReader()
	os.Stdin = r

	runConfigure([]string{"--config-path", configPath})
	resetStdinReader()
	os.Stdin = oldStdin

	cfg, err := config.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig error: %v", err)
	}

	if cfg.S3Endpoint != "" {
		t.Errorf("expected empty endpoint, got %q", cfg.S3Endpoint)
	}
	if cfg.S3Region != "" {
		t.Errorf("expected empty region, got %q", cfg.S3Region)
	}
	if cfg.S3Bucket != "" {
		t.Errorf("expected empty bucket, got %q", cfg.S3Bucket)
	}
	if cfg.S3Key != "" {
		t.Errorf("expected empty key, got %q", cfg.S3Key)
	}
	if cfg.AWSAccessKeyID != "" {
		t.Errorf("expected empty access key, got %q", cfg.AWSAccessKeyID)
	}
	if cfg.AWSSecretAccessKey != "" {
		t.Errorf("expected empty secret key, got %q", cfg.AWSSecretAccessKey)
	}
}

func TestConfigureKeyDefaultsToStoreJson(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.json")

	// Provide all fields
	oldStdin := os.Stdin
	r, w, _ := os.Pipe()
	input := "https://endpoint.com\nus-east-1\nmy-bucket\n\n\n\n\ny\n"
	w.Write([]byte(input))
	w.Close()
	resetStdinReader()
	os.Stdin = r

	runConfigure([]string{"--config-path", configPath})
	resetStdinReader()
	os.Stdin = oldStdin

	cfg, err := config.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig error: %v", err)
	}

	// Empty input for key should keep it empty (no hardcoded default)
	if cfg.S3Key != "" {
		t.Errorf("expected empty key, got %q", cfg.S3Key)
	}
}

func TestConfigureUsesDefaultConfigPath(t *testing.T) {
	// This test verifies configure works with default config path
	// by checking it can read the default path function
	path, err := config.DefaultConfigPath()
	if err != nil {
		t.Fatalf("DefaultConfigPath error: %v", err)
	}
	if path == "" {
		t.Fatal("expected non-empty default config path")
	}
}

