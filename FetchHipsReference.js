#engine v8
/*
 * FetchHipsReference -- downloads a reference image cutout from a CDS HiPS
 * survey (SDSS9, DSS2, PanSTARRS, ...) matching the astrometric solution of
 * an open image, via the hips2fits service:
 *
 *    https://alasky.cds.unistra.fr/hips-image-services/hips2fits
 *
 * PixInsight's own astrometric solutions (as produced by ImageSolver) are
 * not written back into standard FITS WCS keywords -- they live in view
 * properties, read here through the core's own AstrometricMetadata class
 * (<pjsr/astrometry/AstrometricMetadata.js>), the same one AnnotateImage
 * and friends use. No hard-coded PixInsight installation path needed.
 *
 * The cutout is requested at the source image's pixel dimensions, field of
 * view and rotation, so it lands (near enough) pixel-aligned with it --
 * handy as a ground truth when checking whether faint structure is real.
 *
 * (c) Benny Colyn 2026. MIT License (see repository LICENSE).
 */

#feature-id    bcolyn.FetchHipsReference : Utilities > Fetch HiPS Reference

#feature-info  Downloads a reference image cutout from a CDS HiPS survey (DSS2, SDSS9, \
               PanSTARRS, in colour or single band) matching the astrometric solution of an \
               open, plate-solved image, using the hips2fits service. The cutout is requested \
               at the source image's dimensions, field of view and rotation -- mirrored \
               solutions included -- so it can be blinked against the original to check \
               whether faint structure is real. A blank result is not an error: it means the \
               chosen survey has no coverage at those coordinates. FITS cutouts of the 16-bit \
               single-band surveys can optionally be rescaled to [0,1], since they otherwise \
               open as a flat grey. Requires PixInsight 1.9.4 "Lockhart" or later and an \
               image with an astrometric solution.

#define APP_TITLE       "Fetch HiPS Reference"
#define SETTINGS_MODULE "FETCHHIPSREFERENCE"
#define REFERENCE_ID    "hips_reference"
#define HIPS2FITS_URL   "https://alasky.cds.unistra.fr/hips-image-services/hips2fits"

// Sizers, FrameStyle, StdButton, StdIcon and TextAlignment are native objects
// under the v8 runtime, so their .jsh headers aren't needed -- those only
// define the old flat StdIcon_Error / TextAlign_Right style constants for the
// legacy engine. Real library code still has to be included, though.
#include <pjsr/astrometry/AstrometricMetadata.js>

CoreApplication.ensureMinimumVersion(1, 9, 4);

// ---------------------------------------------------------------------------
// Surveys
// ---------------------------------------------------------------------------

// A small starter list -- extend freely. The full catalog of available HiPS
// identifiers lives at https://aladin.cds.unistra.fr/hips/list
const HIPS_SURVEYS = [
   [ "SDSS9 color",         "CDS/P/SDSS9/color" ],
   [ "SDSS9 u",             "CDS/P/SDSS9/u" ],
   [ "SDSS9 g",             "CDS/P/SDSS9/g" ],
   [ "SDSS9 r",             "CDS/P/SDSS9/r" ],
   [ "SDSS9 i",             "CDS/P/SDSS9/i" ],
   [ "SDSS9 z",             "CDS/P/SDSS9/z" ],
   [ "DSS2 color",          "CDS/P/DSS2/color" ],
   [ "DSS2 blue (XJ+S)",    "CDS/P/DSS2/blue" ],
   [ "DSS2 red (F+R)",      "CDS/P/DSS2/red" ],
   [ "DSS2 NIR (XI+IS)",    "CDS/P/DSS2/NIR" ],
   [ "PanSTARRS DR1 color", "CDS/P/PanSTARRS/DR1/color-z-zg-g" ]
];

