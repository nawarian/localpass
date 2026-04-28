package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Config represents the localpass configuration stored in ~/.localpass/config.json.
type Config struct {
	S3Endpoint         string `json:"s3_endpoint"`
	S3Region           string `json:"s3_region"`
	S3Bucket           string `json:"s3_bucket"`
	S3Key              string `json:"s3_key"`
	AWSAccessKeyID     string `json:"aws_access_key_id"`
	AWSSecretAccessKey string `json:"aws_secret_access_key"`
	AutoSync           bool   `json:"auto_sync"`
}

// DefaultConfigPath returns the default config file path.
func DefaultConfigPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot determine home directory: %w", err)
	}
	return filepath.Join(home, ".localpass", "config.json"), nil
}

// DefaultStorePath returns the default store file path.
func DefaultStorePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot determine home directory: %w", err)
	}
	return filepath.Join(home, ".localpass", "store.json"), nil
}

// LoadConfig reads and parses the config file. If the file doesn't exist, returns default config (empty fields).
func LoadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &Config{}, nil
		}
		return nil, fmt.Errorf("failed to read config file: %w", err)
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("failed to parse config file: %w", err)
	}

	return &cfg, nil
}

// SaveConfig writes config to disk.
func SaveConfig(path string, cfg *Config) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("failed to create directory %s: %w", dir, err)
	}

	if err := os.WriteFile(path, data, 0600); err != nil {
		return fmt.Errorf("failed to write config file: %w", err)
	}

	return nil
}

// ResolveCredentials merges config values with environment variables.
// Env vars take precedence over config file values.
func ResolveCredentials(cfg *Config) (accessKey, secretKey, region, endpoint string) {
	accessKey = cfg.AWSAccessKeyID
	secretKey = cfg.AWSSecretAccessKey
	region = cfg.S3Region
	endpoint = cfg.S3Endpoint

	if v := os.Getenv("AWS_ACCESS_KEY_ID"); v != "" {
		accessKey = v
	}
	if v := os.Getenv("AWS_SECRET_ACCESS_KEY"); v != "" {
		secretKey = v
	}
	if v := os.Getenv("AWS_REGION"); v != "" {
		region = v
	}
	if v := os.Getenv("AWS_DEFAULT_REGION"); v != "" && region == "" {
		region = v
	}
	if v := os.Getenv("S3_ENDPOINT"); v != "" {
		endpoint = v
	}

	return
}
