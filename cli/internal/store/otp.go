package store

import (
	"crypto/hmac"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"hash"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// TOTP support — a hand-rolled RFC 6238 implementation with zero third-party
// dependencies. This is the Go side of a deliberate parallel implementation;
// the TypeScript port lives in core/src/otp.ts and both are pinned to the same
// RFC 6238 Appendix B test vectors.
//
// Code generation relies entirely on the system clock — there is no NTP or
// clock-skew handling. We only ever *generate* codes (never validate against a
// window), so a wrong-clock machine will produce wrong codes; that is the OS's
// responsibility, not a bug here.

// otpDefaultAlgorithm, otpDefaultDigits and otpDefaultPeriod are the RFC 6238
// defaults applied when an otpauth:// URI omits the corresponding parameter.
const (
	otpDefaultAlgorithm = "SHA1"
	otpDefaultDigits    = 6
	otpDefaultPeriod    = 30
)

// OTPConfig holds the parsed parameters of a TOTP otpauth:// URI.
type OTPConfig struct {
	Secret    []byte // Base32-decoded shared secret
	Algorithm string // SHA1, SHA256 or SHA512
	Digits    int
	Period    int    // seconds
	Label     string // account label from the URI path
	Issuer    string // issuer query parameter (may be empty)
}

// secretParamRe matches the secret query parameter so MaskOTPSecret can redact
// its value while preserving the rest of the URI verbatim and human-readable.
var secretParamRe = regexp.MustCompile(`([?&]secret=)[^&]*`)

// normalizeBase32 trims whitespace, uppercases, strips embedded spaces and
// removes any padding so a secret can be decoded with the no-padding decoder.
func normalizeBase32(s string) string {
	s = strings.ToUpper(strings.TrimSpace(s))
	s = strings.ReplaceAll(s, " ", "")
	return strings.TrimRight(s, "=")
}

// decodeBase32Secret normalizes and Base32-decodes (RFC 4648) a secret.
func decodeBase32Secret(s string) ([]byte, error) {
	normalized := normalizeBase32(s)
	if normalized == "" {
		return nil, fmt.Errorf("otp secret is empty")
	}
	decoded, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(normalized)
	if err != nil {
		return nil, fmt.Errorf("invalid Base32 secret: %w", err)
	}
	if len(decoded) == 0 {
		return nil, fmt.Errorf("otp secret decodes to zero bytes")
	}
	return decoded, nil
}

// ParseOTPAuth parses and validates an otpauth:// TOTP URI. HOTP URIs and
// unknown algorithm values are rejected loudly.
func ParseOTPAuth(rawURI string) (*OTPConfig, error) {
	u, err := url.Parse(strings.TrimSpace(rawURI))
	if err != nil {
		return nil, fmt.Errorf("invalid otpauth URI: %w", err)
	}
	if !strings.EqualFold(u.Scheme, "otpauth") {
		return nil, fmt.Errorf("not an otpauth:// URI")
	}

	switch typ := strings.ToLower(u.Host); typ {
	case "totp":
		// supported
	case "hotp":
		return nil, fmt.Errorf("HOTP is not supported (counter-based OTP would break sync); use a TOTP URI")
	default:
		return nil, fmt.Errorf("unsupported otpauth type %q (expected totp)", u.Host)
	}

	q := u.Query()

	secret := q.Get("secret")
	if secret == "" {
		return nil, fmt.Errorf("otpauth URI is missing the secret parameter")
	}
	decoded, err := decodeBase32Secret(secret)
	if err != nil {
		return nil, err
	}

	algorithm := otpDefaultAlgorithm
	if a := q.Get("algorithm"); a != "" {
		algorithm = strings.ToUpper(a)
	}
	switch algorithm {
	case "SHA1", "SHA256", "SHA512":
		// supported
	default:
		return nil, fmt.Errorf("unknown OTP algorithm %q (expected SHA1, SHA256 or SHA512)", algorithm)
	}

	digits := otpDefaultDigits
	if d := q.Get("digits"); d != "" {
		n, err := strconv.Atoi(d)
		if err != nil || n < 1 || n > 8 {
			return nil, fmt.Errorf("invalid OTP digits %q (expected 1-8)", d)
		}
		digits = n
	}

	period := otpDefaultPeriod
	if p := q.Get("period"); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || n < 1 {
			return nil, fmt.Errorf("invalid OTP period %q (expected a positive integer)", p)
		}
		period = n
	}

	return &OTPConfig{
		Secret:    decoded,
		Algorithm: algorithm,
		Digits:    digits,
		Period:    period,
		Label:     strings.TrimPrefix(u.Path, "/"),
		Issuer:    q.Get("issuer"),
	}, nil
}

