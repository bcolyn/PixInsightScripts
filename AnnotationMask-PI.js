#engine v8
/*
 * AnnotationMask -- builds a protection mask directly from an annotations
 * SVG (PixInsight's own "Export as SVG" on an annotated image), rather than
 * from the rendered overlay image.
 *
 * The SVG carries the true geometry: each marked object is an <ellipse> (or
 * <circle>) inside a <g transform="matrix(a,b,c,d,e,f)">, positioned in the
 * same coordinate space as the source image's pixels (viewBox width/height
 * == image width/height). This loads it via PJSR's real XMLDocument/
 * XMLElement DOM (XMLDocument.parseFromFile()), walks the element tree
 * composing nested <g> transforms, and rasterizes every ellipse/circle as a
 * filled white shape on an otherwise black canvas -- <text> labels and the
 * small crosshair <polyline>s are simply never matched by tag name, so
 * they're skipped for free. No pixel data is read at all; the mask is built
 * straight from vector shapes.
 *
 * Targets PixInsight 1.9.4 "Lockhart"'s V8 JavaScript runtime, matching
 * Aster's use of direct ImageIterator access for the one place actual pixel
 * data is touched: writing the finished mask out.
 *
 * (c) Benny Colyn 2026. MIT License (see repository LICENSE).
 */

#feature-id    Mask > Annotation To Mask
#feature-info  Builds a protection mask by rasterizing the ellipse/circle annotations from an exported SVG (V8 runtime).

#define APP_TITLE "Annotation To Mask"

CoreApplication.ensureMinimumVersion(1, 9, 4);

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

function AnnotationMaskParameters() {
   this.supersample = 3;   // NxN sub-pixel samples per pixel for anti-aliased edges
   this.growPixels = 0;    // dilate the mask by this many pixels, 0 = off
   this.featherPixels = 0; // Gaussian-blur the mask edges by this radius, 0 = off
   // false (default): marked objects are protected (white/1), everything
   // else is masked off (black/0) -- matches PixInsight's white-is-
   // protected mask convention. true: swap the two.
   this.invert = false;
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

function reflectIndex(i, n) {
   if (n <= 1) return 0;
   while (i < 0 || i >= n) {
      if (i < 0) i = -i - 1;
      if (i >= n) i = 2 * n - 1 - i;
   }
   return i;
}

// ---------------------------------------------------------------------------
// SVG reading -- via PJSR's real XMLDocument/XMLElement DOM (see the V8
// porting guide), not text scraping. XMLDocument.parseFromFile() handles
// both the file read and the XML parse in one call.
// ---------------------------------------------------------------------------

// Composes parent-then-child 2D affine matrices, both in SVG's
// matrix(a,b,c,d,e,f) form: x' = a*x + c*y + e; y' = b*x + d*y + f.
function multiplyMatrix(p, c) {
   return [
      p[0] * c[0] + p[2] * c[1],
      p[1] * c[0] + p[3] * c[1],
      p[0] * c[2] + p[2] * c[3],
      p[1] * c[2] + p[3] * c[3],
      p[0] * c[4] + p[2] * c[5] + p[4],
      p[1] * c[4] + p[3] * c[5] + p[5]
   ];
}

function attrNum(element, name, def) {
   return element.hasAttribute(name) ? parseFloat(element.attributeValue(name)) : def;
}

function getElementTransform(element) {
   if (!element.hasAttribute("transform")) return [1, 0, 0, 1, 0, 0];
   var m = element.attributeValue("transform").match(/matrix\(([^)]+)\)/);
   if (!m) return [1, 0, 0, 1, 0, 0];
   var parts = m[1].split(/[,\s]+/).filter(function(s) { return s.length > 0; }).map(parseFloat);
   return (parts.length === 6) ? parts : [1, 0, 0, 1, 0, 0];
}

// Recursive descent over the element tree, composing each <g>'s transform
// into the running matrix and collecting every <ellipse>/<circle> as
// { cx, cy, rx, ry, m } in world (viewBox) space -- m is the full local-to-
// world matrix to apply at rasterization time. <text> and <polyline> (the
// crosshair marks) are simply never matched by name, so they're skipped
// (their subtrees are still walked, harmlessly, in case of stray nesting).
function walkSvgElement(element, ctm, shapes) {
   var name = element.name;
   if (name === "ellipse" || name === "circle") {
      var cx = attrNum(element, "cx", 0), cy = attrNum(element, "cy", 0);
      var rx, ry;
      if (name === "circle") rx = ry = attrNum(element, "r", 0);
      else { rx = attrNum(element, "rx", 0); ry = attrNum(element, "ry", 0); }
      if (rx > 0 && ry > 0)
         shapes.push({ cx: cx, cy: cy, rx: rx, ry: ry, m: ctm });
      return; // leaf shape -- nothing further to descend into
   }
   if (name === "g" || name === "svg")
      ctm = multiplyMatrix(ctm, getElementTransform(element));
   var children = element.childElements();
   for (var i = 0; i < children.length; ++i)
      walkSvgElement(children[i], ctm, shapes);
}

