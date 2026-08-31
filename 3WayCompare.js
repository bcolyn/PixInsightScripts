// 3-way-compare.js
// Tiles up to three image windows side-by-side horizontally.
// Designed for ultrawide monitors. Run via Script > Run Script File...
//
// Behaviour:
//   - Asks which windows to use, and in which order (left / middle / right).
//   - Divides the available workspace width into equal columns.
//   - Each window fills one column at full workspace height.
//   - Fewer than 3 windows may be selected; the columns are sized to match.

#include <pjsr/TextAlign.jsh>    // TextAlign_Right, TextAlign_VertCenter
#include <pjsr/Sizer.jsh>        // HorizontalSizer, VerticalSizer

#feature-id    bcolyn.ThreeWayCompare : Utilities > 3-way Compare
#feature-info  Tiles up to three selected image windows side-by-side \
               horizontally, each filling one column at full workspace height. \
               Nice when comparing A,B and a ground truth image. Especially \
               useful for ultrawide monitors.

(function () {

   // Collect all image windows.
   // Note: ImageWindow.windows is in creation order (oldest first) and PJSR
   // exposes no activation history, so the choice is left to the user; the
   // active window plus the newest others are merely pre-selected as a
   // sensible default.
   var windows = ImageWindow.windows.filter( function( w ) {
      return !w.isNull && !w.iconic;
   } );

   if ( windows.length === 0 ) {
      Console.warningln( "3-way Compare: No image windows are open." );
      return;
   }

   // -------------------------------------------------------------------------
   // Default selection: the newest windows, but always including the active
   // one (the only piece of "recently used" information PJSR exposes). The
   // three are laid out in creation order, oldest of them on the left.
   // -------------------------------------------------------------------------
   var activeIndex = -1;
   var activeWindow = ImageWindow.activeWindow;
   if ( activeWindow && !activeWindow.isNull )
      for ( var a = 0; a < windows.length; ++a )
         if ( windows[a].mainView.fullId == activeWindow.mainView.fullId ) {
            activeIndex = a;
            break;
         }

   var defaultIndices = [];
   // Newest first, so the oldest candidate is the one dropped when the active
   // window has to be squeezed in.
   for ( var d = windows.length - 1; d >= 0 && defaultIndices.length < 3; --d )
      if ( d != activeIndex )
         defaultIndices.push( d );
   if ( activeIndex >= 0 ) {
      if ( defaultIndices.length == 3 )
         defaultIndices.pop();
      defaultIndices.push( activeIndex );
   }
   defaultIndices.sort( function( x, y ) { return x - y; } );

   // -------------------------------------------------------------------------
   // Selection dialog: one combo box per column, each listing all open windows
   // plus a "none" entry so fewer than three columns can be tiled.
   // -------------------------------------------------------------------------
   var NONE = -1;

   function SelectionDialog()
   {
      this.__base__ = Dialog;
      this.__base__();

      var dialog = this;

      this.selection = [ NONE, NONE, NONE ];
      for ( var k = 0; k < defaultIndices.length; ++k )
         this.selection[k] = defaultIndices[k];

      this.infoLabel = new Label( this );
      this.infoLabel.wordWrapping = true;
      this.infoLabel.useRichText = true;
      this.infoLabel.text = "Choose the windows to tile, from left to right.";

      // OK is enabled only for a valid selection: at least one window, and no
      // window used in two columns.
      this.updateOkButton = function()
      {
         var used = {};
         var count = 0;
         var duplicate = false;
         for ( var i = 0; i < 3; ++i )
         {
            var s = dialog.selection[i];
            if ( s === NONE )
               continue;
            ++count;
            if ( used[s] )
               duplicate = true;
            used[s] = true;
         }
         dialog.okButton.enabled = count > 0 && !duplicate;
         dialog.infoLabel.text = duplicate ?
            "<b>The same window cannot be used in more than one column.</b>" :
            "Choose the windows to tile, from left to right.";
      };

      var labels = [ "Left:", "Middle:", "Right:" ];
      this.combos = [];
      this.rows = [];

      function makeRow( column )
      {
         var label = new Label( dialog );
         label.text = labels[column];
         label.textAlignment = TextAlign_Right | TextAlign_VertCenter;
         label.setFixedWidth( 48 );

         var combo = new ComboBox( dialog );
         combo.addItem( "<none>" );
         for ( var i = 0; i < windows.length; ++i )
            combo.addItem( windows[i].mainView.id );
         combo.currentItem = dialog.selection[column] + 1;
         combo.onItemSelected = function( index )
         {
            dialog.selection[column] = index - 1;
            dialog.updateOkButton();
         };

         dialog.combos.push( combo );

         var sizer = new HorizontalSizer;
         sizer.spacing = 6;
         sizer.add( label );
         sizer.add( combo, 100 );
         return sizer;
      }

      for ( var c = 0; c < 3; ++c )
         this.rows.push( makeRow( c ) );

      // --- Buttons ---

      this.okButton = new PushButton( this );
      this.okButton.text = "OK";
      this.okButton.defaultButton = true;
      this.okButton.onClick = function() { dialog.ok(); };

      this.cancelButton = new PushButton( this );
      this.cancelButton.text = "Cancel";
      this.cancelButton.onClick = function() { dialog.cancel(); };

      this.buttonsSizer = new HorizontalSizer;
      this.buttonsSizer.spacing = 6;
      this.buttonsSizer.addStretch();
      this.buttonsSizer.add( this.okButton );
      this.buttonsSizer.add( this.cancelButton );

      // --- Dialog layout ---

      this.sizer = new VerticalSizer;
      this.sizer.margin = 8;
      this.sizer.spacing = 6;
      this.sizer.add( this.infoLabel );
      this.sizer.addSpacing( 4 );
      for ( var r = 0; r < this.rows.length; ++r )
         this.sizer.add( this.rows[r] );
      this.sizer.addSpacing( 4 );
      this.sizer.add( this.buttonsSizer );

      this.windowTitle = "3-way Compare";
      this.adjustToContents();
      this.setMinWidth( 360 );
      this.updateOkButton();
   }

   SelectionDialog.prototype = new Dialog;

   var dlg = new SelectionDialog();
   if ( !dlg.execute() )
      return;

   var targets = [];
   for ( var s = 0; s < 3; ++s )
      if ( dlg.selection[s] !== NONE )
         targets.push( windows[dlg.selection[s]] );

   var count = targets.length;

   // -------------------------------------------------------------------------
   // Workspace geometry
   // -------------------------------------------------------------------------
   // Create a temporary screen-sized image, zoom in once (zoom != 1 is
   // required for fitWindow to expand to MDI bounds rather than image size),
   // move to origin, then fitWindow() caps at the true MDI bounds.
   var wsX0, wsY0, wsX1, wsY1, wsW, wsH;
   (function () {
      var probe = new Dialog;
      var sr  = probe.screenRect;
      probe = null;
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