// Generate computes the TOTP code for the given time (RFC 6238 / RFC 4226).
func (c *OTPConfig) Generate(t time.Time) (string, error) {
	if c.Period <= 0 {
		return "", fmt.Errorf("invalid OTP period")
	}
	counter := uint64(t.Unix()) / uint64(c.Period)

	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], counter)

	var mac hash.Hash
	switch c.Algorithm {
	case "SHA1":
		mac = hmac.New(sha1.New, c.Secret)
	case "SHA256":
		mac = hmac.New(sha256.New, c.Secret)
	case "SHA512":
		mac = hmac.New(sha512.New, c.Secret)
	default:
		return "", fmt.Errorf("unknown OTP algorithm %q", c.Algorithm)
	}
	mac.Write(buf[:])
	sum := mac.Sum(nil)

	// Dynamic truncation (RFC 4226 §5.3).
	offset := sum[len(sum)-1] & 0x0f
	binCode := (uint32(sum[offset]&0x7f) << 24) |
		(uint32(sum[offset+1]) << 16) |
		(uint32(sum[offset+2]) << 8) |
		uint32(sum[offset+3])

	mod := uint32(1)
	for i := 0; i < c.Digits; i++ {
		mod *= 10
	}
	return fmt.Sprintf("%0*d", c.Digits, binCode%mod), nil
}

// OTPSecondsRemaining returns how many seconds are left in the current period.
func OTPSecondsRemaining(period int, t time.Time) int {
	if period <= 0 {
		period = otpDefaultPeriod
	}
	return period - int(t.Unix()%int64(period))
}

// canonicalOTPURI builds an otpauth://totp URI from a normalized Base32 secret,
// using the entry key as both the label and the issuer.
func canonicalOTPURI(normalizedSecret, entryKey string) string {
	q := url.Values{}
	q.Set("secret", normalizedSecret)
	q.Set("issuer", entryKey)
	q.Set("algorithm", otpDefaultAlgorithm)
	q.Set("digits", strconv.Itoa(otpDefaultDigits))
	q.Set("period", strconv.Itoa(otpDefaultPeriod))
	return "otpauth://totp/" + url.PathEscape(entryKey) + "?" + q.Encode()
}

// NormalizeOTP accepts either a full otpauth:// TOTP URI or a bare Base32
// secret and returns a canonical otpauth:// URI ready to persist. A bare secret
// is wrapped using RFC defaults and the entry key as label/issuer. The input is
// fully validated and a code is test-generated before returning, so persisting
// the result can never store an unusable seed.
func NormalizeOTP(input, entryKey string) (string, error) {
	input = strings.TrimSpace(input)
	if input == "" {
		return "", fmt.Errorf("otp input is empty")
	}

	var uri string
	lower := strings.ToLower(input)
	switch {
	case strings.HasPrefix(lower, "otpauth://"):
		uri = input
	case strings.HasPrefix(lower, "otpauth-migration://"):
		return "", fmt.Errorf("otpauth-migration:// (bulk export) URIs are not supported; provide a single otpauth://totp/ URI")
	default:
		uri = canonicalOTPURI(normalizeBase32(input), entryKey)
	}

	cfg, err := ParseOTPAuth(uri)
	if err != nil {
		return "", err
	}
	if _, err := cfg.Generate(time.Now()); err != nil {
		return "", err
	}
	return uri, nil
}

// GenerateOTP parses an otpauth URI and returns the current code together with
// the number of seconds remaining in the period.
func GenerateOTP(rawURI string, t time.Time) (code string, secondsRemaining int, err error) {
	cfg, err := ParseOTPAuth(rawURI)
	if err != nil {
		return "", 0, err
	}
	code, err = cfg.Generate(t)
	if err != nil {
		return "", 0, err
	}
	return code, OTPSecondsRemaining(cfg.Period, t), nil
}

// MaskOTPSecret returns the URI with the secret parameter value replaced by
// "****", leaving the rest readable. Used so `get --all` never prints the seed
// unless the caller explicitly asks to reveal it.
func MaskOTPSecret(rawURI string) string {
	return secretParamRe.ReplaceAllString(rawURI, "${1}****")
}
