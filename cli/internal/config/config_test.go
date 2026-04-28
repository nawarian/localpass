package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSaveAndLoadConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")

	cfg := &Config{
		S3Endpoint:         "https://s3.us-east-1.amazonaws.com",
		S3Region:           "us-east-1",
		S3Bucket:           "my-localpass-vault",
		S3Key:              "store.json",
		AWSAccessKeyID:     "my-access-key",
		AWSSecretAccessKey: "my-secret-key",
	}

	if err := SaveConfig(path, cfg); err != nil {
		t.Fatalf("SaveConfig error: %v", err)
	}

	loaded, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("LoadConfig error: %v", err)
	}

	if loaded.S3Endpoint != cfg.S3Endpoint {
		t.Errorf("S3Endpoint mismatch: %q vs %q", loaded.S3Endpoint, cfg.S3Endpoint)
	}
	if loaded.S3Region != cfg.S3Region {
		t.Errorf("S3Region mismatch: %q vs %q", loaded.S3Region, cfg.S3Region)
	}
	if loaded.S3Bucket != cfg.S3Bucket {
		t.Errorf("S3Bucket mismatch: %q vs %q", loaded.S3Bucket, cfg.S3Bucket)
	}
	if loaded.S3Key != cfg.S3Key {
		t.Errorf("S3Key mismatch: %q vs %q", loaded.S3Key, cfg.S3Key)
	}
	if loaded.AWSAccessKeyID != cfg.AWSAccessKeyID {
		t.Errorf("AWSAccessKeyID mismatch: %q vs %q", loaded.AWSAccessKeyID, cfg.AWSAccessKeyID)
	}
	if loaded.AWSSecretAccessKey != cfg.AWSSecretAccessKey {
		t.Errorf("AWSSecretAccessKey mismatch: %q vs %q", loaded.AWSSecretAccessKey, cfg.AWSSecretAccessKey)
	}
}

func TestLoadNonExistentConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nonexistent.json")

	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("LoadConfig error: %v", err)
	}
	if cfg == nil {
		t.Fatal("expected non-nil config")
	}
	if cfg.S3Endpoint != "" {
		t.Errorf("expected empty S3Endpoint, got %q", cfg.S3Endpoint)
	}
}

func TestResolveCredentialsPrefersEnvVars(t *testing.T) {
	cfg := &Config{
		S3Endpoint:         "https://config-endpoint.com",
		S3Region:           "us-west-2",
		AWSAccessKeyID:     "config-access-key",
		AWSSecretAccessKey: "config-secret-key",
	}

	// Set env vars with different values
	t.Setenv("AWS_ACCESS_KEY_ID", "env-access-key")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "env-secret-key")
	t.Setenv("AWS_REGION", "eu-central-1")
	t.Setenv("S3_ENDPOINT", "https://env-endpoint.com")

	accessKey, secretKey, region, endpoint := ResolveCredentials(cfg)

	if accessKey != "env-access-key" {
		t.Errorf("expected env access key, got %q", accessKey)
	}
	if secretKey != "env-secret-key" {
		t.Errorf("expected env secret key, got %q", secretKey)
	}
	if region != "eu-central-1" {
		t.Errorf("expected env region, got %q", region)
	}
	if endpoint != "https://env-endpoint.com" {
		t.Errorf("expected env endpoint, got %q", endpoint)
	}
}

func TestResolveCredentialsFallsBackToConfig(t *testing.T) {
	cfg := &Config{
		S3Endpoint:         "https://config-endpoint.com",
		S3Region:           "us-west-2",
		AWSAccessKeyID:     "config-access-key",
		AWSSecretAccessKey: "config-secret-key",
	}

	accessKey, secretKey, region, endpoint := ResolveCredentials(cfg)

	if accessKey != "config-access-key" {
		t.Errorf("expected config access key, got %q", accessKey)
	}
	if secretKey != "config-secret-key" {
		t.Errorf("expected config secret key, got %q", secretKey)
	}
	if region != "us-west-2" {
		t.Errorf("expected config region, got %q", region)
	}
	if endpoint != "https://config-endpoint.com" {
		t.Errorf("expected config endpoint, got %q", endpoint)
	}
}

func TestResolveCredentialsEmptyConfig(t *testing.T) {
	cfg := &Config{}

	t.Setenv("AWS_REGION", "sa-east-1")

	_, _, region, _ := ResolveCredentials(cfg)
	if region != "sa-east-1" {
		t.Errorf("expected env region, got %q", region)
	}
}

func TestResolveCredentialsDefaultsToEmpty(t *testing.T) {
	cfg := &Config{}

	accessKey, secretKey, region, endpoint := ResolveCredentials(cfg)
	if accessKey != "" || secretKey != "" || region != "" || endpoint != "" {
		t.Errorf("expected all empty, got %q %q %q %q", accessKey, secretKey, region, endpoint)
	}
}

func TestSaveConfigCreatesDirectory(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "sub", "config.json")

	cfg := &Config{S3Bucket: "test"}
	if err := SaveConfig(path, cfg); err != nil {
		t.Fatalf("SaveConfig error: %v", err)
	}

	if _, err := os.Stat(path); os.IsNotExist(err) {
		t.Fatal("expected file to exist")
	}
}

func TestDefaultStorePath(t *testing.T) {
	path, err := DefaultStorePath()
	if err != nil {
		t.Fatalf("DefaultStorePath error: %v", err)
	}
	if path == "" {
		t.Error("expected non-empty path")
	}
	// Should end with .localpass/store.json
	if filepath.Base(filepath.Dir(path)) != ".localpass" || filepath.Base(path) != "store.json" {
		t.Errorf("unexpected path: %s", path)
	}
}

func TestDefaultConfigPath(t *testing.T) {
	path, err := DefaultConfigPath()
	if err != nil {
		t.Fatalf("DefaultConfigPath error: %v", err)
	}
	if path == "" {
		t.Error("expected non-empty path")
	}
	if filepath.Base(filepath.Dir(path)) != ".localpass" || filepath.Base(path) != "config.json" {
		t.Errorf("unexpected path: %s", path)
	}
}
