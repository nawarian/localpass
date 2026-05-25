# 📓 Changelog

All notable changes to the **localpass** Firefox extension. Newest on top. 🚀

## Unreleased

- 🔑 **Two-factor codes (TOTP).** Entries can now carry a one-time-password secret. Paste an `otpauth://` URI or a bare Base32 secret into the edit form, and the item view shows the live 6–8 digit code with a countdown ring — click it to copy. Codes are computed from this device's clock.

## 1.1.0 — 2026-05-25

- 🔐 **Smarter auto-lock.** The vault now stays open while you're actually using it and only locks after a stretch of inactivity — no more getting kicked out mid-task by a fixed timer.
- 💾 **The popup remembers what you were doing.** Switched windows and the popup vanished? Your half-typed password, open edit, search, and even the master password you were typing all come back next time you open it. (Kept in memory only, always wiped when the vault locks. 🧹)
- ✨ **Freshly rebuilt UI.** The popup, options page, and on-page autofill menu were rebuilt on Preact — snappier, smoother, and no more pesky search-box focus quirks.

## 1.0.0 — Initial release 🎉

- 🦊 First public release of localpass on addons.mozilla.org.