// DSS2 is the widest-coverage survey of the lot -- SDSS9 and PanSTARRS both
// leave large parts of the sky empty, so they make poor defaults.
const DEFAULT_SURVEY = "CDS/P/DSS2/color";

const FORMATS = [ "fits", "jpg" ];

// The color HiPS surveys are built from 8-bit JPEG/PNG tiles, so their FITS
// cutouts carry no more real signal than the JPEG does -- just eight times the
// bytes and a much slower server-side render. Since the default survey is a
// color one, default to JPEG too. FITS is worth switching to for the
// single-band surveys (DSS2 blue/red/NIR, SDSS9 u/g/r/i/z), whose tiles are
// 16-bit FITS per the CDS MocServer and so do preserve the survey's
// photometry.
const DEFAULT_FORMAT = "jpg";

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

function FetchHipsParameters() {
   this.sourceWindow = null;      // ImageWindow to match; set by main()/dialog
   this.survey = DEFAULT_SURVEY;
   this.format = DEFAULT_FORMAT;
   this.rescaleFits = true;       // only consulted when format is fits
}

// ---------------------------------------------------------------------------
// Astrometry -- everything the request needs, read from the solution
// ---------------------------------------------------------------------------

// Rotation to request from hips2fits, in degrees, plus whether the solution is
// mirrored. Returns null when the solution carries no linear transformation.
//
// ref_I_G_linear maps image pixels to the native gnomonic plane, whose x axis
// points toward *decreasing* right ascension per the FITS WCS convention, and
// whose y axis points north while the image's runs downward. Writing an
// unmirrored solution rotated by p as
//
//    ref_I_G_linear = -scale * R(p)
//
// the service wants p, and the two available derivations give:
//
//    unmirrored      atan2(c,a) = p + 180      -GetRotation() = p
//    mirrored (M*F)  atan2(c,a) = p            -GetRotation() = -p
//
// so each case needs its own. GetRotation() -- the same value ImageSolver and
// AnnotateImage print in their summaries -- carries the unmirrored case, since
// averaging over both matrix columns makes it the more robust of the two when
// a solution has a little skew in it. The mirrored case, where GetRotation()
// applies its own -90 - r correction and comes out sign-reversed, reads the
// first matrix column directly instead.
function rotationFromSolution(metadata) {
   let rotation = metadata.GetRotation();   // [ degrees, flipped ]
   if (rotation == null)
      return null;

   let mirrored = rotation[1];
   if (!mirrored)
      return [ -rotation[0], false ];

   let M = metadata.ref_I_G_linear;
   return [ FMath.deg(Math.atan2(M.at(1, 0), M.at(0, 0))), true ];
}

// Reads the astrometric solution of a window and returns the hips2fits query
// parameters describing it. Throws if there is no usable solution.
function solutionToQuery(window) {
   if (!window.hasAstrometricSolution)
      throw new Error("\"" + window.mainView.id + "\" has no astrometric solution. " +
         "Plate-solve it first (Script > Image Analysis > ImageSolver).");

   let metadata = new AstrometricMetadata(SETTINGS_MODULE);
   metadata.ExtractMetadata(window);

   if (metadata.ra == null || metadata.dec == null || metadata.resolution == null)
      throw new Error("The astrometric solution of \"" + window.mainView.id + "\" is " +
         "incomplete: no center coordinates or image scale could be read from it.");

   let rotation = rotationFromSolution(metadata);
   if (rotation == null) {
      console.warningln(APP_TITLE + ": no linear transformation in the solution; " +
         "requesting the cutout unrotated. Fine for eyeballing, not for registration.");
      rotation = [ 0, false ];
   }

   return {
      ra: metadata.ra,
      dec: metadata.dec,
      // metadata.resolution is in degrees per pixel, so the field of view
      // along the largest image dimension follows directly.
      fov: Math.max(metadata.width, metadata.height) * metadata.resolution,
      rotation: rotation[0],
      // hips2fits only ever renders an unmirrored view of the sky, so a
      // mirrored solution is matched by rotating to p and mirroring the
      // delivered cutout horizontally afterwards.
      mirrored: rotation[1],
      width: Math.round(metadata.width),
      height: Math.round(metadata.height)
   };
}

