package store

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"fmt"
	"io"

	"golang.org/x/crypto/argon2"
)

const (
	saltLen  = 16
	nonceLen = 12
	keyLen   = 32

	// Argon2id parameters
	argonTime    = 3
	argonMemory  = 64 * 1024 // 64 MB
	argonThreads = 4
)

var (
	ErrInvalidCiphertext = errors.New("ciphertext is too short")
	ErrWrongPassword     = errors.New("wrong master password or corrupted data")
)

// Encrypt encrypts plaintext using AES-256-GCM with a key derived from the
// master password via Argon2id. Output format: salt (16) || nonce (12) || ciphertext || auth_tag.
func Encrypt(plaintext []byte, masterPassword string) ([]byte, error) {
	// Generate random salt
	salt := make([]byte, saltLen)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return nil, fmt.Errorf("failed to generate salt: %w", err)
	}

	// Derive key using Argon2id
	key := argon2.IDKey([]byte(masterPassword), salt, argonTime, argonMemory, argonThreads, keyLen)

	// Create AES-GCM cipher
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("failed to create cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("failed to create GCM: %w", err)
	}

	// Generate random nonce
	nonce := make([]byte, nonceLen)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("failed to generate nonce: %w", err)
	}

	// Encrypt and seal: nonce || ciphertext || auth_tag
	ciphertext := gcm.Seal(nil, nonce, plaintext, nil)

	// Final output: salt || nonce || ciphertext
	out := make([]byte, 0, saltLen+nonceLen+len(ciphertext))
	out = append(out, salt...)
	out = append(out, nonce...)
	out = append(out, ciphertext...)

	return out, nil
}

// Decrypt decrypts data produced by Encrypt.
// Input format: salt (16) || nonce (12) || ciphertext || auth_tag.
func Decrypt(data []byte, masterPassword string) ([]byte, error) {
	if len(data) < saltLen+nonceLen {
		return nil, ErrInvalidCiphertext
	}

	salt := data[:saltLen]
	nonce := data[saltLen : saltLen+nonceLen]
	ciphertext := data[saltLen+nonceLen:]

	// Derive key using Argon2id
	key := argon2.IDKey([]byte(masterPassword), salt, argonTime, argonMemory, argonThreads, keyLen)

	// Create AES-GCM cipher
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("failed to create cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("failed to create GCM: %w", err)
	}

	// Decrypt and authenticate
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, ErrWrongPassword
	}

	return plaintext, nil
}
