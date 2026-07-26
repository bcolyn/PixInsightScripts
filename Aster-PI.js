#engine v8
/*
 * Aster for PixInsight -- a V8-runtime PJSR port of Aster v1.2.0 (Siril/sirilpy)
 *
 * Original tool: Aster, by Stefos Tzortzis <stefos.tzortzis@gmail.com>, for
 * Siril/sirilpy. This is an unofficial, independent port of the published
 * algorithm to PixInsight scripting -- not an official Pleiades or Siril
 * product, and not endorsed by the original author.
 *
 * Targets PixInsight 1.9.4 "Lockhart"'s V8 JavaScript runtime, which makes
 * plain-JS per-pixel work (flood-fill labeling, hand-rolled convolution)
 * fast enough to be practical. Operates directly on pixel data via the
 * ImageIterator class (a typed-array view straight onto the image's own
 * pixel buffer), so it follows the original numpy/scipy algorithm closely
 * instead of working around what PixelMath expressions can express.
 *
 * Ported from v1.2.0, which reworked star detection around a single shared
 * catalog (background + connected components computed once, reused by glow
 * and both spike layers) and added: user-set black/white detection levels
 * replacing the old automatic sigma threshold; a JWST-style 6+2-arm spike
 * pattern alongside the classic 4-arm Newtonian one; optional spectral
 * (rainbow) diffraction tinting; a second, +45-degree-offset spike layer;
 * and independent exclusion-mask toggles for glow vs. spikes. See the
 * notes at the end of this file for what was ported as-is, reshaped, or
 * deliberately left out, and why.
 *
 * Run on a stars-only, nonlinear (stretched) image or Preview -- same
 * precondition as the original script.
 *
 * License: GPL-3.0-or-later (matching the source script's license)
 */

#feature-id    Render > Aster
#feature-info  Glow and optional diffraction spikes for a stretched, stars-only image (V8 runtime).

#define APP_TITLE "Aster"

CoreApplication.ensureMinimumVersion(1, 9, 4);

// ---------------------------------------------------------------------------
// Parameters (defaults mirror v1.2.0's reset_controls())
// ---------------------------------------------------------------------------

