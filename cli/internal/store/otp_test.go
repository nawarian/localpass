package store

import (
	"strings"
	"testing"
	"time"
)

// RFC 6238 Appendix B seeds. The test vectors are published for these specific
// ASCII secrets, sized per algorithm block length.
var (
	rfcSeedSHA1   = []byte("12345678901234567890")                                             // 20 bytes
	rfcSeedSHA256 = []byte("12345678901234567890123456789012")                                 // 32 bytes
	rfcSeedSHA512 = []byte("1234567890123456789012345678901234567890123456789012345678901234") // 64 bytes
)

// TestRFC6238Vectors pins both digit-8 generation and every algorithm variant
// to the published RFC 6238 Appendix B table.
func TestRFC6238Vectors(t *testing.T) {
	cases := []struct {
		unix   int64
		sha1   string
		sha256 string
		sha512 string
	}{
		{59, "94287082", "46119246", "90693936"},
		{1111111109, "07081804", "68084774", "25091201"},
		{1111111111, "14050471", "67062674", "99943326"},
		{1234567890, "89005924", "91819424", "93441116"},
		{2000000000, "69279037", "90698825", "38618901"},
		{20000000000, "65353130", "77737706", "47863826"},
	}

	for _, tc := range cases {
		when := time.Unix(tc.unix, 0)
		variants := []struct {
			algo   string
			secret []byte
			want   string
		}{
			{"SHA1", rfcSeedSHA1, tc.sha1},
			{"SHA256", rfcSeedSHA256, tc.sha256},
			{"SHA512", rfcSeedSHA512, tc.sha512},
		}
		for _, v := range variants {
			cfg := &OTPConfig{Secret: v.secret, Algorithm: v.algo, Digits: 8, Period: 30}
			got, err := cfg.Generate(when)
			if err != nil {
				t.Fatalf("%s @ %d: Generate error: %v", v.algo, tc.unix, err)
			}
			if got != v.want {
				t.Errorf("%s @ %d: got %q, want %q", v.algo, tc.unix, got, v.want)
			}
		}
	}
}

func TestParseOTPAuthDefaults(t *testing.T) {
	// "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" is Base32 for the SHA1 RFC seed.
	cfg, err := ParseOTPAuth("otpauth://totp/ACME:alice@example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=ACME")
	if err != nil {
		t.Fatalf("ParseOTPAuth error: %v", err)
	}
	if cfg.Algorithm != "SHA1" {
		t.Errorf("algorithm: got %q, want SHA1", cfg.Algorithm)
	}
	if cfg.Digits != 6 {
		t.Errorf("digits: got %d, want 6", cfg.Digits)
	}
	if cfg.Period != 30 {
		t.Errorf("period: got %d, want 30", cfg.Period)
	}
	if cfg.Issuer != "ACME" {
		t.Errorf("issuer: got %q, want ACME", cfg.Issuer)
	}
	if string(cfg.Secret) != string(rfcSeedSHA1) {
		t.Errorf("secret mismatch: got %q", cfg.Secret)
	}
}

func TestParseOTPAuthHonorsParameters(t *testing.T) {
	cfg, err := ParseOTPAuth("otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ&algorithm=SHA256&digits=8&period=60")
	if err != nil {
		t.Fatalf("ParseOTPAuth error: %v", err)
	}
	if cfg.Algorithm != "SHA256" || cfg.Digits != 8 || cfg.Period != 60 {
		t.Errorf("parameters not honored: %+v", cfg)
	}
}

func TestParseOTPAuthRejectsHOTP(t *testing.T) {
	_, err := ParseOTPAuth("otpauth://hotp/x?secret=GEZDGNBVGY3TQOJQ&counter=0")
	if err == nil {
		t.Fatal("expected HOTP to be rejected")
	}
	if !strings.Contains(err.Error(), "HOTP") {
		t.Errorf("expected HOTP error, got: %v", err)
	}
}

func TestParseOTPAuthRejectsUnknownAlgorithm(t *testing.T) {
	_, err := ParseOTPAuth("otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ&algorithm=MD5")
	if err == nil {
		t.Fatal("expected unknown algorithm to be rejected")
	}
	if !strings.Contains(err.Error(), "algorithm") {
		t.Errorf("expected algorithm error, got: %v", err)
	}
}

