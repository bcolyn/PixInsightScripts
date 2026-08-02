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

This rebuilds `release/bcolyn-scripts-<timestamp>.zip` (all `.js` files, packaged under `src/scripts/bcolyn/`) and `release/updates.xri`. The timestamped filename changes on every build so CDN/proxy caches (e.g. raw.githubusercontent.com) never serve a stale zip for a new `updates.xri`; the previous zip is deleted automatically since only the latest is ever referenced.

If signing the release (see below), sign the scripts *before* this step and sign `updates.xri` *after* it. Otherwise, just commit and push `release/`.

## Code signing

Scripts and `updates.xri` can be signed with a Certified PixInsight Developer (or local) signing identity, using [tools/SignRelease.js](tools/SignRelease.js) — a PJSR script run from inside PixInsight (**Script > Feature Scripts…**, add `tools/`, then **Script > Development > Sign Release**). It needs a `.xssk` secure signing keys file, created once via PixInsight's built-in **SigningKeys** script.

Full release cycle, once a `.xssk` file exists:

1. In PixInsight, run **Sign Release > Sign Scripts (.js → .xsgn)** — signs every `.js` at the repo root, writing a companion `<name>.xsgn` beside each.
2. `python build-release.py` — bundles each `.js` together with its `.xsgn` (if present) into the zip, and writes an unsigned `updates.xri`.
3. In PixInsight, run **Sign Release > Sign updates.xri** — signs the freshly rebuilt `updates.xri` in place (must happen *after* step 2, since the signature covers the final file contents).
4. Commit and push `release/`.

The `.xssk` file and the loose `.xsgn` files at the repo root are gitignored — never commit private key material. The `.xsgn` files only need to exist long enough for step 2 to bundle them into the zip.

If a repository isn't signed, PixInsight just asks for a one-time confirmation before downloading from it — signing removes that prompt and lets the installed scripts themselves carry a verifiable signature.
