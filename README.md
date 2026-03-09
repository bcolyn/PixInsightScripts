# PixInsight Scripts

Personal collection of PJSR (PixInsight JavaScript Runtime) scripts.

## Scripts

### ExternalToolsLauncher

A dialog-based manager for configuring and launching external programs (like, for example your own astropy scripts) from within PixInsight. Supports a persistent list of tools, token substitution in argument templates (e.g. `{fits_path}`, `{output_dir}`), automatic FITS export of the active image, and live capture of process stdout/stderr in the PixInsight console.

### ExportForArchive

Exports all currently open images as compressed XISF files to a chosen directory, and saves their full processing history as a `.xpsm` process container file and a human-readable `.log` summary. Useful for long-term archival of a finished project in a disk-space saving and open data format way.

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