func TestParseOTPAuthRejectsBadBase32(t *testing.T) {
	_, err := ParseOTPAuth("otpauth://totp/x?secret=not-base-32!!!")
	if err == nil {
		t.Fatal("expected bad Base32 to be rejected")
	}
}

func TestNormalizeOTPBareSecret(t *testing.T) {
	uri, err := NormalizeOTP("gezd gnbv gy3t qojq gezd gnbv gy3t qojq", "github.com")
	if err != nil {
		t.Fatalf("NormalizeOTP error: %v", err)
	}
	if !strings.HasPrefix(uri, "otpauth://totp/") {
		t.Errorf("expected canonical otpauth URI, got %q", uri)
	}
	cfg, err := ParseOTPAuth(uri)
	if err != nil {
		t.Fatalf("re-parse error: %v", err)
	}
	if cfg.Issuer != "github.com" {
		t.Errorf("issuer: got %q, want github.com", cfg.Issuer)
	}
	if cfg.Algorithm != "SHA1" || cfg.Digits != 6 || cfg.Period != 30 {
		t.Errorf("expected RFC defaults, got %+v", cfg)
	}
	// Whitespace/case must be normalized away to the SHA1 RFC seed.
	if string(cfg.Secret) != string(rfcSeedSHA1) {
		t.Errorf("secret mismatch after normalization: got %q", cfg.Secret)
	}
}

func TestNormalizeOTPPassesThroughURI(t *testing.T) {
	in := "otpauth://totp/ACME:alice?secret=GEZDGNBVGY3TQOJQ&issuer=ACME"
	uri, err := NormalizeOTP(in, "ignored")
	if err != nil {
		t.Fatalf("NormalizeOTP error: %v", err)
	}
	if uri != in {
		t.Errorf("expected full URI preserved, got %q", uri)
	}
}

func TestNormalizeOTPRejectsHOTP(t *testing.T) {
	_, err := NormalizeOTP("otpauth://hotp/x?secret=GEZDGNBVGY3TQOJQ&counter=0", "x")
	if err == nil {
		t.Fatal("expected HOTP rejection at normalize time")
	}
}

func TestNormalizeOTPRejectsBadBareSecret(t *testing.T) {
	_, err := NormalizeOTP("0189!!", "x")
	if err == nil {
		t.Fatal("expected invalid Base32 rejection")
	}
}

func TestOTPSecondsRemaining(t *testing.T) {
	// 25s into a 30s window leaves 5s.
	if got := OTPSecondsRemaining(30, time.Unix(25, 0)); got != 5 {
		t.Errorf("got %d, want 5", got)
	}
	// Start of a window leaves the full period.
	if got := OTPSecondsRemaining(30, time.Unix(30, 0)); got != 30 {
		t.Errorf("got %d, want 30", got)
	}
}

func TestGenerateOTP(t *testing.T) {
	uri := "otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8"
	code, remaining, err := GenerateOTP(uri, time.Unix(59, 0))
	if err != nil {
		t.Fatalf("GenerateOTP error: %v", err)
	}
	if code != "94287082" {
		t.Errorf("code: got %q, want 94287082", code)
	}
	if remaining != 1 {
		t.Errorf("remaining: got %d, want 1", remaining)
	}
}

func TestMaskOTPSecret(t *testing.T) {
	masked := MaskOTPSecret("otpauth://totp/ACME:alice?secret=GEZDGNBVGY3TQOJQ&issuer=ACME&period=30")
	if strings.Contains(masked, "GEZDGNBVGY3TQOJQ") {
		t.Errorf("secret leaked in masked URI: %q", masked)
	}
	if !strings.Contains(masked, "secret=****") {
		t.Errorf("expected secret=**** in masked URI, got %q", masked)
	}
	if !strings.Contains(masked, "issuer=ACME") || !strings.Contains(masked, "period=30") {
		t.Errorf("non-secret params should be preserved: %q", masked)
	}
}