function buildURL(query, survey, format) {
   return HIPS2FITS_URL +
      "?hips=" + encodeURIComponent(survey) +
      "&width=" + query.width +
      "&height=" + query.height +
      "&ra=" + query.ra +
      "&dec=" + query.dec +
      "&fov=" + query.fov +
      "&projection=TAN" +   // gnomonic, matching ImageSolver's default
      "&rotation_angle=" + query.rotation +
      "&format=" + format;
}

// ---------------------------------------------------------------------------
// Downloading
// ---------------------------------------------------------------------------

// Downloads through the core's own NetworkTransfer object. setSSL() is
// mandatory for https URLs -- without it the transfer fails outright.
function download(url, outputPath) {
   let transfer = new NetworkTransfer;
   transfer.setSSL();
   transfer.setURL(url);
   transfer.data = new ByteArray;
   transfer.onDownloadDataAvailable = function(moreData) {
      this.data.add(moreData);
      return true;
   };
   transfer.onTransferProgress = function(downloadTotal, downloadCurrent) {
      if (downloadTotal > 0)
         console.write(format("<end><clrbol>%s: %u of %u bytes (%d%%)",
            APP_TITLE, downloadCurrent, downloadTotal,
            Math.round(100.0*downloadCurrent/downloadTotal)));
      else
         console.write(format("<end><clrbol>%s: %u bytes received", APP_TITLE, downloadCurrent));
      CoreApplication.processEvents();
      return true;
   };

   let ok = transfer.download();
   console.writeln();
   if (!ok)
      throw new Error("Transfer failed: " + transfer.errorInformation);

   // A completed transfer only means the exchange finished, not that a cutout
   // came back: hips2fits reports a bad survey id or an out-of-range parameter
   // as a 4xx carrying a short text or JSON explanation. Without this check
   // that explanation gets written out as if it were the image, and the only
   // symptom is an unreadable file several steps later.
   if (transfer.responseCode >= 400)
      throw new Error("The service returned HTTP " + transfer.responseCode + ": " +
         errorBodyText(transfer.data));
   if (transfer.data.length == 0)
      throw new Error("The service returned an empty response (HTTP " +
         transfer.responseCode + ").");

   File.writeFile(outputPath, transfer.data);
}

// Renders an error body for a message. These are short by nature, so a couple
// of lines is enough to name the problem; collapse the whitespace so a JSON or
// HTML payload stays on one console line.
function errorBodyText(data) {
   const LIMIT = 600;
   // ByteArray.toString() takes an optional byte range, not an encoding name --
   // utf8ToString() is the one that decodes. Both take (startIndex, count), so
   // the body is capped as it is read rather than decoded in full first.
   let text = data.utf8ToString(0, Math.min(data.length, LIMIT));

   // The service's own parameter errors are short text or JSON and are worth
   // quoting verbatim, but a mistyped path or a proxy answers with a whole HTML
   // page. Reduce that to its <title>, which is the one line that names the
   // status, and drop the markup.
   if (/<html|<!doctype/i.test(text)) {
      let title = /<title[^>]*>([^<]*)</i.exec(text);
      if (title)
         text = title[1];   // otherwise fall through to plain tag stripping
   }
   // Both the console and MessageBox render rich text, so any surviving markup
   // would be interpreted rather than shown. Strip tags, then neutralize stray
   // angle brackets, and put it all on one line.
   text = text.replace(/<[^>]*>/g, " ").replace(/[<>]/g, " ")
              .replace(/\s+/g, " ").trim();

   if (text.length == 0)
      return "(no readable message in the response body)";
   return (text.length > 200) ? text.substring(0, 200) + "..." : text;
}

