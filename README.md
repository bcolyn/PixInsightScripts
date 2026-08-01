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

Builds a protection mask straight from an annotations SVG exported from an annotated image (e.g. Script > Render > AnnotateImage, "Export as SVG"). Parses the SVG via PJSR's XMLDocument DOM, composes each shape's `<g transform="matrix(...)">`, and rasterizes every `<ellipse>`/`<circle>` annotation as a filled shape on a new mono mask image (annotation labels and crosshair marks are ignored). Optional grow/feather and invert. Requires PixInsight 1.9.4 "Lockhart" or later.

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
