package store

import (
	"bytes"
	"testing"
)

func TestEncryptDecryptSuccess(t *testing.T) {
	plaintext := []byte("hello")
	password := "myMasterPassword"

	ciphertext, err := Encrypt(plaintext, password)
	if err != nil {
		t.Fatalf("encrypt error: %v", err)
	}

	decrypted, err := Decrypt(ciphertext, password)
	if err != nil {
		t.Fatalf("decrypt error: %v", err)
	}

	if !bytes.Equal(decrypted, plaintext) {
		t.Errorf("decrypted = %q, want %q", decrypted, plaintext)
	}
}

func TestDecryptWrongPassword(t *testing.T) {
	plaintext := []byte("hello")
	password := "correctPassword"
	wrongPassword := "wrongPassword"

	ciphertext, err := Encrypt(plaintext, password)
	if err != nil {
		t.Fatalf("encrypt error: %v", err)
	}

	_, err = Decrypt(ciphertext, wrongPassword)
	if err != ErrWrongPassword {
		t.Errorf("expected ErrWrongPassword, got %v", err)
	}
}

func TestEncryptProducesDifferentOutput(t *testing.T) {
	plaintext := []byte("hello")
	password := "myMasterPassword"

	ciphertext1, err := Encrypt(plaintext, password)
	if err != nil {
		t.Fatalf("encrypt error: %v", err)
	}

	ciphertext2, err := Encrypt(plaintext, password)
	if err != nil {
		t.Fatalf("encrypt error: %v", err)
	}

	if bytes.Equal(ciphertext1, ciphertext2) {
		t.Error("expected different ciphertexts due to random salt and nonce")
	}
}

func TestDecryptEmptyData(t *testing.T) {
	_, err := Decrypt(nil, "password")
	if err != ErrInvalidCiphertext {
		t.Errorf("expected ErrInvalidCiphertext, got %v", err)
	}

	_, err = Decrypt([]byte{}, "password")
	if err != ErrInvalidCiphertext {
		t.Errorf("expected ErrInvalidCiphertext, got %v", err)
	}
}

func TestDecryptTooShortData(t *testing.T) {
	// Less than saltLen + nonceLen (28 bytes)
	_, err := Decrypt(make([]byte, 27), "password")
	if err != ErrInvalidCiphertext {
		t.Errorf("expected ErrInvalidCiphertext, got %v", err)
	}
}

func TestDecryptCorruptedCiphertext(t *testing.T) {
	plaintext := []byte("hello")
	password := "myMasterPassword"

	ciphertext, err := Encrypt(plaintext, password)
	if err != nil {
		t.Fatalf("encrypt error: %v", err)
	}

	// Corrupt the last byte (part of auth tag or ciphertext)
	corrupted := make([]byte, len(ciphertext))
	copy(corrupted, ciphertext)
	corrupted[len(corrupted)-1] ^= 0xFF

	_, err = Decrypt(corrupted, password)
	if err == nil {
		t.Error("expected error for corrupted ciphertext, got nil")
	}
}

func TestEncryptDecryptEmptyPlaintext(t *testing.T) {
	plaintext := []byte("")
	password := "myMasterPassword"

	ciphertext, err := Encrypt(plaintext, password)
	if err != nil {
		t.Fatalf("encrypt error: %v", err)
	}

	decrypted, err := Decrypt(ciphertext, password)
	if err != nil {
		t.Fatalf("decrypt error: %v", err)
	}

	if len(decrypted) != 0 {
		t.Errorf("expected empty, got %d bytes", len(decrypted))
	}
}

func TestEncryptDecryptLargeData(t *testing.T) {
	plaintext := bytes.Repeat([]byte("a"), 10000)
	password := "myMasterPassword"

	ciphertext, err := Encrypt(plaintext, password)
	if err != nil {
		t.Fatalf("encrypt error: %v", err)
	}

	decrypted, err := Decrypt(ciphertext, password)
	if err != nil {
		t.Fatalf("decrypt error: %v", err)
	}

	if !bytes.Equal(decrypted, plaintext) {
		t.Error("large data round-trip failed")
	}
}

func TestEncryptDecryptWithSpecialCharacters(t *testing.T) {
	plaintext := []byte("hello\nworld\t!@#$%^&*()_+{}|:\"<>?")
	password := "pässwörd with 日本語 and emoji 🚀"

	ciphertext, err := Encrypt(plaintext, password)
	if err != nil {
		t.Fatalf("encrypt error: %v", err)
	}

	decrypted, err := Decrypt(ciphertext, password)
	if err != nil {
		t.Fatalf("decrypt error: %v", err)
	}

	if !bytes.Equal(decrypted, plaintext) {
		t.Errorf("decrypted = %q, want %q", decrypted, plaintext)
	}
}
