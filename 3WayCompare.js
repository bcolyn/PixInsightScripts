// 3-way-compare.js
// Tiles the three most recently used image windows side-by-side horizontally.
// Designed for ultrawide monitors. Run via Script > Run Script File...
//
// Behaviour:
//   - Takes up to 3 visible ImageWindow instances.
//   - Divides the available workspace width into three equal columns.
//   - Each window fills one column at full workspace height.
//   - If fewer than 3 windows are open, tiles however many exist.

#feature-id    Utilities > 3-way Compare
#feature-info  Tiles three image windows side-by-side for ultrawide screens.

(function () {

   // Collect all image windows.
   var windows = ImageWindow.windows.filter( function( w ) {
      return !w.isNull && !w.iconic;
   } );

   if ( windows.length === 0 ) {
      Console.warningln( "3-way Compare: No image windows are open." );
      return;
   }

   // Work with at most 3 windows; take the first N in the list.
   // PixInsight orders ImageWindow.windows with the most recently
   // activated window first, so slice from the front.
   var count = Math.min( windows.length, 3 );
   var targets = windows.slice( 0, count );

   // -------------------------------------------------------------------------
   // Workspace geometry
   // -------------------------------------------------------------------------
   // Create a temporary screen-sized image, zoom in once (zoom != 1 is
   // required for fitWindow to expand to MDI bounds rather than image size),
   // move to origin, then fitWindow() caps at the true MDI bounds.
   var wsX0, wsY0, wsX1, wsY1, wsW, wsH;
   (function () {
      var dlg = new Dialog;
      var sr  = dlg.screenRect;
      dlg = null;
      var tmp = new ImageWindow( sr.width, sr.height, 1, 8, false, false, "mdi_probe" );
      tmp.show();
      tmp.bringToFront();
      tmp.zoomIn();
      tmp.geometry = new Rect( 0, 0, sr.width, sr.height );
      tmp.fitWindow();
      var g = tmp.geometry;
      wsX0 = g.x0;  wsY0 = g.y0;
      wsX1 = g.x1;  wsY1 = g.y1;
      wsW  = g.width;
      wsH  = g.height;
      tmp.forceClose();
   })();
   Console.noteln( "3-way Compare: MDI workspace " + wsW + "x" + wsH +
                   " at (" + wsX0 + "," + wsY0 + ")" );

   // -------------------------------------------------------------------------
   // Calculate per-column geometry
   // -------------------------------------------------------------------------
   var colW = Math.floor( wsW / count );   // width of each column
   var colH = wsH;                          // full workspace height

   // -------------------------------------------------------------------------
   // Position and resize each window via geometry (a Rect).
   // Assigning a new Rect to w.geometry moves and resizes the window frame.
   // -------------------------------------------------------------------------
   for ( var i = 0; i < count; ++i ) {
      var w  = targets[i];
      var x0 = wsX0 + i * colW;
      var y0 = wsY0;
      // Last column absorbs any leftover pixels to avoid a gap on the right.
      var x1 = ( i === count - 1 ) ? wsX1 : x0 + colW;
      var y1 = wsY1;

      // Ensure the window is visible and active before setting geometry;
      // PI ignores geometry assignment on non-focused windows.
      w.show();
      w.bringToFront();
      w.geometry = new Rect( x0, y0, x1, y1 );
   }

   Console.noteln( "3-way Compare: " + count + " window(s) tiled across " +
                   wsW + "x" + wsH + "." );

} )();