// Loads and parses the SVG, returning { viewBox: {minX,minY,width,height},
// shapes: [...] }. Throws on a missing/invalid document.
function loadSvgShapes(svgPath) {
   var doc = new XMLDocument;
   doc.parseFromFile(svgPath);
   var root = doc.rootElement;
   if (!root)
      throw new Error("empty or invalid SVG document");

   var viewBox = null;
   if (root.hasAttribute("viewBox")) {
      var parts = root.attributeValue("viewBox").split(/[,\s]+/)
         .filter(function(s) { return s.length > 0; }).map(parseFloat);
      if (parts.length === 4 && parts[2] > 0 && parts[3] > 0)
         viewBox = { minX: parts[0], minY: parts[1], width: parts[2], height: parts[3] };
   }
   if (!viewBox && root.hasAttribute("width") && root.hasAttribute("height")) {
      var vw = parseFloat(root.attributeValue("width")), vh = parseFloat(root.attributeValue("height"));
      if (vw > 0 && vh > 0) viewBox = { minX: 0, minY: 0, width: vw, height: vh };
   }
   if (!viewBox)
      throw new Error("no viewBox (or width/height) found on the <svg> element");

   var shapes = [];
   walkSvgElement(root, [1, 0, 0, 1, 0, 0], shapes);
   return { viewBox: viewBox, shapes: shapes };
}

// ---------------------------------------------------------------------------
// Rasterization -- fills each ellipse via an inverse-matrix point-in-ellipse
// test, scoped to its own world-space bounding box (same bounding-box-
// scoping idea as Aster's per-star work), with NxN supersampling for
// anti-aliased edges. Overlapping shapes combine via max(), like Aster's
// spike compositing.
// ---------------------------------------------------------------------------

function rasterizeShapes(shapes, w, h, minX, minY, supersample) {
   var mask = new Float32Array(w * h);
   var ss = FMath.max(1, supersample | 0);
   var invSS2 = 1 / (ss * ss);

   for (var s = 0; s < shapes.length; ++s) {
      var sh = shapes[s], mtx = sh.m;
      var a = mtx[0], b = mtx[1], c = mtx[2], d = mtx[3], e = mtx[4], f = mtx[5];
      var det = a * d - b * c;
      if (FMath.abs(det) < 1e-12) continue;
      var ia = d / det, ib = -b / det, ic = -c / det, id = a / det;

      var lx0 = sh.cx - sh.rx, lx1 = sh.cx + sh.rx;
      var ly0 = sh.cy - sh.ry, ly1 = sh.cy + sh.ry;
      var corners = [[lx0, ly0], [lx1, ly0], [lx0, ly1], [lx1, ly1]];
      var wx0 = Infinity, wx1 = -Infinity, wy0 = Infinity, wy1 = -Infinity;
      for (var k = 0; k < 4; ++k) {
         var lx = corners[k][0], ly = corners[k][1];
         var wx = a * lx + c * ly + e, wy = b * lx + d * ly + f;
         if (wx < wx0) wx0 = wx; if (wx > wx1) wx1 = wx;
         if (wy < wy0) wy0 = wy; if (wy > wy1) wy1 = wy;
      }
      var px0 = FMath.max(0, FMath.floor(wx0 - minX));
      var px1 = FMath.min(w - 1, FMath.ceil(wx1 - minX));
      var py0 = FMath.max(0, FMath.floor(wy0 - minY));
      var py1 = FMath.min(h - 1, FMath.ceil(wy1 - minY));

      var invRx2 = 1 / (sh.rx * sh.rx), invRy2 = 1 / (sh.ry * sh.ry);

      for (var py = py0; py <= py1; ++py) {
         for (var px = px0; px <= px1; ++px) {
            var cover = 0;
            for (var sy = 0; sy < ss; ++sy) {
               var wy = minY + py + (sy + 0.5) / ss;
               for (var sx = 0; sx < ss; ++sx) {
                  var wx = minX + px + (sx + 0.5) / ss;
                  var dx = wx - e, dy = wy - f;
                  var lx = ia * dx + ic * dy;
                  var ly = ib * dx + id * dy;
                  var nx = lx - sh.cx, ny = ly - sh.cy;
                  if (nx * nx * invRx2 + ny * ny * invRy2 <= 1) cover++;
               }
            }
            if (cover > 0) {
               var idx = py * w + px;
               var v = cover * invSS2;
               if (v > mask[idx]) mask[idx] = v;
            }
         }
      }
   }
   return mask;
}