// ---------------------------------------------------------------------------
// Dialog -- a class declaration is safe under the v8 engine selector, which
// gives every execution a fresh runtime (see Aster for the details).
// ---------------------------------------------------------------------------

class FetchHipsDialog extends Dialog {
   constructor(p, windows) {
   super();
   let dlg = this;

   this.windowTitle = APP_TITLE;
   this.minWidth = 440;

   this.info = new Label(this);
   this.info.frameStyle = FrameStyle.Box;
   this.info.margin = 4;
   this.info.wordWrapping = true;
   this.info.useRichText = true;
   this.info.text = "<p>Downloads a survey cutout matching the astrometric solution of the " +
      "selected image, at its dimensions, field of view and rotation. The result is opened " +
      "as <i>" + REFERENCE_ID + "</i>, numbered if one is already open.</p>" +
      "<p>A blank cutout is not an error: it means the chosen survey has no coverage at " +
      "these coordinates. DSS2 is all-sky; SDSS9 covers roughly a third of it, and " +
      "PanSTARRS stops south of about -30&deg; declination.</p>";

   function labelFor(text) {
      let label = new Label(dlg);
      label.text = text;
      label.minWidth = 100;
      label.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;
      return label;
   }

   function row(text, control) {
      let sizer = new HorizontalSizer;
      sizer.spacing = 6;
      sizer.add(labelFor(text));
      sizer.add(control, 100);
      return sizer;
   }

   this.sourceCombo = new ComboBox(this);
   for (let i = 0; i < windows.length; ++i)
      this.sourceCombo.addItem(windows[i].mainView.id);
   this.sourceCombo.currentItem = FMath.max(0, indexOfWindow(windows, p.sourceWindow));
   this.sourceCombo.onItemSelected = function(index) { p.sourceWindow = windows[index]; };

   this.surveyCombo = new ComboBox(this);
   for (let i = 0; i < HIPS_SURVEYS.length; ++i)
      this.surveyCombo.addItem(HIPS_SURVEYS[i][0]);
   this.surveyCombo.currentItem = FMath.max(0, HIPS_SURVEYS.findIndex(s => s[1] == p.survey));
   this.surveyCombo.onItemSelected = function(index) { p.survey = HIPS_SURVEYS[index][1]; };

   this.formatCombo = new ComboBox(this);
   for (let i = 0; i < FORMATS.length; ++i)
      this.formatCombo.addItem(FORMATS[i]);
   this.formatCombo.currentItem = FMath.max(0, FORMATS.indexOf(p.format));
   this.formatCombo.onItemSelected = function(index) {
      p.format = FORMATS[index];
      dlg.rescaleCheck.enabled = (p.format == "fits");
   };

   this.rescaleCheck = new CheckBox(this);
   this.rescaleCheck.text = "Rescale to [0,1]";
   this.rescaleCheck.toolTip = "<p>The single-band surveys are 16-bit and fill only a small " +
      "part of that range, so an unscaled FITS cutout opens as a flat, low-contrast grey. " +
      "Rescaling makes it " +
      "readable at a glance, but shifts the pixel values &mdash; turn it off to keep the " +
      "survey's own numbers.</p>";
   this.rescaleCheck.checked = p.rescaleFits;
   this.rescaleCheck.enabled = (p.format == "fits");
   this.rescaleCheck.onCheck = function(checked) { p.rescaleFits = checked; };

   this.okButton = new PushButton(this);
   this.okButton.text = "Fetch";
   this.okButton.defaultButton = true;
   this.okButton.onClick = function() { dlg.ok(); };

   this.cancelButton = new PushButton(this);
   this.cancelButton.text = "Cancel";
   this.cancelButton.onClick = function() { dlg.cancel(); };

   this.buttonsSizer = new HorizontalSizer;
   this.buttonsSizer.spacing = 6;
   this.buttonsSizer.addStretch();
   this.buttonsSizer.add(this.okButton);
   this.buttonsSizer.add(this.cancelButton);

   this.sizer = new VerticalSizer;
   this.sizer.margin = 8;
   this.sizer.spacing = 6;
   this.sizer.add(this.info);
   this.sizer.addSpacing(4);
   this.sizer.add(row("Source image:", this.sourceCombo));
   this.sizer.add(row("HiPS survey:", this.surveyCombo));
   this.sizer.add(row("Format:", this.formatCombo));
   this.sizer.add(this.rescaleCheck);
   this.sizer.addSpacing(8);
   this.sizer.add(this.buttonsSizer);

   this.adjustToContents();
   this.setFixedHeight();
   } // constructor
} // class FetchHipsDialog

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Mirrors the delivered cutout left to right, matching a mirrored solution.
// FastRotation (rather than Image.mirrorHorizontal()) so the flip is recorded
// in the reference image's process history, where it is visible next to the
// mirror warning in the console.
// The enumeration parameter is FastRotation.mode, per the PJSR reference. The
// Geometry module's binary registers the PCL-side identifier "Transformation"
// next to the element ids, but PCL parameter names do not always reach PJSR
// unchanged -- the property to assign here is mode.
// Stretches the cutout to fill [0,1]. The single-band HiPS are 16-bit and carry
// the survey's own values, which occupy a narrow band well inside that range,
// so PixInsight's normalization against the full 16-bit range opens them as a
// flat, low-contrast grey -- not black, since the band sits above zero.
// Optional because Rescale is affine rather than a pure scaling -- the
// minimum is sky background, not zero -- so it trades away the absolute values
// that are the reason to fetch FITS instead of JPEG in the first place.
function rescaleToUnitRange(view) {
   let P = new Rescale;
   // Process enumeration constants live on the constructor (Rescale.RGBK), not
   // on its prototype -- same as FastRotation.HorizontalMirror below.
   P.mode = Rescale.RGBK;
   if (!P.executeOn(view))
      throw new Error("Rescale failed on \"" + view.id + "\".");
}

