# Developer Notes

Notes for maintaining this repository and installing scripts without the update repository.

## Local Installation (without a script repository)

1. Copy the `.js` file(s) to a permanent location on your machine, e.g.:
   ```
   C:\Users\<you>\Documents\PixInsight\Scripts\
   ```

2. In PixInsight, open **Script > Feature Scripts…**

3. Click **Add**, navigate to the folder containing the script(s), and confirm.

4. The scripts will appear in the **Script** menu under the category declared in their `#feature-id` directive (e.g. **Script > Utilities**).

5. To make the scripts available across sessions leave them registered via Feature Scripts — PixInsight remembers registered scripts between sessions.

## Publishing a new release

After changing any script, regenerate the repository files:

```
python build-release.py
```

This builds two update repositories:

- `release/` — the **signed** repository: every `.js` in the repo root (bundled with its `.xsgn`), packaged under `src/scripts/bcolyn/`, plus `updates.xri`.
- `release-unsigned/` — the **unsigned** repository: every `.js` in `unsigned/` (never signed, no `.xsgn` bundled), plus its own `updates.xri` that is never signed. Scripts that must not be signed (currently `ExternalToolsLauncher.js`) live in `unsigned/`.

To move a script between the two, move the `.js` between the repo root and `unsigned/` (and delete its `.xsgn` when moving it to `unsigned/`).

Each repository gets a new `bcolyn-scripts[-unsigned]-<timestamp>.zip` and `updates.xri`. The timestamped filename changes on every build so CDN/proxy caches (e.g. raw.githubusercontent.com) never serve a stale zip for a new `updates.xri`; the previous zip is deleted automatically since only the latest is ever referenced.

If signing the release (see below), sign the scripts *before* this step and sign `release/updates.xri` *after* it (`release-unsigned/` needs no signing). Otherwise, just commit and push `release/` and `release-unsigned/`.

## Code signing

Scripts in the repo root and `release/updates.xri` can be signed with a Certified PixInsight Developer (or local) signing identity, using PixInsight's built-in **CodeSign** script (**Script > Development > CodeSign**). It needs a `.xssk` secure signing keys file, created once via PixInsight's built-in **SigningKeys** script.

Full release cycle, once a `.xssk` file exists:

1. In PixInsight, run **Script > Development > CodeSign** on every `.js` at the repo root (not the ones in `unsigned/`), writing a companion `<name>.xsgn` beside each.
2. `python build-release.py` — bundles each `.js` together with its `.xsgn` (if present) into the zip, and writes an unsigned `updates.xri`.
3. In PixInsight, run **Script > Development > CodeSign** on the freshly rebuilt `release/updates.xri`, signing it in place (must happen *after* step 2, since the signature covers the final file contents).
4. Commit and push `release/` and `release-unsigned/`.

The `.xssk` file and the loose `.xsgn` files at the repo root are gitignored — never commit private key material. The `.xsgn` files only need to exist long enough for step 2 to bundle them into the zip.

If a repository isn't signed, PixInsight just asks for a one-time confirmation before downloading from it — signing removes that prompt and lets the installed scripts themselves carry a verifiable signature.
