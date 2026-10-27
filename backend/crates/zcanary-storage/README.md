# zcanary-storage

Bounded local storage for opaque source or recipient identity secret bundles.
The library uses `age` 0.12.1 passphrase encryption (scrypt recipient and
identity) and keeps decrypted buffers in zeroizing allocations. The encrypted
file includes a public `ZCID` format/version prefix; role, identity ID, inner
version, and opaque secret bytes are encoded only inside the age ciphertext.
Opening requires the caller's expected role and identity ID.

`MAX_PLAINTEXT_BYTES` is 64 KiB. Ciphertext reads and imports have a fixed
upper bound. Imports cap age's scrypt work factor at log2(N)=19, about 512 MiB
of working memory per stanza using age 0.12.1's r=8, p=1 parameters. Age's
decryption default can be higher. Encryption retains age's adaptive default
work factor; export decrypts its result under this crate's own policy and fails
with `WorkFactorTooHigh` if the host selected a work factor that import would
reject. This is a denial-of-service bound for untrusted backup files, not a
reduced encryption work factor. Empty passphrases are rejected; callers should
apply any stronger passphrase policy they require.

`save_new` and `save_export_new` stage and sync ciphertext beside the requested
destination, then atomically create the destination with a hard link. Existing
destinations are preserved, and readers do not see a partially written target.
This depends on same-directory hard-link support from the destination
filesystem. The file contents are synced before linking, but the parent
directory is not synced; sudden power-loss durability of the new directory
entry is therefore platform/filesystem dependent. The caller chooses and
protects the passphrase and file path. No plaintext serialization, wallet key
handling, CLI, or API is provided here.

This is a prototype library and has not received an independent security audit.
Tests should use synthetic secrets only. Cargo build/test execution is owned by
the workspace integration task.