// ---------------------------------------------------------------------------
// Mask post-processing -- grow (separable box-max dilation) and feather
// (separable Gaussian blur), both optional (radius/sigma <= 0 = off).
// ---------------------------------------------------------------------------

function maxFilterSeparable(arr, w, h, radius) {
   if (radius <= 0) return arr;
   var tmp = new Float32Array(w * h);
   for (var y = 0; y < h; ++y) {
      var row = y * w;
      for (var x = 0; x < w; ++x) {
         var m = 0;
         for (var k = -radius; k <= radius; ++k) {
            var xx = x + k;
            if (xx < 0 || xx >= w) continue;
            var v = arr[row + xx];
            if (v > m) m = v;
         }
         tmp[row + x] = m;
      }
   }
   var out = new Float32Array(w * h);
   for (var x = 0; x < w; ++x) {
      for (var y = 0; y < h; ++y) {
         var m = 0;
         for (var k = -radius; k <= radius; ++k) {
            var yy = y + k;
            if (yy < 0 || yy >= h) continue;
            var v = tmp[yy * w + x];
            if (v > m) m = v;
         }
         out[y * w + x] = m;
      }
   }
   return out;
}

function gaussianKernel1D(sigma) {
   sigma = FMath.max(sigma, 0.1);
   var radius = FMath.max(1, FMath.ceil(sigma * 3));
   var kernel = new Float64Array(2 * radius + 1);
   var sum = 0;
   for (var i = -radius; i <= radius; ++i) {
      var v = FMath.exp(-(i * i) / (2 * sigma * sigma));
      kernel[i + radius] = v; sum += v;
   }
   for (var i = 0; i < kernel.length; ++i) kernel[i] /= sum;
   return { kernel: kernel, radius: radius };
}

function gaussianBlur(arr, w, h, sigma) {
   if (sigma <= 0) return arr;
   var k = gaussianKernel1D(sigma);
   var tmp = new Float32Array(w * h);
   for (var y = 0; y < h; ++y) {
      var row = y * w;
      for (var x = 0; x < w; ++x) {
         var acc = 0;
         for (var i = -k.radius; i <= k.radius; ++i)
            acc += arr[row + reflectIndex(x + i, w)] * k.kernel[i + k.radius];
         tmp[row + x] = acc;
      }
   }
   var out = new Float32Array(w * h);
   for (var y = 0; y < h; ++y) {
      for (var x = 0; x < w; ++x) {
         var acc = 0;
         for (var i = -k.radius; i <= k.radius; ++i)
            acc += tmp[reflectIndex(y + i, h) * w + x] * k.kernel[i + k.radius];
         out[y * w + x] = acc;
      }
   }
   return out;
}

// ---------------------------------------------------------------------------
// Output window
// ---------------------------------------------------------------------------

function createMaskWindow(width, height, id) {
   return new ImageWindow(width, height, 1, 32, true, false, id);
}

function writeMask(image, w, h, buf) {
   var it = new ImageIterator(image, 0);
   for (var y = 0; y < h; ++y)
      for (var x = 0; x < w; ++x)
         it[y][x] = clamp(buf[y * w + x], 0, 1);
}

// ---------------------------------------------------------------------------
// Dialog
//
// A class declaration is safe here because this script runs under the v8
// (v8-new) engine selector -- see Aster-PI.js for why that matters.
// ---------------------------------------------------------------------------