function mirrorHorizontally(view) {
   let P = new FastRotation;
   // FastRotation asks the user to confirm that the geometric transformation
   // will strip the image's astrometric solution. Nothing here depends on the
   // cutout keeping a WCS -- it is a freshly downloaded reference, matched to
   // the source image by construction -- so suppress the prompt.
   P.noGUIMessages = true;
   P.mode = FastRotation.HorizontalMirror;
   // executeOn() reports failure by returning false rather than throwing, so an
   // unapplied flip would otherwise pass silently as a correct-looking image.
   if (!P.executeOn(view))
      throw new Error("FastRotation failed on \"" + view.id + "\".");
}

// Position of a window in a window list. ImageWindow.activeWindow hands back
// its own object rather than the corresponding entry of ImageWindow.windows, so
// the two never compare equal by identity and indexOf() misses -- match on the
// main view's id instead, which is unique across the workspace.
function indexOfWindow(windows, window) {
   if (window == null || window.isNull)
      return -1;
   for (let i = 0; i < windows.length; ++i)
      if (windows[i].mainView.id == window.mainView.id)
         return i;
   return -1;
}

// An identifier for the new cutout that is not already taken. A project can
// legitimately hold several references at once -- two surveys of the same
// field, or the same survey either side of a reprocess -- so an earlier one is
// never closed or renamed to free up the name.
function uniqueReferenceId() {
   if (ImageWindow.windowById(REFERENCE_ID).isNull)
      return REFERENCE_ID;
   for (let n = 1; ; ++n) {
      let id = REFERENCE_ID + "_" + n;
      if (ImageWindow.windowById(id).isNull)
         return id;
   }
}

