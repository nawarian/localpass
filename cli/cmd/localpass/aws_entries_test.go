package main

// Regression test for the "AWS SSO" / "AWS" report: two entries sharing
// username and password but with different OTPs must round-trip through sync
// as two separate entries, each with its own OTP. Uses temp stores and an
// in-process S3 stand-in only.

import (
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"sync"
	"testing"

	"github.com/nawarian/localpass/cli/internal/config"
	"github.com/nawarian/localpass/cli/internal/store"
)

const (
	ssoOTP = "otpauth://totp/AWS%20SSO:alice?secret=JBSWY3DPEHPK3PXP&issuer=AWS%20SSO"
	awsOTP = "otpauth://totp/Amazon%20Web%20Services:alice@123456789012?secret=KRSXG5CTMVRXEZLUKN2XAZLSKNSWG4TFOQ&issuer=Amazon%20Web%20Services"
)

// plainS3 stores one object per path with unconditional PUTs, like S3 does
// for the requests main sends.
func plainS3(t *testing.T) *httptest.Server {
	var mu sync.Mutex
	objects := map[string][]byte{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch r.Method {
		case http.MethodPut:
			body, _ := io.ReadAll(r.Body)
			objects[r.URL.Path] = body
		case http.MethodGet, http.MethodHead:
			data, ok := objects[r.URL.Path]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			if r.Method == http.MethodGet {
				w.Write(data)
			}
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func reproEnv(t *testing.T) string {
	srv := plainS3(t)
	t.Setenv("AWS_ACCESS_KEY_ID", "AKID")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "SECRET")
	t.Setenv("AWS_REGION", "us-east-1")
	t.Setenv("S3_ENDPOINT", srv.URL)
	cfg := filepath.Join(t.TempDir(), "config.json")
	config.SaveConfig(cfg, &config.Config{S3Bucket: "bucket", S3Key: "vault.enc", AutoSync: true})
	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
	return cfg
}

func setEntry(store, cfg, key, otp string) {
	runSet([]string{key, "--store-path", store, "--config-path", cfg, "--password", "same-password",
		"--username", "alice", "--url", "", "--notes", "", "--meta", "otp=" + otp})
}

func entries(t *testing.T, path string) map[string]string {
	t.Helper()
	v, err := store.LoadStore(path, "pass")
	if err != nil {
		t.Fatalf("LoadStore: %v", err)
	}
	out := map[string]string{}
	for k, e := range v.Entries {
		out[k] = e.Metadata["otp"]
	}
	return out
}

func TestSyncKeepsEntriesWithSharedCredentialsApart(t *testing.T) {
	cfg := reproEnv(t)
	dev := filepath.Join(t.TempDir(), "store.json")
	runInit([]string{"--store-path", dev})
	setEntry(dev, cfg, "AWS SSO", ssoOTP)
	setEntry(dev, cfg, "AWS", awsOTP)

	fresh := filepath.Join(t.TempDir(), "store.json")
	runPull([]string{"--store-path", fresh, "--config-path", cfg, "--force"})
	want := map[string]string{"AWS SSO": ssoOTP, "AWS": awsOTP}
	if got := entries(t, fresh); !reflect.DeepEqual(got, want) {
		t.Fatalf("remote = %v, want %v", got, want)
	}
}