function AsterParameters() {
   // Shared star detection (feeds glow, primary spikes, secondary spikes).
   this.detectionBlack = 0.20; // 0..0.99
   this.detectionWhite = 0.90; // detectionBlack+0.01..1.0

   this.glowEnabled = true;
   this.glow = {
      minDiameter: 15.0,
      feather:     20.0,
      radius:      10.0,
      strength:    0.50,
      gamma:       0.70,
      blend:       1.00,
      blurMode:    "Moffat", // Gaussian | Box | Disk | Triangle | Moffat | Multi-scale Gaussian
      downsample:  1         // 1 = off (full-res blur, matches v1.2.0 exactly). Not part of the
                              // original script -- see PERFORMANCE NOTES at the end of this file.
   };

   this.spikesEnabled = false;
   this.spike = {
      minDiameter: 20.0,
      feather:     30.0,
      strength:    0.80,
      length:      400.0,
      width:       2.0,
      angle:       0.0,
      blend:       1.00,
      spikeType:   "Newtonian", // Newtonian | JWST
      spectral:            false,
      spectralStrength:    0.55,
      spectralSaturation:  0.80,
      // Fixed in v1.2.0's own UI too ("the more natural checkbox-only look
      // from the first spectral prototype") -- not exposed as controls.
      spectralPosition:   0.28,
      spectralSpread:     0.18,
      spectralSmoothness: 0.91,
      perArmVariation:    0.04
   };

   // Secondary spikes: a second, softer 4-arm layer offset +45 degrees from
   // the primary. Always classic Newtonian (no spike type or spectral
   // options), and reuses the primary spike's angle/blend rather than
   // having its own -- matching v1.2.0's secondary_spike_parameters(),
   // which literally reads self.spike_angle_spin/self.spike_blend_spin.
   this.secondaryEnabled = false;
   this.secondary = {
      minDiameter: 20.0,
      feather:     10.0,
      strength:    0.40,
      length:      80.0,
      width:       4.0
   };

   // Independent exclusion-mask gating per stage (v1.2.0's mask_glow_checkbox
   // / mask_spikes_checkbox, both default on). Secondary spikes share the
   // "spikes" gate, matching the original (mask_spikes applies to both).
   this.maskGlow   = true;
   this.maskSpikes = true;
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

// Median of a Float32Array. TypedArray.prototype.sort() sorts numerically
// by default (unlike Array.prototype.sort()), so no comparator is needed.
function median(arr) {
   var tmp = arr.slice();
   tmp.sort();
   var n = tmp.length;
   if (n === 0) return 0;
   return (n % 2) ? tmp[(n - 1) / 2] : 0.5 * (tmp[n / 2 - 1] + tmp[n / 2]);
}

// Deterministic stride subsample, capped at maxSamples. A few hundred
// thousand samples give a median estimate that's practically identical to
// sorting the full array for a single background statistic, while cutting
// sort cost sharply on large frames.
function subsample(arr, maxSamples) {
   var n = arr.length;
   if (n <= maxSamples) return arr;
   var stride = FMath.ceil(n / maxSamples);
   var out = new Float32Array(FMath.ceil(n / stride));
   var j = 0;
   for (var i = 0; i < n; i += stride) out[j++] = arr[i];
   return out.subarray(0, j);
}

// ---------------------------------------------------------------------------
// Image <-> typed-array pixel access, via ImageIterator (the documented V8
// fast-path: a typed-array view directly over the image's own pixel buffer,
// per PixInsight's V8 runtime docs). Handles both floating-point images
// (sample == real value) and integer images (sample is in the format's
// nominal range, converted through toReal()/toSample()) -- mirroring the
// original Python script's normalize_image()/denormalize_image() step.
//
// Separate integer/float loop variants match the documented pattern:
// branching per-pixel on isInteger inside the inner loop defeats some JIT
// optimization, so the branch happens once, outside the loops, instead.
// ---------------------------------------------------------------------------

function readChannelsFloat(image, w, h, n) {
   var data = [];
   for (var c = 0; c < n; ++c) {
      var it = new ImageIterator(image, c);
      var buf = new Float32Array(w * h);
      for (var y = 0; y < h; ++y)
         for (var x = 0; x < w; ++x)
            buf[y * w + x] = it[y][x];
      data.push(buf);
   }
   return data;
}

function readChannelsInteger(image, w, h, n) {
   var data = [];
   for (var c = 0; c < n; ++c) {
      var it = new ImageIterator(image, c);
      var buf = new Float32Array(w * h);
      for (var y = 0; y < h; ++y)
         for (var x = 0; x < w; ++x)
            buf[y * w + x] = it.toReal(it[y][x]);
      data.push(buf);
   }
   return data;
}

function readChannels(image) {
   var w = image.width, h = image.height, n = image.numberOfNominalChannels;
   var data = image.isInteger ? readChannelsInteger(image, w, h, n) : readChannelsFloat(image, w, h, n);
   return { width: w, height: h, channels: n, data: data };
}

function writeChannelsFloat(image, img) {
   var w = img.width, h = img.height;
   for (var c = 0; c < img.channels; ++c) {
      var it = new ImageIterator(image, c);
      var buf = img.data[c];
      for (var y = 0; y < h; ++y)
         for (var x = 0; x < w; ++x)
            it[y][x] = clamp(buf[y * w + x], 0, 1);
   }
}

function writeChannelsInteger(image, img) {
   var w = img.width, h = img.height;
   for (var c = 0; c < img.channels; ++c) {
      var it = new ImageIterator(image, c);
      var buf = img.data[c];
      for (var y = 0; y < h; ++y)
         for (var x = 0; x < w; ++x)
            it[y][x] = it.toSample(clamp(buf[y * w + x], 0, 1));
   }
}

function writeChannels(image, img) {
   if (image.isInteger) writeChannelsInteger(image, img);
   else writeChannelsFloat(image, img);
}

// Reads a single channel of any image (used for the exclusion mask, which
// isn't necessarily the same pixel format as the target).
function readSingleChannel(image, channel) {
   var w = image.width, h = image.height;
   var buf = new Float32Array(w * h);
   var it = new ImageIterator(image, channel);
   if (image.isInteger) {
      for (var y = 0; y < h; ++y)
         for (var x = 0; x < w; ++x) buf[y * w + x] = it.toReal(it[y][x]);
   } else {
      for (var y = 0; y < h; ++y)
         for (var x = 0; x < w; ++x) buf[y * w + x] = it[y][x];
   }
   return buf;
}

function cloneChannels(img) {
   var data = [];
   for (var c = 0; c < img.channels; ++c)
      data.push(img.data[c].slice());
   return { width: img.width, height: img.height, channels: img.channels, data: data };
}

function luminance(img) {
   var n = img.width * img.height;
   var lum = new Float32Array(n);
   if (img.channels === 1) {
      lum.set(img.data[0]);
   } else {
      var R = img.data[0], G = img.data[1], B = img.data[2];
      for (var i = 0; i < n; ++i)
         lum[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
   }
   return lum;
}

// ---------------------------------------------------------------------------
// Connected components
// ---------------------------------------------------------------------------

// 2x2-block erosion/dilation pair, matching ndi.binary_opening(structure=
// ones((2,2))) exactly (same structuring element for both steps, unlike an
// earlier draft of this port which paired a 2x2 erosion with a cross
// dilation to approximate v1.0.0's extra dilation pass -- v1.2.0 dropped
// that extra pass entirely: "No dilation is used, so nearby halos are not
// joined").
function erode2x2(mask, w, h) {
   var out = new Uint8Array(w * h);
   for (var y = 0; y < h; ++y) {
      for (var x = 0; x < w; ++x) {
         var idx = y * w + x;
         var a = mask[idx];
         var b = (x + 1 < w) ? mask[idx + 1] : 0;
         var c = (y + 1 < h) ? mask[idx + w] : 0;
         var d = (x + 1 < w && y + 1 < h) ? mask[idx + w + 1] : 0;
         out[idx] = (a && b && c && d) ? 1 : 0;
      }
   }
   return out;
}

function dilate2x2(mask, w, h) {
   var out = new Uint8Array(w * h);
   for (var y = 0; y < h; ++y) {
      for (var x = 0; x < w; ++x) {
         var idx = y * w + x;
         var a = mask[idx];
         var b = (x - 1 >= 0) ? mask[idx - 1] : 0;
         var c = (y - 1 >= 0) ? mask[idx - w] : 0;
         var d = (x - 1 >= 0 && y - 1 >= 0) ? mask[idx - w - 1] : 0;
         out[idx] = (a || b || c || d) ? 1 : 0;
      }
   }
   return out;
}

function cleanupMask(mask, w, h) {
   return dilate2x2(erode2x2(mask, w, h), w, h);
}

// 4-connected flood-fill labeling (matches scipy.ndimage.label's default
// connectivity=1 structure). Returns { labels: Int32Array, count }.
function labelComponents(mask, w, h) {
   var n = w * h;
   var labels = new Int32Array(n);
   var stackX = new Int32Array(n);
   var stackY = new Int32Array(n);
   var nextLabel = 0;

   for (var y0 = 0; y0 < h; ++y0) {
      for (var x0 = 0; x0 < w; ++x0) {
         var idx0 = y0 * w + x0;
         if (!mask[idx0] || labels[idx0]) continue;
         nextLabel++;
         var sp = 0;
         stackX[sp] = x0; stackY[sp] = y0; sp++;
         labels[idx0] = nextLabel;
         while (sp > 0) {
            sp--;
            var cx = stackX[sp], cy = stackY[sp];
            var idx = cy * w + cx;
            if (cx > 0) {
               var ni = idx - 1;
               if (mask[ni] && !labels[ni]) { labels[ni] = nextLabel; stackX[sp] = cx - 1; stackY[sp] = cy; sp++; }
            }
            if (cx + 1 < w) {
               var ni = idx + 1;
               if (mask[ni] && !labels[ni]) { labels[ni] = nextLabel; stackX[sp] = cx + 1; stackY[sp] = cy; sp++; }
            }
            if (cy > 0) {
               var ni = idx - w;
               if (mask[ni] && !labels[ni]) { labels[ni] = nextLabel; stackX[sp] = cx; stackY[sp] = cy - 1; sp++; }
            }
            if (cy + 1 < h) {
               var ni = idx + w;
               if (mask[ni] && !labels[ni]) { labels[ni] = nextLabel; stackX[sp] = cx; stackY[sp] = cy + 1; sp++; }
            }
         }
      }
   }
   return { labels: labels, count: nextLabel };
}

function maxFilter3(arr, w, h) {
   var out = new Float32Array(w * h);
   for (var y = 0; y < h; ++y) {
      for (var x = 0; x < w; ++x) {
         var m = -Infinity;
         for (var dy = -1; dy <= 1; ++dy) {
            var yy = reflectIndex(y + dy, h);
            for (var dx = -1; dx <= 1; ++dx) {
               var xx = reflectIndex(x + dx, w);
               var v = arr[yy * w + xx];
               if (v > m) m = v;
            }
         }
         out[y * w + x] = m;
      }
   }
   return out;
}

// Per-label bounding box (min/max x/y), computed once and reused for every
// star's local core-ball refinement and colour sampling -- matches v1.2.0's
// own use of ndi.find_objects() for the same purpose ("Expand the exact
// component bounding box so local morphology has the same border context
// as the former full-image implementation").
function computeLabelBounds(labels, count, w, h) {
   var minX = new Int32Array(count + 1).fill(w);
   var maxX = new Int32Array(count + 1).fill(-1);
   var minY = new Int32Array(count + 1).fill(h);
   var maxY = new Int32Array(count + 1).fill(-1);
   for (var y = 0; y < h; ++y) {
      var row = y * w;
      for (var x = 0; x < w; ++x) {
         var l = labels[row + x];
         if (!l) continue;
         if (x < minX[l]) minX[l] = x;
         if (x > maxX[l]) maxX[l] = x;
         if (y < minY[l]) minY[l] = y;
         if (y > maxY[l]) maxY[l] = y;
      }
   }
   return { minX: minX, maxX: maxX, minY: minY, maxY: maxY };
}

// ---------------------------------------------------------------------------
// Star catalog -- one shared detection pass reused by glow, primary spikes
// and secondary spikes. Matches v1.2.0's build_star_catalog(): detection
// now runs on levels-adjusted luminance against a fixed 0.05 threshold,
// replacing v1.0.0's automatic median+MAD sigma threshold with two
// user-set black/white points.
// ---------------------------------------------------------------------------

function buildStarCatalog(img, detectionBlack, detectionWhite) {
   var w = img.width, h = img.height, n = w * h;
   detectionBlack = clamp(detectionBlack, 0, 0.99);
   detectionWhite = clamp(detectionWhite, detectionBlack + 0.01, 1.0);

   var lum = luminance(img);
   var background = median(subsample(lum, 400000));

   var detectionLum = new Float32Array(n);
   var invRange = 1 / FMath.max(detectionWhite - detectionBlack, 1e-6);
   for (var i = 0; i < n; ++i)
      detectionLum[i] = clamp((lum[i] - detectionBlack) * invRange, 0, 1);

   var mask = new Uint8Array(n);
   for (var i = 0; i < n; ++i) mask[i] = detectionLum[i] > 0.05 ? 1 : 0;
   mask = cleanupMask(mask, w, h);

   var lbl = labelComponents(mask, w, h);
   var labels = lbl.labels, count = lbl.count;

   var diameters = new Float64Array(count + 1);
   var peaks = new Float64Array(count + 1);
   var bounds = null;

   if (count > 0) {
      var areas = new Float64Array(count + 1);
      for (var i = 0; i < n; ++i) {
         var l = labels[i];
         if (!l) continue;
         areas[l]++;
         if (lum[i] > peaks[l]) peaks[l] = lum[i];
      }
      for (var l = 1; l <= count; ++l) diameters[l] = 2.0 * FMath.sqrt(areas[l] / FMath.PI);
      bounds = computeLabelBounds(labels, count, w, h);
   }

   return {
      width: w, height: h, lum: lum, labels: labels, count: count,
      diameters: diameters, peaks: peaks, bounds: bounds, background: background
   };
}

// Per-component and per-pixel smooth diameter weights. Matches v1.2.0's
// component_selection(), shared between select_stars() and
// detect_star_emitters().
function componentSelection(catalog, minDiameter, feather) {
   var w = catalog.width, h = catalog.height, count = catalog.count;
   var halfFeather = FMath.max(feather, 0.1) * 0.5;
   var low = FMath.max(0.0, minDiameter - halfFeather);
   var high = FMath.max(low + 1e-6, minDiameter + halfFeather);

   var weights = new Float64Array(count + 1);
   for (var l = 1; l <= count; ++l) {
      var t = clamp((catalog.diameters[l] - low) / (high - low), 0, 1);
      weights[l] = t * t * (3 - 2 * t);
   }

   var selection = new Float32Array(w * h);
   for (var i = 0; i < w * h; ++i)
      selection[i] = catalog.labels[i] ? weights[catalog.labels[i]] : 0;
   selection = maxFilter3(selection, w, h);

   return { weights: weights, selection: selection };
}

// ---------------------------------------------------------------------------
// Blur kernels -- separable where possible, direct 2D convolution otherwise
// ---------------------------------------------------------------------------

function convolveSeparable(arr, w, h, kernel, radius) {
   var tmp = new Float32Array(w * h);
   for (var y = 0; y < h; ++y) {
      var row = y * w;
      for (var x = 0; x < w; ++x) {
         var acc = 0;
         for (var k = -radius; k <= radius; ++k)
            acc += arr[row + reflectIndex(x + k, w)] * kernel[k + radius];
         tmp[row + x] = acc;
      }
   }
   var out = new Float32Array(w * h);
   for (var y = 0; y < h; ++y) {
      for (var x = 0; x < w; ++x) {
         var acc = 0;
         for (var k = -radius; k <= radius; ++k)
            acc += tmp[reflectIndex(y + k, h) * w + x] * kernel[k + radius];
         out[y * w + x] = acc;
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
   var k = gaussianKernel1D(sigma);
   return convolveSeparable(arr, w, h, k.kernel, k.radius);
}

function boxKernel1D(size) {
   var radius = FMath.floor(FMath.max(1, size) / 2);
   var kernel = new Float64Array(2 * radius + 1);
   for (var i = 0; i < kernel.length; ++i) kernel[i] = 1 / kernel.length;
   return { kernel: kernel, radius: radius };
}

function boxBlur(arr, w, h, radius) {
   var k = boxKernel1D(FMath.round(radius * 2 + 1));
   return convolveSeparable(arr, w, h, k.kernel, k.radius);
}

function triangleBlur(arr, w, h, radius) {
   var k = boxKernel1D(FMath.round(radius + 1));
   var once = convolveSeparable(arr, w, h, k.kernel, k.radius);
   return convolveSeparable(once, w, h, k.kernel, k.radius);
}

function convolve2D(arr, w, h, k) {
   var out = new Float32Array(w * h);
   for (var y = 0; y < h; ++y) {
      for (var x = 0; x < w; ++x) {
         var acc = 0;
         for (var dy = -k.radius; dy <= k.radius; ++dy) {
            var yy = reflectIndex(y + dy, h);
            var rowBase = yy * w;
            var krow = (dy + k.radius) * k.size;
            for (var dx = -k.radius; dx <= k.radius; ++dx)
               acc += arr[rowBase + reflectIndex(x + dx, w)] * k.kernel[krow + dx + k.radius];
         }
         out[y * w + x] = acc;
      }
   }
   return out;
}

// Disk and Moffat are non-separable, O(w*h*radius^2) -- the slowest options
// at large radii. Prefer Gaussian/Box/Multi-scale Gaussian for big glow
// radii on full-resolution frames, or use the downsample-blur-upsample
// path below (params.glow.downsample) for these two specifically.
function diskBlur(arr, w, h, radius) {
   var r = FMath.max(1, FMath.round(radius));
   var size = 2 * r + 1;
   var kernel = new Float64Array(size * size);
   var sum = 0;
   for (var dy = -r; dy <= r; ++dy)
      for (var dx = -r; dx <= r; ++dx) {
         var v = (dx * dx + dy * dy <= r * r) ? 1 : 0;
         kernel[(dy + r) * size + dx + r] = v; sum += v;
      }
   if (sum > 0) for (var i = 0; i < kernel.length; ++i) kernel[i] /= sum;
   return convolve2D(arr, w, h, { kernel: kernel, radius: r, size: size });
}

function moffatBlur(arr, w, h, radius) {
   var alpha = FMath.max(radius, 0.5);
   var extent = FMath.max(1, FMath.round(alpha * 3));
   var size = 2 * extent + 1;
   var kernel = new Float64Array(size * size);
   var sum = 0;
   for (var dy = -extent; dy <= extent; ++dy)
      for (var dx = -extent; dx <= extent; ++dx) {
         var v = FMath.pow(1 + (dx * dx + dy * dy) / (alpha * alpha), -2.5);
         kernel[(dy + extent) * size + dx + extent] = v; sum += v;
      }
   if (sum > 0) for (var i = 0; i < kernel.length; ++i) kernel[i] /= sum;
   return convolve2D(arr, w, h, { kernel: kernel, radius: extent, size: size });
}

// The un-named default blur mode in v1.0.0, now explicitly labeled "Multi-
// scale Gaussian" in v1.2.0's own UI: a 65/35 mix of a tight and a broad
// Gaussian, giving a softer halo than a single Gaussian.
function multiscaleGaussianBlur(arr, w, h, radius) {
   var tight = gaussianBlur(arr, w, h, radius * 0.65);
   var broad = gaussianBlur(arr, w, h, radius * 1.8);
   var out = new Float32Array(arr.length);
   for (var i = 0; i < out.length; ++i)
      out[i] = 0.65 * tight[i] + 0.35 * broad[i];
   return out;
}

// Box-averages `arr` down by an integer factor. Returns { data, width,
// height }. factor<=1 returns the input unchanged.
function downsampleBox(arr, w, h, factor) {
   if (factor <= 1) return { data: arr, width: w, height: h };
   var dw = FMath.ceil(w / factor), dh = FMath.ceil(h / factor);
   var out = new Float32Array(dw * dh);
   for (var dy = 0; dy < dh; ++dy) {
      var y0 = dy * factor, y1 = FMath.min(h, y0 + factor);
      for (var dx = 0; dx < dw; ++dx) {
         var x0 = dx * factor, x1 = FMath.min(w, x0 + factor);
         var sum = 0, cnt = 0;
         for (var y = y0; y < y1; ++y) {
            var row = y * w;
            for (var x = x0; x < x1; ++x) { sum += arr[row + x]; cnt++; }
         }
         out[dy * dw + dx] = cnt > 0 ? sum / cnt : 0;
      }
   }
   return { data: out, width: dw, height: dh };
}

// Bilinear-upsamples a (sw x sh) array back to (w x h).
function upsampleBilinear(arr, sw, sh, w, h) {
   if (sw === w && sh === h) return arr;
   var out = new Float32Array(w * h);
   var sx = sw / w, sy = sh / h;
   for (var y = 0; y < h; ++y) {
      var fy = (y + 0.5) * sy - 0.5;
      var y0 = FMath.floor(fy), ty = fy - y0;
      var y0c = clamp(y0, 0, sh - 1), y1c = clamp(y0 + 1, 0, sh - 1);
      var rowOut = y * w;
      for (var x = 0; x < w; ++x) {
         var fx = (x + 0.5) * sx - 0.5;
         var x0 = FMath.floor(fx), tx = fx - x0;
         var x0c = clamp(x0, 0, sw - 1), x1c = clamp(x0 + 1, 0, sw - 1);
         var v00 = arr[y0c * sw + x0c], v10 = arr[y0c * sw + x1c];
         var v01 = arr[y1c * sw + x0c], v11 = arr[y1c * sw + x1c];
         var top = v00 + (v10 - v00) * tx;
         var bot = v01 + (v11 - v01) * tx;
         out[rowOut + x] = top + (bot - top) * ty;
      }
   }
   return out;
}

// Runs blurMask() at 1/factor working resolution (box-downsample, blur with
// a proportionally scaled radius, bilinear-upsample back). Blur is
// low-frequency by construction, so for wide kernels this is visually
// indistinguishable from full-resolution blur while cutting the dominant
// O(w*h*radius^2) cost of Disk/Moffat by roughly factor^2, and the
// separable modes by roughly factor. factor<=1 (the default) is a plain
// pass-through to blurMask() with no behaviour change at all. Not part of
// the original script -- see PERFORMANCE NOTES at the end of this file.
function blurMaskScaled(mask, w, h, radius, mode, factor) {
   if (factor <= 1) return blurMask(mask, w, h, radius, mode);
   var ds = downsampleBox(mask, w, h, factor);
   var blurred = blurMask(ds.data, ds.width, ds.height, FMath.max(radius / factor, 0.5), mode);
   return upsampleBilinear(blurred, ds.width, ds.height, w, h);
}

// Same idea for the plain Gaussian blur used on the colour channels.
function gaussianBlurScaled(arr, w, h, radius, factor) {
   if (factor <= 1) return gaussianBlur(arr, w, h, radius);
   var ds = downsampleBox(arr, w, h, factor);
   var blurred = gaussianBlur(ds.data, ds.width, ds.height, FMath.max(radius / factor, 0.5));
   return upsampleBilinear(blurred, ds.width, ds.height, w, h);
}

function blurMask(mask, w, h, radius, mode) {
   radius = FMath.max(0.1, radius);
   switch (mode) {
      case "Gaussian": return gaussianBlur(mask, w, h, radius);
      case "Box":      return boxBlur(mask, w, h, radius);
      case "Disk":     return diskBlur(mask, w, h, radius);
      case "Triangle": return triangleBlur(mask, w, h, radius);
      case "Moffat":   return moffatBlur(mask, w, h, radius);
      default:         return multiscaleGaussianBlur(mask, w, h, radius); // "Multi-scale Gaussian"
   }
}

// ---------------------------------------------------------------------------
// Glow
// ---------------------------------------------------------------------------

function selectStars(catalog, minDiameter, feather) {
   var w = catalog.width, h = catalog.height, n = w * h;
   var sel = componentSelection(catalog, minDiameter, feather);

   var intensity = new Float32Array(n);
   var invRange = 1 / FMath.max(1 - catalog.background, 1e-6);
   for (var i = 0; i < n; ++i) {
      var inten = clamp((catalog.lum[i] - catalog.background) * invRange, 0, 1);
      intensity[i] = inten * sel.selection[i];
   }
   return { intensity: intensity, selection: sel.selection };
}

// Mutates `img` in place (screen-blends the glow onto it). Returns the
// per-pixel selection weight (used only for optional diagnostics).
function applyGlow(img, catalog, params, exclusionMask) {
   var w = img.width, h = img.height, n = w * h;
   var sel = selectStars(catalog, params.minDiameter, params.feather);
   var starMask = sel.intensity, selectionWeight = sel.selection;

   if (exclusionMask) {
      for (var i = 0; i < n; ++i) {
         var allowed = 1 - clamp(exclusionMask[i], 0, 1);
         starMask[i] *= allowed;
         selectionWeight[i] *= allowed;
      }
   }

   var blurred = blurMaskScaled(starMask, w, h, params.radius, params.blurMode, params.downsample);
   var peak = 0;
   for (var i = 0; i < n; ++i) if (blurred[i] > peak) peak = blurred[i];
   if (peak > 0) for (var i = 0; i < n; ++i) blurred[i] /= peak;

   var gammaVal = FMath.max(params.gamma, 0.05);
   var glowAlpha = new Float32Array(n);
   for (var i = 0; i < n; ++i)
      glowAlpha[i] = clamp(FMath.pow(clamp(blurred[i], 0, 1), gammaVal) * params.strength, 0, 1);

   // Colour layer: blur the star-masked colour per channel, renormalize the
   // three channels to sum to 3 (preserves relative hue while decoupling
   // brightness from glow_alpha), then scale by glow_alpha.
   var glowChannels = [];
   if (img.channels === 1) {
      glowChannels.push(glowAlpha);
   } else {
      var blurredColour = [];
      for (var c = 0; c < 3; ++c) {
         var weighted = new Float32Array(n);
         var base = img.data[c];
         for (var i = 0; i < n; ++i) weighted[i] = base[i] * starMask[i];
         blurredColour.push(gaussianBlurScaled(weighted, w, h, FMath.max(params.radius, 0.5), params.downsample));
      }
      for (var c = 0; c < 3; ++c) glowChannels.push(new Float32Array(n));
      for (var i = 0; i < n; ++i) {
         var s = blurredColour[0][i] + blurredColour[1][i] + blurredColour[2][i];
         for (var c = 0; c < 3; ++c) {
            var col = (s > 1e-6) ? blurredColour[c][i] / s : 1 / 3;
            glowChannels[c][i] = clamp(col * 3 * glowAlpha[i], 0, 1);
         }
      }
   }

   var blendAmt = clamp(params.blend, 0.01, 1.0);
   for (var c = 0; c < img.channels; ++c) {
      var base = img.data[c], glow = glowChannels[c];
      for (var i = 0; i < n; ++i) {
         var scr = 1 - (1 - base[i]) * (1 - glow[i]);
         var result = base[i] + (scr - base[i]) * blendAmt;
         if (exclusionMask) {
            var ex = clamp(exclusionMask[i], 0, 1);
            result = result * (1 - ex) + base[i] * ex;
         }
         base[i] = clamp(result, 0, 1);
      }
   }
   return selectionWeight;
}

// ---------------------------------------------------------------------------
// Diffraction spikes -- star detection (core-ball refinement)
// ---------------------------------------------------------------------------

// 3x3 full-block dilation/erosion (local masks only) -- the pair used for
// binary_closing(structure=ones((3,3))) in the original.
function dilate3x3(mask, w, h) {
   var out = new Uint8Array(w * h);
   for (var y = 0; y < h; ++y) {
      for (var x = 0; x < w; ++x) {
         var v = 0;
         for (var dy = -1; dy <= 1 && !v; ++dy) {
            var yy = y + dy;
            if (yy < 0 || yy >= h) continue;
            for (var dx = -1; dx <= 1; ++dx) {
               var xx = x + dx;
               if (xx < 0 || xx >= w) continue;
               if (mask[yy * w + xx]) { v = 1; break; }
            }
         }
         out[y * w + x] = v;
      }
   }
   return out;
}

function erode3x3(mask, w, h) {
   var out = new Uint8Array(w * h);
   for (var y = 0; y < h; ++y) {
      for (var x = 0; x < w; ++x) {
         var v = 1;
         scan:
         for (var dy = -1; dy <= 1; ++dy) {
            var yy = y + dy;
            for (var dx = -1; dx <= 1; ++dx) {
               var xx = x + dx;
               if (yy < 0 || yy >= h || xx < 0 || xx >= w || !mask[yy * w + xx]) {
                  v = 0;
                  break scan;
               }
            }
         }
         out[y * w + x] = v;
      }
   }
   return out;
}

// Fills enclosed background regions: flood-fills background (0) pixels
// starting from the mask border, then anything unreached is an interior
// hole and gets set to 1. Matches ndi.binary_fill_holes().
function fillHoles(mask, w, h) {
   var n = w * h;
   var visited = new Uint8Array(n);
   var stackX = new Int32Array(n);
   var stackY = new Int32Array(n);
   var sp = 0;

   function push(x, y) {
      if (x < 0 || x >= w || y < 0 || y >= h) return;
      var i = y * w + x;
      if (mask[i] || visited[i]) return;
      visited[i] = 1;
      stackX[sp] = x; stackY[sp] = y; sp++;
   }

   for (var x = 0; x < w; ++x) { push(x, 0); push(x, h - 1); }
   for (var y = 0; y < h; ++y) { push(0, y); push(w - 1, y); }

   while (sp > 0) {
      sp--;
      var cx = stackX[sp], cy = stackY[sp];
      push(cx - 1, cy); push(cx + 1, cy); push(cx, cy - 1); push(cx, cy + 1);
   }

   var out = new Uint8Array(n);
   for (var i = 0; i < n; ++i) out[i] = (mask[i] || !visited[i]) ? 1 : 0;
   return out;
}

// Refines one star's raw thresholded core into a solid, single-island blob
// via local closing + hole-filling + largest-island selection, then returns
// its centroid. Scoped to the star's own bounding box (+ a small margin)
// rather than the full image, matching v1.2.0's own use of a padded
// component bounding box for the same purpose.
//
// The core threshold is `normalized >= 0.65` directly, not a sigmoid
// comparison -- v1.2.0 notes sigmoid(normalized, midpoint=0.65) >= 0.5 is
// mathematically equivalent to normalized >= 0.65 (sigmoid(0) == 0.5, and
// it's monotonic), so the exp() call in an earlier draft of this port was
// pure overhead; dropped to match.
function refineCoreBall(labels, lum, l, w, h, bounds, background, denom) {
   var pad = 2;
   var x0 = FMath.max(0, bounds.minX[l] - pad);
   var x1 = FMath.min(w - 1, bounds.maxX[l] + pad);
   var y0 = FMath.max(0, bounds.minY[l] - pad);
   var y1 = FMath.min(h - 1, bounds.maxY[l] + pad);
   var lw = x1 - x0 + 1, lh = y1 - y0 + 1;
   var n = lw * lh;

   var component = new Uint8Array(n);
   var core = new Uint8Array(n);
   for (var ly = 0; ly < lh; ++ly) {
      var gy = y0 + ly, lrow = ly * lw;
      for (var lx = 0; lx < lw; ++lx) {
         var gi = gy * w + (x0 + lx);
         if (labels[gi] !== l) continue;
         var li = lrow + lx;
         component[li] = 1;
         var normd = clamp((lum[gi] - background) / denom, 0, 1);
         if (normd >= 0.65) core[li] = 1;
      }
   }

   var closed = erode3x3(dilate3x3(core, lw, lh), lw, lh);
   var filled = fillHoles(closed, lw, lh);
   for (var i = 0; i < n; ++i) filled[i] = (filled[i] && component[i]) ? 1 : 0;

   var lbl = labelComponents(filled, lw, lh);
   var finalMask = filled;
   if (lbl.count > 1) {
      var areas = new Int32Array(lbl.count + 1);
      for (var i = 0; i < n; ++i) if (lbl.labels[i]) areas[lbl.labels[i]]++;
      var best = 1;
      for (var k = 2; k <= lbl.count; ++k) if (areas[k] > areas[best]) best = k;
      finalMask = new Uint8Array(n);
      for (var i = 0; i < n; ++i) finalMask[i] = (lbl.labels[i] === best) ? 1 : 0;
   }

   var any = false;
   for (var i = 0; i < n && !any; ++i) if (finalMask[i]) any = true;
   if (!any) finalMask = component; // matches the original's fallback to the full component

   var sumX = 0, sumY = 0, cnt = 0;
   for (var ly = 0; ly < lh; ++ly) {
      for (var lx = 0; lx < lw; ++lx) {
         if (finalMask[ly * lw + lx]) { sumX += x0 + lx; sumY += y0 + ly; cnt++; }
      }
   }
   return cnt > 0 ? { x: sumX / cnt, y: sumY / cnt } : null;
}

// Detects one point emitter per selected star: position, brightness, colour,
// diameter and selection weight. Uses the shared catalog (no re-detection).
//
// Note: PixInsight 1.9.4's V8 runtime also exposes a native StarDetector
// class (new StarDetector; D.stars(image) -> array of StarData objects),
// backed by the same C++ detector used by SubframeSelector/StarAlignment.
// It's confirmed real and documented, and would be both faster and more
// robust than this hand-rolled threshold+flood-fill approach. It wasn't
// swapped in here because it selects/weights stars differently (no direct
// equivalent of the diameter-smoothstep feather), so using it changes the
// tool's behaviour, not just its performance.
function detectStarEmitters(img, catalog, minDiameter, feather) {
   var w = catalog.width, h = catalog.height;
   if (catalog.count === 0) return { emitters: [], selection: new Float32Array(w * h) };

   var sel = componentSelection(catalog, minDiameter, feather);
   var labels = catalog.labels, lum = catalog.lum, bounds = catalog.bounds;
   var background = catalog.background;

   var emitters = [];
   for (var l = 1; l <= catalog.count; ++l) {
      if (sel.weights[l] <= 1e-4) continue;
      var peak = catalog.peaks[l];
      var denom = FMath.max(peak - background, 1e-6);

      var core = refineCoreBall(labels, lum, l, w, h, bounds, background, denom);
      if (!core) continue;
      var cy = core.y, cx = core.x;

      var brightness = clamp((peak - background) / FMath.max(1 - background, 1e-6), 0, 1) * sel.weights[l];

      // Colour sample: component pixels between 15% and 85% of (peak-bg)
      // above background, luminance-weighted average, scoped to the star's
      // bounding box.
      var lowB = background + 0.15 * denom, highB = background + 0.85 * denom;
      var x0 = bounds.minX[l], x1 = bounds.maxX[l], y0 = bounds.minY[l], y1 = bounds.maxY[l];
      var csum = [0, 0, 0], wsum = 0, sampleCount = 0;
      for (var gy = y0; gy <= y1; ++gy) {
         var row = gy * w;
         for (var gx = x0; gx <= x1; ++gx) {
            var gi = row + gx;
            if (labels[gi] !== l) continue;
            if (lum[gi] >= lowB && lum[gi] <= highB) {
               var wgt = FMath.max(lum[gi] - background, 1e-6);
               for (var c = 0; c < FMath.min(3, img.channels); ++c) csum[c] += img.data[c][gi] * wgt;
               wsum += wgt; sampleCount++;
            }
         }
      }
      if (sampleCount < 3) {
         csum = [0, 0, 0]; wsum = 0;
         for (var gy = y0; gy <= y1; ++gy) {
            var row = gy * w;
            for (var gx = x0; gx <= x1; ++gx) {
               var gi = row + gx;
               if (labels[gi] !== l) continue;
               var wgt = FMath.max(lum[gi] - background, 1e-6);
               for (var c = 0; c < FMath.min(3, img.channels); ++c) csum[c] += img.data[c][gi] * wgt;
               wsum += wgt;
            }
         }
      }
      var colour = [0, 0, 0];
      for (var c = 0; c < 3; ++c) colour[c] = (wsum > 0) ? csum[c] / wsum : 0;
      var colourPeak = FMath.max(colour[0], colour[1], colour[2], 1e-6);
      for (var c = 0; c < 3; ++c) colour[c] = clamp(colour[c] / colourPeak * brightness, 0, 1);

      emitters.push({ y: cy, x: cx, brightness: brightness, colour: colour,
                       diameter: catalog.diameters[l], selectionFactor: sel.weights[l] });
   }
   return { emitters: emitters, selection: sel.selection };
}

// ---------------------------------------------------------------------------
// Diffraction spikes -- rendering
// ---------------------------------------------------------------------------

// Every pixel of an 8-connected Bresenham line from (x0,y0) to (x1,y1).
// Replaces an earlier draft's parametric "step along by a fixed distance,
// round to nearest pixel" sampling, which could leave gaps at some angles;
// Bresenham guarantees a fully connected line at any angle or length.
function connectedLinePixels(x0, y0, x1, y1) {
   var xs = [], ys = [];
   var dx = FMath.abs(x1 - x0);
   var sx = x0 < x1 ? 1 : -1;
   var dy = -FMath.abs(y1 - y0);
   var sy = y0 < y1 ? 1 : -1;
   var error = dx + dy;
   while (true) {
      xs.push(x0); ys.push(y0);
      if (x0 === x1 && y0 === y1) break;
      var doubledError = 2 * error;
      if (doubledError >= dy) { error += dy; x0 += sx; }
      if (doubledError <= dx) { error += dx; y0 += sy; }
   }
   return { x: xs, y: ys };
}

// theta (offset from the base angle), lengthScale, intensityScale, and
// whether spectral tinting applies to that arm. "Newtonian" is the classic
// 4-arm cross. "JWST" is six long mirror-segment spikes at 60-degree
// intervals plus two shorter horizontal strut spikes.
function buildArmSpecs(spikeType) {
   if (spikeType === "JWST") {
      var specs = [];
      for (var arm = 0; arm < 6; ++arm)
         specs.push({ theta: FMath.PI / 6.0 + arm * FMath.PI / 3.0, lengthScale: 1.0, intensityScale: 1.0, hasSpectrum: true });
      specs.push({ theta: 0.0, lengthScale: 0.42, intensityScale: 0.45, hasSpectrum: false });
      specs.push({ theta: FMath.PI, lengthScale: 0.42, intensityScale: 0.45, hasSpectrum: false });
      return specs;
   }
   var specs4 = [];
   for (var a = 0; a < 4; ++a)
      specs4.push({ theta: a * FMath.PI / 2.0, lengthScale: 1.0, intensityScale: 1.0, hasSpectrum: true });
   return specs4;
}

// Renders every emitter's arms into per-channel canvases via per-segment
// max() compositing -- the direct equivalent of the original's
// np.maximum.at(), now walking Bresenham line pixels instead of a fixed
// parametric step. Handles both spike types and the optional spectral
// (rainbow) diffraction tint.
function drawSpikes(w, h, channels, emitters, length, width, angleDeg, spikeType,
                     spectral, spectralStrength, spectralPosition, spectralSpread,
                     spectralSaturation, spectralSmoothness, perArmVariation) {
   var n = w * h;
   var canvas = [];
   for (var c = 0; c < channels; ++c) canvas.push(new Float32Array(n));

   length = FMath.max(length, 2); width = FMath.max(width, 0);
   var baseAngle = angleDeg * FMath.PI / 180.0;
   var armSpecs = buildArmSpecs(spikeType);
   var hardness = 4.0 - 3.3 * spectralSmoothness;

   var largestDiameter = 1;
   for (var e = 0; e < emitters.length; ++e)
      largestDiameter = FMath.max(largestDiameter, emitters[e].diameter);

   for (var e = 0; e < emitters.length; ++e) {
      var em = emitters[e];
      var diameterRatio = clamp(em.diameter / FMath.max(largestDiameter, 1e-6), 0, 1);
      var sizeFactor = FMath.max(0.08, FMath.pow(diameterRatio, 0.85));
      var featherLength = FMath.pow(clamp(em.selectionFactor, 0, 1), 0.35);
      var emitterLength = FMath.max(2, length * sizeFactor * featherLength);
      var sourceColour = (channels === 1) ? [em.brightness] : em.colour;
      var spectralStarFactor = FMath.pow(diameterRatio, 1.20) * FMath.pow(clamp(em.selectionFactor, 0, 1), 0.50);

      for (var a = 0; a < armSpecs.length; ++a) {
         var spec = armSpecs[a];
         var theta = baseAngle + spec.theta;
         var armLength = FMath.max(2.0, emitterLength * spec.lengthScale);
         var endX = FMath.round(em.x + FMath.cos(theta) * armLength);
         var endY = FMath.round(em.y + FMath.sin(theta) * armLength);
         var line = connectedLinePixels(FMath.round(em.x), FMath.round(em.y), endX, endY);

         var doSpectral = spectral && spec.hasSpectrum && channels >= 3;
         var variationWave = 0, localPosition = 0, localStrength = 0, sigma = 0.005;
         if (doSpectral) {
            variationWave = FMath.sin((a + 1) * 1.618 + em.x * 0.013 + em.y * 0.017);
            localPosition = clamp(spectralPosition + variationWave * perArmVariation * 0.08, 0.05, 0.95);
            localStrength = clamp(spectralStrength * (1.0 + variationWave * perArmVariation * 0.25), 0, 1);
            sigma = FMath.max(spectralSpread * (0.22 + 0.78 * spectralSmoothness) * 0.5, 0.005);
         }

         for (var k = 0; k < line.x.length; ++k) {
            var xx = line.x[k], yy = line.y[k];
            if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
            var dist = FMath.hypot(xx - em.x, yy - em.y);
            var falloff = FMath.exp(-dist / FMath.max(armLength * 0.48, 1e-6)) *
                          FMath.pow(clamp(1 - dist / FMath.max(armLength, 1e-6), 0, 1), 0.35);
            falloff *= spec.intensityScale;
            if (falloff <= 0) continue;

            var spectralMix = 0, spectralRgb = null;
            if (doSpectral) {
               var position = clamp(dist / FMath.max(armLength, 1e-6), 0, 1);
               spectralMix = localStrength * spectralStarFactor *
                             FMath.exp(-0.5 * FMath.pow((position - localPosition) / sigma, 2));
               var phase = clamp((position - (localPosition - spectralSpread * 0.5)) / FMath.max(spectralSpread, 1e-6), 0, 1);
               // Blue near the core, red toward the outer spike (matches the
               // original's channel order: R, G, B formulas in that order).
               var formulaR = FMath.pow(clamp(3.0 * phase - 1.5, 0, 1), hardness);
               var formulaG = FMath.pow(clamp(1.0 - 3.0 * FMath.abs(phase - 0.5), 0, 1), hardness);
               var formulaB = FMath.pow(clamp(1.5 - 3.0 * phase, 0, 1), hardness);
               spectralRgb = [
                  (1 - spectralSaturation) + spectralSaturation * formulaR,
                  (1 - spectralSaturation) + spectralSaturation * formulaG,
                  (1 - spectralSaturation) + spectralSaturation * formulaB
               ];
            }

            var idx = yy * w + xx;
            for (var c = 0; c < channels; ++c) {
               var channelValue = sourceColour[c];
               if (spectralRgb && c < 3) {
                  var spectralValue = em.brightness * (0.20 + 0.80 * spectralRgb[c]);
                  channelValue = channelValue * (1 - spectralMix) + spectralValue * spectralMix;
               }
               var v = falloff * channelValue;
               if (v > canvas[c][idx]) canvas[c][idx] = v;
            }
         }
      }
   }

   // Width is a fixed optical line width, independent of star size.
   if (width > 0.05) {
      for (var c = 0; c < channels; ++c) {
         var origPeak = 0;
         for (var i = 0; i < n; ++i) if (canvas[c][i] > origPeak) origPeak = canvas[c][i];
         var widened = gaussianBlur(canvas[c], w, h, width);
         var widenedPeak = 0;
         for (var i = 0; i < n; ++i) if (widened[i] > widenedPeak) widenedPeak = widened[i];
         if (origPeak > 0 && widenedPeak > 0) {
            var scale = origPeak / widenedPeak;
            for (var i = 0; i < n; ++i) widened[i] *= scale;
         }
         canvas[c] = widened;
      }
   }
   for (var c = 0; c < channels; ++c)
      for (var i = 0; i < n; ++i) canvas[c][i] = clamp(canvas[c][i], 0, 1);
   return canvas;
}

// Detects emitters on `sourceImg` (the pristine pre-glow image) and screen-
// blends primary spikes onto `compositeImg` (post-glow) in place.
function applySpikes(sourceImg, compositeImg, catalog, params, exclusionMask) {
   var w = catalog.width, h = catalog.height, n = w * h;
   var det = detectStarEmitters(sourceImg, catalog, params.minDiameter, params.feather);
   var emitters = det.emitters, selection = det.selection;

   if (exclusionMask) {
      for (var i = 0; i < n; ++i) selection[i] *= (1 - clamp(exclusionMask[i], 0, 1));
      emitters = emitters.filter(function(e) {
         var xx = clamp(FMath.round(e.x), 0, w - 1), yy = clamp(FMath.round(e.y), 0, h - 1);
         return (1 - clamp(exclusionMask[yy * w + xx], 0, 1)) > 0.5;
      });
   }
   if (emitters.length === 0) return selection;

   var preComposite = cloneChannels(compositeImg);
   var spikeRGB = drawSpikes(w, h, sourceImg.channels, emitters, params.length, params.width, params.angle,
                              params.spikeType, params.spectral, params.spectralStrength, params.spectralPosition,
                              params.spectralSpread, params.spectralSaturation, params.spectralSmoothness,
                              params.perArmVariation);
   for (var c = 0; c < sourceImg.channels; ++c)
      for (var i = 0; i < n; ++i) spikeRGB[c][i] = clamp(spikeRGB[c][i] * params.strength, 0, 1);

   var blendAmt = clamp(params.blend, 0.01, 1.0);
   for (var c = 0; c < compositeImg.channels; ++c) {
      var base = preComposite.data[c], spike = spikeRGB[c], out = compositeImg.data[c];
      for (var i = 0; i < n; ++i) {
         var scr = 1 - (1 - base[i]) * (1 - spike[i]);
         out[i] = clamp(base[i] + (scr - base[i]) * blendAmt, 0, 1);
      }
   }

   // Protect the exact centre pixel of each emitter (four-plus arms still
   // run underneath and visibly meet the core without a large artificial
   // gap).
   for (var e = 0; e < emitters.length; ++e) {
      var em = emitters[e];
      var xx = clamp(FMath.round(em.x), 0, w - 1), yy = clamp(FMath.round(em.y), 0, h - 1);
      var idx = yy * w + xx;
      for (var c = 0; c < compositeImg.channels; ++c)
         compositeImg.data[c][idx] = preComposite.data[c][idx];
   }

   if (exclusionMask) {
      for (var c = 0; c < compositeImg.channels; ++c) {
         var out = compositeImg.data[c], pre = preComposite.data[c];
         for (var i = 0; i < n; ++i) {
            var ex = clamp(exclusionMask[i], 0, 1);
            out[i] = out[i] * (1 - ex) + pre[i] * ex;
         }
      }
   }
   return selection;
}

// A second, softer 4-arm spike layer offset +45 degrees from the primary.
// Always classic Newtonian, never spectral, regardless of the primary
// spike's own spikeType/spectral settings -- matches v1.2.0's
// make_secondary_spikes(), which calls draw_point_emitter_spikes() without
// passing spike_type/spectral at all (falling through to their defaults).
// Detects its own emitters (own min_diameter/feather), but borrows the
// primary spike's angle and blend rather than having its own -- matching
// v1.2.0's secondary_spike_parameters(), which reads
// self.spike_angle_spin/self.spike_blend_spin directly.
function applySecondarySpikes(sourceImg, compositeImg, catalog, secondaryParams, angle, blend, exclusionMask) {
   var w = catalog.width, h = catalog.height, n = w * h;
   var det = detectStarEmitters(sourceImg, catalog, secondaryParams.minDiameter, secondaryParams.feather);
   var emitters = det.emitters;

   if (exclusionMask) {
      emitters = emitters.filter(function(e) {
         var xx = clamp(FMath.round(e.x), 0, w - 1), yy = clamp(FMath.round(e.y), 0, h - 1);
         return (1 - clamp(exclusionMask[yy * w + xx], 0, 1)) > 0.5;
      });
   }
   if (emitters.length === 0) return;

   var preComposite = cloneChannels(compositeImg);
   var spikeRGB = drawSpikes(w, h, sourceImg.channels, emitters, secondaryParams.length, secondaryParams.width,
                              angle + 45.0, "Newtonian", false, 0, 0, 0, 0, 0, 0);
   for (var c = 0; c < sourceImg.channels; ++c)
      for (var i = 0; i < n; ++i) spikeRGB[c][i] = clamp(spikeRGB[c][i] * secondaryParams.strength, 0, 1);

   var blendAmt = clamp(blend, 0.01, 1.0);
   for (var c = 0; c < compositeImg.channels; ++c) {
      var base = preComposite.data[c], spike = spikeRGB[c], out = compositeImg.data[c];
      for (var i = 0; i < n; ++i) {
         var scr = 1 - (1 - base[i]) * (1 - spike[i]);
         out[i] = clamp(base[i] + (scr - base[i]) * blendAmt, 0, 1);
      }
   }

   for (var e = 0; e < emitters.length; ++e) {
      var em = emitters[e];
      var xx = clamp(FMath.round(em.x), 0, w - 1), yy = clamp(FMath.round(em.y), 0, h - 1);
      var idx = yy * w + xx;
      for (var c = 0; c < compositeImg.channels; ++c)
         compositeImg.data[c][idx] = preComposite.data[c][idx];
   }

   if (exclusionMask) {
      for (var c = 0; c < compositeImg.channels; ++c) {
         var out = compositeImg.data[c], pre = preComposite.data[c];
         for (var i = 0; i < n; ++i) {
            var ex = clamp(exclusionMask[i], 0, 1);
            out[i] = out[i] * (1 - ex) + pre[i] * ex;
         }
      }
   }
}

// ---------------------------------------------------------------------------
// Dialog
//
// A class declaration (rather than a class expression assigned to a var)
// is safe here specifically because this script runs under the v8 (v8-new)
// engine selector: every execution gets a fresh, isolated runtime, so
// there's no risk of "class already declared" from a redeclaration. That
// risk only applies under the v8-private or v8-default engine selectors,
// where the runtime (or parts of it) persists across runs -- switch to a
// class expression (var AsterDialog = class extends Dialog {...};) if you
// ever change the engine selector at the top of this file to one of those.
// ---------------------------------------------------------------------------

class AsterDialog extends Dialog {
   constructor(p) {
   super();
   var dlg = this;

   this.windowTitle = APP_TITLE;
   this.minWidth = 460;

   this.info = new Label(this);
   this.info.frameStyle = FrameStyle.Box;
   this.info.margin = 4;
   this.info.wordWrapping = true;
   this.info.useRichText = true;
   this.info.text = "<p>Runs on the active image or the active Preview. Optionally pick a " +
      "mono image below as an exclusion mask (1 = fully protected) &mdash; it must match the " +
      "target's pixel dimensions. Detection, glow and spikes all share one star catalog.</p>";

   this.maskLabel = new Label(this);
   this.maskLabel.text = "Exclusion mask:";
   this.maskViewList = new ViewList(this);
   this.maskViewList.getAll();
   this.maskViewList.onViewSelected = function(view) { p.exclusionView = view; };
   var maskRow = new HorizontalSizer;
   maskRow.spacing = 6;
   maskRow.add(this.maskLabel);
   maskRow.add(this.maskViewList, 100);

   function slider(label, min, max, obj, prop, decimals) {
      var c = new NumericControl(dlg);
      c.label.text = label;
      c.label.minWidth = 160;
      c.setRange(min, max);
      c.slider.setRange(0, 500);
      c.setPrecision(decimals === undefined ? 2 : decimals);
      c.setValue(obj[prop]);
      c.onValueUpdated = function(value) { obj[prop] = value; };
      return c;
   }

   this.blackCtl = slider("Detection black point", 0.0, 0.99, p, "detectionBlack", 2);
   this.whiteCtl = slider("Detection white point", 0.01, 1.0, p, "detectionWhite", 2);

   this.maskGlowCheck = new CheckBox(this);
   this.maskGlowCheck.text = "Apply exclusion mask to glow";
   this.maskGlowCheck.checked = p.maskGlow;
   this.maskGlowCheck.onCheck = function(checked) { p.maskGlow = checked; };

   this.maskSpikesCheck = new CheckBox(this);
   this.maskSpikesCheck.text = "Apply exclusion mask to spikes";
   this.maskSpikesCheck.checked = p.maskSpikes;
   this.maskSpikesCheck.onCheck = function(checked) { p.maskSpikes = checked; };

   this.glowCheck = new CheckBox(this);
   this.glowCheck.text = "Glow";
   this.glowCheck.checked = p.glowEnabled;
   this.glowCheck.onCheck = function(checked) { p.glowEnabled = checked; };

   this.blurLabel = new Label(this);
   this.blurLabel.text = "Blur mode:";
   this.blurCombo = new ComboBox(this);
   var blurModes = ["Gaussian", "Multi-scale Gaussian", "Moffat", "Triangle", "Box", "Disk"];
   for (var i = 0; i < blurModes.length; ++i) this.blurCombo.addItem(blurModes[i]);
   this.blurCombo.currentItem = FMath.max(0, blurModes.indexOf(p.glow.blurMode));
   this.blurCombo.onItemSelected = function(index) { p.glow.blurMode = blurModes[index]; };

   this.downsampleLabel = new Label(this);
   this.downsampleLabel.text = "  Blur working scale:";
   this.downsampleCombo = new ComboBox(this);
   var downsampleFactors = [1, 2, 4, 8];
   var downsampleLabels = ["1:1 (off)", "1:2", "1:4", "1:8"];
   for (var i = 0; i < downsampleLabels.length; ++i) this.downsampleCombo.addItem(downsampleLabels[i]);
   this.downsampleCombo.currentItem = FMath.max(0, downsampleFactors.indexOf(p.glow.downsample));
   this.downsampleCombo.toolTip = "Computes the glow blur at a reduced working resolution, then " +
      "upsamples the result. Speeds up large-radius blur (especially Disk/Moffat) with little to " +
      "no visible difference; push it higher only if the radius is large enough to tolerate it.";
   this.downsampleCombo.onItemSelected = function(index) { p.glow.downsample = downsampleFactors[index]; };

   var blurRow = new HorizontalSizer;
   blurRow.spacing = 6;
   blurRow.add(this.blurLabel);
   blurRow.add(this.blurCombo);
   blurRow.add(this.downsampleLabel);
   blurRow.add(this.downsampleCombo);
   blurRow.addStretch();

   this.diameterCtl = slider("Min. star diameter (px)", 1, 300, p.glow, "minDiameter", 0);
   this.featherCtl  = slider("Cutoff feather (px)", 0.5, 40, p.glow, "feather", 1);
   this.radiusCtl   = slider("Glow radius (px)", 0.5, 100, p.glow, "radius", 1);
   this.gammaCtl    = slider("Glow gamma", 0.10, 3, p.glow, "gamma", 2);
   this.strengthCtl = slider("Glow strength", 0, 2, p.glow, "strength", 2);
   this.blendCtl    = slider("Glow blend", 0.01, 1, p.glow, "blend", 2);

   this.spikesCheck = new CheckBox(this);
   this.spikesCheck.text = "Diffraction spikes";
   this.spikesCheck.checked = p.spikesEnabled;
   this.spikesCheck.onCheck = function(checked) { p.spikesEnabled = checked; };

   this.spikeTypeLabel = new Label(this);
   this.spikeTypeLabel.text = "Spike type:";
   this.spikeTypeCombo = new ComboBox(this);
   var spikeTypes = ["Newtonian", "JWST"];
   for (var i = 0; i < spikeTypes.length; ++i) this.spikeTypeCombo.addItem(spikeTypes[i]);
   this.spikeTypeCombo.currentItem = FMath.max(0, spikeTypes.indexOf(p.spike.spikeType));
   this.spikeTypeCombo.onItemSelected = function(index) { p.spike.spikeType = spikeTypes[index]; };
   var spikeTypeRow = new HorizontalSizer;
   spikeTypeRow.spacing = 6;
   spikeTypeRow.add(this.spikeTypeLabel);
   spikeTypeRow.add(this.spikeTypeCombo);
   spikeTypeRow.addStretch();

   this.spikeDiameterCtl = slider("Spike min. diameter (px)", 1, 300, p.spike, "minDiameter", 0);
   this.spikeFeatherCtl  = slider("Spike cutoff feather (px)", 0.5, 40, p.spike, "feather", 1);
   this.spikeLengthCtl   = slider("Spike length (px)", 2, 600, p.spike, "length", 0);
   this.spikeWidthCtl    = slider("Spike softening (px)", 0, 10, p.spike, "width", 2);
   this.spikeAngleCtl    = slider("Spike angle (\u00B0)", 0, 45, p.spike, "angle", 1);
   this.spikeStrengthCtl = slider("Spike strength", 0, 2, p.spike, "strength", 2);
   this.spikeBlendCtl    = slider("Spike blend", 0.01, 1, p.spike, "blend", 2);

   this.spectralCheck = new CheckBox(this);
   this.spectralCheck.text = "Enable spectral diffraction";
   this.spectralCheck.checked = p.spike.spectral;
   this.spectralCheck.onCheck = function(checked) { p.spike.spectral = checked; };

   this.spectralStrengthCtl = slider("Spectral strength", 0, 1, p.spike, "spectralStrength", 2);
   this.spectralSaturationCtl = slider("Spectrum saturation", 0, 1, p.spike, "spectralSaturation", 2);

   this.secondaryCheck = new CheckBox(this);
   this.secondaryCheck.text = "Enable secondary soft spikes (+45\u00B0)";
   this.secondaryCheck.checked = p.secondaryEnabled;
   this.secondaryCheck.onCheck = function(checked) { p.secondaryEnabled = checked; };

   this.secondaryDiameterCtl = slider("Secondary min. diameter (px)", 1, 300, p.secondary, "minDiameter", 0);
   this.secondaryFeatherCtl  = slider("Secondary cutoff feather (px)", 0.5, 80, p.secondary, "feather", 1);
   this.secondaryStrengthCtl = slider("Secondary strength", 0, 2, p.secondary, "strength", 2);
   this.secondaryLengthCtl   = slider("Secondary length (px)", 2, 400, p.secondary, "length", 0);
   this.secondaryWidthCtl    = slider("Secondary width (px)", 0, 20, p.secondary, "width", 2);

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
   this.sizer.add(maskRow);
   this.sizer.add(this.blackCtl);
   this.sizer.add(this.whiteCtl);
   this.sizer.add(this.maskGlowCheck);
   this.sizer.add(this.maskSpikesCheck);
   this.sizer.addSpacing(6);
   this.sizer.add(this.glowCheck);
   this.sizer.add(blurRow);
   this.sizer.add(this.diameterCtl);
   this.sizer.add(this.featherCtl);
   this.sizer.add(this.radiusCtl);
   this.sizer.add(this.gammaCtl);
   this.sizer.add(this.strengthCtl);
   this.sizer.add(this.blendCtl);
   this.sizer.addSpacing(8);
   this.sizer.add(this.spikesCheck);
   this.sizer.add(spikeTypeRow);
   this.sizer.add(this.spikeDiameterCtl);
   this.sizer.add(this.spikeFeatherCtl);
   this.sizer.add(this.spikeLengthCtl);
   this.sizer.add(this.spikeWidthCtl);
   this.sizer.add(this.spikeAngleCtl);
   this.sizer.add(this.spikeStrengthCtl);
   this.sizer.add(this.spikeBlendCtl);
   this.sizer.addSpacing(6);
   this.sizer.add(this.spectralCheck);
   this.sizer.add(this.spectralStrengthCtl);
   this.sizer.add(this.spectralSaturationCtl);
   this.sizer.addSpacing(6);
   this.sizer.add(this.secondaryCheck);
   this.sizer.add(this.secondaryDiameterCtl);
   this.sizer.add(this.secondaryFeatherCtl);
   this.sizer.add(this.secondaryStrengthCtl);
   this.sizer.add(this.secondaryLengthCtl);
   this.sizer.add(this.secondaryWidthCtl);
   this.sizer.addSpacing(8);
   this.sizer.add(buttons);
   } // constructor
} // class AsterDialog

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
   var window = ImageWindow.activeWindow;
   if (window.isNull) {
      (new MessageBox("Aster: no active image window.", APP_TITLE, StdIcon.Error, StdButton.Ok)).execute();
      return;
   }
   var view = window.currentView; // honours an active Preview, if selected

   var p = new AsterParameters();
   p.exclusionView = null;
   var dlg = new AsterDialog(p);
   if (!dlg.execute())
      return;

   console.show();
   console.writeln("Aster: reading pixel data...");

   var img = readChannels(view.image);

   var exclusionMask = null;
   if (p.exclusionView) {
      var mw = p.exclusionView.image.width, mh = p.exclusionView.image.height;
      if (mw !== img.width || mh !== img.height) {
         (new MessageBox("Aster: the exclusion mask (" + mw + "x" + mh + ") doesn't match " +
            "the target image (" + img.width + "x" + img.height + ").",
            APP_TITLE, StdIcon.Error, StdButton.Ok)).execute();
         return;
      }
      exclusionMask = readSingleChannel(p.exclusionView.image, 0);
   }

   view.beginProcess(UndoFlag.PixelData);
   try {
      console.writeln("Aster: detecting stars...");
      var catalog = buildStarCatalog(img, p.detectionBlack, p.detectionWhite);

      var original = p.spikesEnabled ? cloneChannels(img) : null;

      if (p.glowEnabled) {
         console.writeln("Aster: computing glow (" + p.glow.blurMode + ")...");
         applyGlow(img, catalog, p.glow, p.maskGlow ? exclusionMask : null);
      }
      if (p.spikesEnabled) {
         console.writeln("Aster: computing " + p.spike.spikeType + " spikes...");
         applySpikes(original, img, catalog, p.spike, p.maskSpikes ? exclusionMask : null);

         if (p.secondaryEnabled && p.spike.spikeType === "Newtonian") {
            console.writeln("Aster: computing secondary spikes...");
            applySecondarySpikes(original, img, catalog, p.secondary, p.spike.angle, p.spike.blend,
                                  p.maskSpikes ? exclusionMask : null);
         }
      }

      console.writeln("Aster: writing pixel data...");
      writeChannels(view.image, img);
      view.endProcess();
      console.writeln("Aster: done.");
   } catch (e) {
      view.cancelProcess();
      console.criticalln("Aster error: " + e);
      (new MessageBox("Aster failed:\n\n" + e, APP_TITLE, StdIcon.Error, StdButton.Ok)).execute();
   }
}

main();

/* ---------------------------------------------------------------------------
 * v1.2.0 sync -- what changed from the v1.0.0-based port, and why
 * ---------------------------------------------------------------------------
 *
 * ARCHITECTURE -- shared star catalog.
 *   v1.0.0 ran an independent detect-then-label pass for glow and for
 *   spikes. v1.2.0 introduced build_star_catalog(): one shared detection
 *   pass (background, connected components, per-component diameter/peak/
 *   bounds), reused by glow, primary spikes and secondary spikes via
 *   component_selection(). Ported as buildStarCatalog() + componentSelection(),
 *   called once in main() and threaded through every stage below.
 *   v1.2.0 also added an in-memory cache keyed on image identity and a
 *   two-stage floor/reweight detection scheme, purely to keep its live
 *   preview responsive while dragging sliders. That's a GUI-interactivity
 *   optimization with no effect on the final numeric output of a single
 *   deterministic run, so it isn't replicated here -- this script always
 *   computes catalog + selection directly at the real parameter values,
 *   which is mathematically equivalent for a one-shot batch script.
 *
 * ALGORITHM CHANGE -- detection threshold.
 *   v1.0.0 auto-thresholded via background + 3.5*sigma (median/MAD), with a
 *   percentile floor. v1.2.0 replaced this entirely with two user-set
 *   levels: detection black/white points define a linear remap of
 *   luminance, thresholded at a fixed 0.05. This is a deliberate behaviour
 *   change by the original author, not a bug fix -- ported as-is
 *   (buildStarCatalog()'s detectionBlack/detectionWhite parameters).
 *   v1.2.0 also dropped v1.0.0's extra post-opening dilation pass ("No
 *   dilation is used, so nearby halos are not joined") -- ported as-is;
 *   cleanupMask() is now a plain 2x2-structuring-element opening
 *   (erode2x2+dilate2x2 with the same kernel for both steps), matching
 *   ndi.binary_opening(structure=ones((2,2))) exactly, rather than the
 *   erode(2x2)+dilate(cross) approximation an earlier draft of this port
 *   used to stand in for v1.0.0's extra dilation step.
 *
 * NEW FEATURE -- JWST spike pattern.
 *   spikeType "JWST": six long arms at 60-degree intervals plus two short,
 *   dimmer horizontal strut spikes (0.42x length, 0.45x intensity). Ported
 *   via buildArmSpecs(); drawSpikes() is now driven by a per-arm spec list
 *   (angle offset, length scale, intensity scale, spectral eligibility)
 *   instead of a hardcoded 4-arm loop.
 *
 * NEW FEATURE -- spectral (rainbow) diffraction tinting.
 *   An optional per-arm chromatic gradient (blue near the core fading to
 *   red toward the tip), strength/position/spread/saturation/smoothness-
 *   controlled, with a small per-arm/per-star sinusoidal variation so
 *   repeated stars and arms don't look identical. Only the strength and
 *   saturation controls are exposed in the dialog, matching v1.2.0's own
 *   UI -- position/spread/smoothness/per-arm-variation are fixed at the
 *   values v1.2.0 itself hardcodes ("the more natural checkbox-only look
 *   from the first spectral prototype"). JWST's two strut arms never carry
 *   spectral tint (hasSpectrum: false in their arm spec), matching the
 *   original.
 *
 * NEW FEATURE -- secondary spikes.
 *   A second, independently-parameterized 4-arm layer offset +45 degrees
 *   from the primary, always classic Newtonian (never JWST, never
 *   spectral) regardless of the primary spike's own settings. Only applies
 *   when spikesEnabled, secondaryEnabled, and the primary spikeType is
 *   "Newtonian" (a JWST pattern plus a +45-degree 4-arm layer isn't a
 *   combination the original exposes). Ported as applySecondarySpikes(),
 *   detecting its own emitters via the shared catalog but reusing the
 *   primary spike's angle and blend rather than having its own, matching
 *   v1.2.0's secondary_spike_parameters().
 *
 * NEW FEATURE -- independent exclusion-mask gating.
 *   v1.0.0 applied one exclusion mask uniformly to glow and spikes.
 *   v1.2.0 added separate toggles (mask_glow_checkbox / mask_spikes_checkbox,
 *   both default on) so an area can be protected from one effect but not
 *   the other. Ported as params.maskGlow/params.maskSpikes, gating which
 *   calls receive the exclusion mask at all in main().
 *
 * FORMULA CHANGE -- spike length scaling by star size.
 *   v1.0.0: size_factor = 0.30 + 0.70 * diameter_ratio^0.70. v1.2.0:
 *   size_factor = max(0.08, diameter_ratio^0.85) -- a different curve
 *   shape and a lower floor for the smallest selected stars. Ported as-is.
 *
 * MICRO-OPTIMIZATION -- core-ball threshold.
 *   An earlier draft of this port computed a contrast-boosted sigmoid and
 *   compared it to 0.5 per pixel. v1.2.0 points out sigmoid(normalized,
 *   midpoint=0.65) >= 0.5 is mathematically identical to normalized >= 0.65
 *   (the sigmoid crosses 0.5 exactly at its midpoint and is monotonic), so
 *   the exp() call was pure overhead. Dropped to match, in refineCoreBall().
 *
 * RENDERING CHANGE -- Bresenham spike lines.
 *   An earlier draft of this port stepped along each spike arm at a fixed
 *   distance interval and rounded each sample to the nearest pixel, which
 *   could leave small gaps near certain angles. v1.2.0 introduced
 *   connected_line_pixels(), an 8-connected Bresenham line walk that
 *   guarantees a fully connected line at any angle or length. Ported as
 *   connectedLinePixels(), now driving drawSpikes()'s per-arm pixel walk.
 *
 * RELABELED, NOT CHANGED -- default blur mode.
 *   v1.0.0's un-named two-Gaussian fallback blur mode is explicitly labeled
 *   "Multi-scale Gaussian" in v1.2.0's own UI. Renamed
 *   photographicBlur()->multiscaleGaussianBlur() and updated the dialog's
 *   blur-mode combo text/order to match; the math is unchanged.
 *
 * NOT PORTED -- orientation flip (apply_orientation()).
 *   v1.2.0 added a self-inverse flip/rotate step applied on load and
 *   un-applied before writing back to Siril, to compensate for a Siril<->
 *   NumPy vertical-axis display convention mismatch. PixInsight's
 *   ImageIterator reads/writes the image's own pixel buffer directly with
 *   no separate display step, so there's no equivalent mismatch to
 *   compensate for -- not applicable here.
 *
 * NOT PORTED -- live preview, lasso exclusion painting, detection-mask
 * overlay, before/after hold-spacebar toggle.
 *   All Qt-specific interactive GUI features with no PJSR equivalent worth
 *   reimplementing; see the DROPPED note further down for how PixInsight's
 *   own Preview and mask features substitute for the first two.
 * ------------------------------------------------------------------------ */

/* ---------------------------------------------------------------------------
 * What else changed vs. the Siril script (carried over from earlier ports)
 * ---------------------------------------------------------------------------
 *
 * KEPT FAITHFUL, now that direct pixel access is fast under V8:
 *   - Real connected-component labeling (flood fill) instead of a
 *     morphology-only approximation.
 *   - The exact diameter smoothstep star selection (t*t*(3-2*t) feather),
 *     not a hard cutoff.
 *   - All five blur kernels (Gaussian/Box/Disk/Triangle/Moffat) plus the
 *     default two-Gaussian "Multi-scale Gaussian" mix.
 *   - The true locally-weighted colour halo (renormalize-to-3 trick), not
 *     an approximation via image division.
 *   - Spike falloff via per-segment max() sampling, matching
 *     np.maximum.at() exactly rather than an alpha-over approximation.
 *   - Full spike core-ball cleanup (closing + fill-holes + largest-island
 *     selection, via refineCoreBall()), scoped to each star's own bounding
 *     box for speed.
 *   - Support for both float and integer PixInsight images (via
 *     ImageIterator.toReal()/toSample()), matching the original's
 *     normalize_image()/denormalize_image() handling of Siril's 16-bit
 *     integer vs. float working range.
 *
 * DROPPED -- live-drag preview with a lasso exclusion mask.
 *   Rebuilding a real-time bitmap-drag preview pane is a large chunk of
 *   Qt-specific UI code with no PJSR equivalent worth the effort. Two
 *   things stand in for it: run on a PixInsight Preview over a star-rich
 *   patch to iterate quickly (this script honours window.currentView), and
 *   pick any open mono image as an exclusion mask via the ViewList control
 *   -- paint it with PixInsight's own mask tools first.
 *
 * SIMPLIFIED -- spike core-ball extraction edge case.
 *   The largest-island selection in refineCoreBall() is a plain area-max
 *   over local flood-fill labels, not scipy's np.argmax(bincount) -- same
 *   result, different implementation.
 *
 * NOT PORTED -- push-to-Siril plumbing.
 *   Not applicable; beginProcess()/endProcess() gives full native Undo,
 *   which is the PixInsight equivalent of Siril's undo_save_state() +
 *   set_image_pixeldata().
 *
 * PERFORMANCE NOTES
 *   - All Math.* calls have been replaced with FMath.* (a WebAssembly-backed
 *     drop-in for Math, confirmed in PixInsight's own V8 porting guide to
 *     run up to an order of magnitude faster on heavy calculation loops --
 *     exactly what the blur kernels and spike falloff are).
 *   - background (catalog.background) runs on a deterministic stride
 *     subsample (capped at 400,000 samples) via subsample(), not the full-
 *     resolution luminance array -- a single robust statistic, not a per-
 *     pixel decision, so the subsample is statistically equivalent in
 *     practice and sorting cost stops scaling with image size.
 *   - refineCoreBall() and the spike colour sampler are scoped to each
 *     star's own bounding box (computeLabelBounds()), not a full-image scan
 *     per star -- cost is proportional to total star footprint area, not
 *     image size times star count.
 *   - Disk and Moffat blur are direct O(w*h*radius^2) 2D convolutions --
 *     by far the most expensive option at large radii, and Moffat is the
 *     default blur mode (matching the original script's default). The
 *     "Blur working scale" dialog control (params.glow.downsample, default
 *     1 = off) computes the blur at 1/factor resolution and bilinear-
 *     upsamples it back -- roughly factor^2 cheaper for Disk/Moffat and
 *     factor cheaper for the separable modes, with little to no visible
 *     difference for a wide kernel, since blur is inherently low-frequency.
 *     Star selection/detection itself always runs at full resolution
 *     regardless of this setting -- only the blur step is affected.
 *   - labelComponents() allocates two Int32Array(width*height) scratch
 *     buffers per call (worst-case stack size) -- memory-heavy on very
 *     large frames, but stars are sparse in practice so actual usage
 *     stays far below that bound.
 *   - No multithreading: PixInsight 1.9.4's V8 runtime doesn't have
 *     JavaScript worker threads yet (per Pleiades' own porting guide --
 *     "We'll have them soon"), so this runs on a single core regardless of
 *     how many are available. Not something this script can work around.
 * ------------------------------------------------------------------------ */
