# PixInsight Scripts

Personal collection of PJSR (PixInsight JavaScript Runtime) scripts.

## Scripts

### ExternalToolsLauncher

A dialog-based manager for configuring and launching external programs (like, for example your own astropy scripts) from within PixInsight. Supports a persistent list of tools, token substitution in argument templates (e.g. `{fits_path}`, `{output_dir}`), automatic FITS export of the active image, and live capture of process stdout/stderr in the PixInsight console.

### ExportForArchive

Exports all currently open images as compressed XISF files to a chosen directory, and saves their full processing history as a `.xpsm` process container file and a human-readable `.log` summary. Useful for long-term archival of a finished project in a disk-space saving and open data format way.

### 3-way Compare

Tiles the three most recently used image windows side-by-side horizontally, each filling one column at full workspace height. Designed for ultrawide monitors. If fewer than three windows are open, tiles however many exist.

### Aster

A V8-runtime PJSR port of Aster (originally for Siril/sirilpy), for adding a soft glow and optional diffraction spikes to a stretched, stars-only image. Supports Newtonian (4-arm) and JWST-style (6+2-arm) spike patterns, spectral (rainbow) diffraction tinting, and exclusion masks for glow and spikes independently. Requires PixInsight 1.9.4 "Lockhart" or later.

### Annotation To Mask

Builds a protection mask straight from an annotations SVG exported from an annotated image (e.g. Script > Render > AnnotateImage, "Export as SVG"). Parses the SVG via PJSR's XMLDocument DOM, composes each shape's `<g transform="matrix(...)">`, and rasterizes every `<ellipse>`/`<circle>` annotation as a filled shape on a new mono mask image (text labels are ignored). Sizeless DSOs, which get a 4-tick crosshair instead of a sized shape, can optionally be protected too as a plain circle of configurable radius. Optional grow/feather and invert. Requires PixInsight 1.9.4 "Lockhart" or later.

---

## Local Installation (without a script repository)

1. Copy the `.js` file(s) to a permanent location on your machine, e.g.:
   ```
   C:\Users\<you>\Documents\PixInsight\Scripts\
   ```

2. In PixInsight, open **Script > Feature Scripts…**

3. Click **Add**, navigate to the folder containing the script(s), and confirm.

4. The scripts will appear in the **Script** menu under the category declared in their `#feature-id` directive (e.g. **Script > Utilities**).

5. To make the scripts available across sessions, ensure the folder is listed under **Edit > Preferences > Script Directories** (PixInsight 1.8.9+), or simply leave them registered via Feature Scripts — PixInsight remembers registered scripts between sessions.

## Installation via update repository

This repository doubles as a [PixInsight update repository](https://pixinsight.com/doc/docs/PIRepositoryReference/PIRepositoryReference.html). Add it in **Resources > Updates > Manage Repositories…**, using the raw GitHub URL of the `release/` directory, e.g.:

```
https://raw.githubusercontent.com/<you>/PixInsightScripts/master/release/
```

Then run **Resources > Updates > Check for Updates…** to install/update all scripts under `Script` categories declared by their `#feature-id` directives.

### Publishing a new release

After changing any script, regenerate the repository files:

```
python build-release.py
```

This rebuilds `release/bcolyn-scripts-<timestamp>.zip` (all `.js` files, packaged under `src/scripts/bcolyn/`) and `release/updates.xri`. The timestamped filename changes on every build so CDN/proxy caches (e.g. raw.githubusercontent.com) never serve a stale zip for a new `updates.xri`; the previous zip is deleted automatically since only the latest is ever referenced.

If signing the release (see below), sign the scripts *before* this step and sign `updates.xri` *after* it. Otherwise, just commit and push `release/`.

### Code signing

Scripts and `updates.xri` can be signed with a Certified PixInsight Developer (or local) signing identity, using [tools/SignRelease.js](tools/SignRelease.js) — a PJSR script run from inside PixInsight (**Script > Feature Scripts…**, add `tools/`, then **Script > Development > Sign Release**). It needs a `.xssk` secure signing keys file, created once via PixInsight's built-in **SigningKeys** script.

Full release cycle, once a `.xssk` file exists:

1. In PixInsight, run **Sign Release > Sign Scripts (.js → .xsgn)** — signs every `.js` at the repo root, writing a companion `<name>.xsgn` beside each.
2. `python build-release.py` — bundles each `.js` together with its `.xsgn` (if present) into the zip, and writes an unsigned `updates.xri`.
3. In PixInsight, run **Sign Release > Sign updates.xri** — signs the freshly rebuilt `updates.xri` in place (must happen *after* step 2, since the signature covers the final file contents).
4. Commit and push `release/`.

The `.xssk` file and the loose `.xsgn` files at the repo root are gitignored — never commit private key material. The `.xsgn` files only need to exist long enough for step 2 to bundle them into the zip.

If a repository isn't signed, PixInsight just asks for a one-time confirmation before downloading from it — signing removes that prompt and lets the installed scripts themselves carry a verifiable signature.