function main() {
   let windows = ImageWindow.windows.filter(w => !w.isNull);
   if (windows.length == 0) {
      (new MessageBox(APP_TITLE + ": no image windows are open.",
         APP_TITLE, StdIcon.Error, StdButton.Ok)).execute();
      return;
   }

   let p = new FetchHipsParameters();
   // Resolve to the list's own object, so the dialog can find it again.
   let activeIndex = indexOfWindow(windows, ImageWindow.activeWindow);
   p.sourceWindow = windows[(activeIndex >= 0) ? activeIndex : 0];

   let dlg = new FetchHipsDialog(p, windows);
   if (!dlg.execute())
      return;

   console.show();

   try {
      let query = solutionToQuery(p.sourceWindow);
      let url = buildURL(query, p.survey, p.format);

      console.writeln(APP_TITLE + ": requesting a " + query.width + "x" + query.height + " " +
         p.format + " cutout, " + format("%.4f", query.fov) + " degrees across, centered on " +
         format("RA %.6f Dec %+.6f", query.ra, query.dec) + ", rotated " +
         format("%.3f", query.rotation) + " degrees" +
         (query.mirrored ? ", to be mirrored on arrival." : "."));
      if (query.mirrored)
         console.noteln(APP_TITLE + ": the solution is mirrored. hips2fits only renders " +
            "the sky unmirrored, so the cutout will be flipped horizontally once received.");
      // <raw> keeps the console from interpreting the query string's markup.
      console.writeln("<raw>" + url + "</raw>");
      if (p.format == "fits")
         console.noteln(APP_TITLE + ": large FITS cutouts can take a minute or more to " +
            "generate server-side -- this is normal.");

      // A unique name per run: ImageWindow.open() hands back an already-open
      // window when reopening a path that is still loaded, which would show a
      // stale cutout instead of the fresh one.
      let outputPath = File.systemTempDirectory + "/" + REFERENCE_ID + "_" +
         Date.now() + "." + p.format;

      let opened;
      try {
         download(url, outputPath);
         // FITS numbers its rows from the bottom, but how PixInsight interprets
         // that is a global preference, so the same file opens either way on
         // different installations. hips2fits writes standard bottom-up FITS, so
         // state it as a format hint rather than inheriting whatever the
         // preference happens to be -- otherwise the cutout arrives vertically
         // mirrored against the JPEG of the same request. Hints are ignored by
         // formats that do not understand them.
         opened = ImageWindow.open(outputPath, "", (p.format == "fits") ? "bottom-up" : "");
      } finally {
         // ImageWindow.open() reads the whole image into memory, so the temp
         // file has done its job by here. Removed on every path, a failed or
         // rejected download included, so repeated runs cannot silently fill
         // the temp directory with cutouts.
         if (File.exists(outputPath))
            File.remove(outputPath);
      }

      if (opened.length == 0)
         throw new Error("The downloaded " + p.format + " data could not be opened as an image.");

      opened[0].mainView.id = uniqueReferenceId();
      if (query.mirrored)
         mirrorHorizontally(opened[0].mainView);
      if (p.format == "fits" && p.rescaleFits) {
         console.writeln(APP_TITLE + ": rescaling to [0,1] -- the survey's own 16-bit values " +
            "occupy a narrow band and would otherwise open as a low-contrast grey.");
         rescaleToUnitRange(opened[0].mainView);
      }
      opened[0].show();
      opened[0].zoomToFit();

      console.writeln(APP_TITLE + ": reference loaded as \"" + opened[0].mainView.id + "\".");
   } catch (e) {
      // <raw> so an exception message is never interpreted as console markup --
      // the console renders tags, and error text from elsewhere in PJSR is not
      // sanitized the way errorBodyText() sanitizes a response body.
      console.criticalln("<raw>" + APP_TITLE + " error: " + e + "</raw>");
      (new MessageBox(APP_TITLE + " failed:\n\n" + e,
         APP_TITLE, StdIcon.Error, StdButton.Ok)).execute();
   }
}

main();