class AnnotationMaskDialog extends Dialog {
   constructor(p, svgPath, shapeCount) {
   super();
   var dlg = this;

   this.windowTitle = APP_TITLE;
   this.minWidth = 420;

   this.info = new Label(this);
   this.info.frameStyle = FrameStyle.Box;
   this.info.margin = 4;
   this.info.wordWrapping = true;
   this.info.useRichText = true;
   this.info.text = "<p><b>" + svgPath + "</b><br/>" + shapeCount +
      " ellipse/circle annotation(s) found. Each will be rendered as a filled shape on a new " +
      "mono mask image the same size as the SVG's viewBox.</p>";

   function slider(label, min, max, obj, prop, decimals) {
      var c = new NumericControl(dlg);
      c.label.text = label;
      c.label.minWidth = 140;
      c.setRange(min, max);
      c.slider.setRange(0, 500);
      c.setPrecision(decimals === undefined ? 2 : decimals);
      c.setValue(obj[prop]);
      c.onValueUpdated = function(value) { obj[prop] = value; };
      return c;
   }

   this.supersampleLabel = new Label(this);
   this.supersampleLabel.text = "Edge quality:";
   this.supersampleCombo = new ComboBox(this);
   var ssValues = [1, 2, 3, 4, 6];
   var ssLabels = ["1x1 (hard edge)", "2x2", "3x3", "4x4", "6x6 (best)"];
   for (var i = 0; i < ssLabels.length; ++i) this.supersampleCombo.addItem(ssLabels[i]);
   this.supersampleCombo.currentItem = FMath.max(0, ssValues.indexOf(p.supersample));
   this.supersampleCombo.onItemSelected = function(index) { p.supersample = ssValues[index]; };
   var ssRow = new HorizontalSizer;
   ssRow.spacing = 6;
   ssRow.add(this.supersampleLabel);
   ssRow.add(this.supersampleCombo);
   ssRow.addStretch();

   this.growCtl = slider("Grow mask (px)", 0, 50, p, "growPixels", 0);
   this.featherCtl = slider("Feather (px)", 0, 50, p, "featherPixels", 1);

   this.invertCheck = new CheckBox(this);
   this.invertCheck.text = "Invert (protect everything except the annotated objects)";
   this.invertCheck.checked = p.invert;
   this.invertCheck.onCheck = function(checked) { p.invert = checked; };

   this.okButton = new PushButton(this);
   this.okButton.text = "Apply";
   this.okButton.onClick = function() { dlg.ok(); };
   this.cancelButton = new PushButton(this);
   this.cancelButton.text = "Cancel";
   this.cancelButton.onClick = function() { dlg.cancel(); };
   var buttons = new HorizontalSizer;
   buttons.spacing = 6;
   buttons.addStretch();
   buttons.add(this.okButton);
   buttons.add(this.cancelButton);

   this.sizer = new VerticalSizer;
   this.sizer.margin = 8;
   this.sizer.spacing = 6;
   this.sizer.add(this.info);
   this.sizer.addSpacing(6);
   this.sizer.add(ssRow);
   this.sizer.add(this.growCtl);
   this.sizer.add(this.featherCtl);
   this.sizer.add(this.invertCheck);
   this.sizer.addSpacing(8);
   this.sizer.add(buttons);
   } // constructor
} // class AnnotationMaskDialog

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
   var ofd = new OpenFileDialog;
   ofd.caption = "Annotation To Mask: Select Annotations SVG";
   ofd.filters = [["SVG Files", "*.svg"]];
   if (!ofd.execute())
      return;
   var svgPath = ofd.filePath;

   var svgResult;
   try {
      svgResult = loadSvgShapes(svgPath);
   } catch (e) {
      (new MessageBox("Annotation To Mask: couldn't read \"" + svgPath + "\":\n\n" + e,
         APP_TITLE, StdIcon.Error, StdButton.Ok)).execute();
      return;
   }
   var viewBox = svgResult.viewBox, shapes = svgResult.shapes;
   var w = FMath.round(viewBox.width), h = FMath.round(viewBox.height);

   if (shapes.length === 0) {
      (new MessageBox("Annotation To Mask: no <ellipse> or <circle> annotations found in the SVG.",
         APP_TITLE, StdIcon.Error, StdButton.Ok)).execute();
      return;
   }

   var p = new AnnotationMaskParameters();
   var dlg = new AnnotationMaskDialog(p, svgPath, shapes.length);
   if (!dlg.execute())
      return;

   console.show();
   console.writeln("Annotation To Mask: rendering " + shapes.length + " shape(s) onto a " +
      w + "x" + h + " mask...");

   var maskWindow = null;
   try {
      var mask = rasterizeShapes(shapes, w, h, viewBox.minX, viewBox.minY, p.supersample);

      if (p.growPixels > 0) {
         console.writeln("Annotation To Mask: growing mask by " + p.growPixels + "px...");
         mask = maxFilterSeparable(mask, w, h, p.growPixels);
      }
      if (p.featherPixels > 0) {
         console.writeln("Annotation To Mask: feathering mask by " + p.featherPixels + "px...");
         mask = gaussianBlur(mask, w, h, p.featherPixels);
      }
      if (p.invert) {
         for (var i = 0; i < mask.length; ++i) mask[i] = 1 - mask[i];
      }

      var maskId = File.extractName(svgPath) + "_mask";
      console.writeln("Annotation To Mask: creating " + maskId + "...");
      maskWindow = createMaskWindow(w, h, maskId);
      var maskView = maskWindow.mainView;
      maskView.beginProcess(UndoFlag.PixelData);
      writeMask(maskView.image, w, h, mask);
      maskView.endProcess();

      maskWindow.show();
      maskWindow.bringToFront();
      console.writeln("Annotation To Mask: done.");
   } catch (e) {
      if (maskWindow) maskWindow.forceClose();
      console.criticalln("Annotation To Mask error: " + e);
      (new MessageBox("Annotation To Mask failed:\n\n" + e, APP_TITLE, StdIcon.Error, StdButton.Ok)).execute();
   }
}

main();
