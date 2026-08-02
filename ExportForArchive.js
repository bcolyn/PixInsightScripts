#engine v8
/*
* Utility script to export relevant data from a project for long-term archival.
*
* (c) Benny Colyn 2020-2021
*/

#feature-id    bcolyn.ExportForArchive : Utilities > Export For Archival

#feature-info  A script to export relevant data for archival.<br/>\
   <br/>\
   A utility script for exporting the images in an open format (XISF) as well as the processing history for future reference.<br/>\
   <br/>\
   Upon startup, shows a dialog to choose an export directory, which items to export (images, processing history, \
   processing log), and the XISF compression settings to use for the images.<br/>\
   <br/>\
   Copyright &copy; 2020-2021 Benny Colyn

#define VERSION "1.0.0"

CoreApplication.ensureMinimumVersion(1, 9, 4);

// Self-executing closure — keeps all symbols out of the global namespace.
(function () {

// Backwards-compatible with the original hard-coded hints: "checksums sha1 compression-codec zlib+sh compression-level 100 fits-keywords properties".
const DEFAULT_COMPRESSION_CODEC = "zlib+sh";
const DEFAULT_COMPRESSION_LEVEL = 100;

// [ menu label, hints compression-codec value ("" means no compression) ]
const COMPRESSION_CODECS = [
   [ "None", "" ],
   [ "Zlib", "zlib" ],
   [ "Zlib + byte shuffling", "zlib+sh" ],
   [ "LZ4", "lz4" ],
   [ "LZ4 + byte shuffling", "lz4+sh" ],
   [ "LZ4-HC", "lz4hc" ],
   [ "LZ4-HC + byte shuffling", "lz4hc+sh" ],
   [ "Zstandard", "zstd" ],
   [ "Zstandard + byte shuffling", "zstd+sh" ]
];

function saveImage( window, id, dir, compressionCodec, compressionLevel ) {
   let filename = dir + "/" + id + ".xisf";
   let image = window.mainView.image;
   let hints = "checksums sha1 fits-keywords properties";
   if ( compressionCodec )
      hints += " compression-codec " + compressionCodec + " compression-level " + compressionLevel;
   let fileFormat = new FileFormat( ".xisf", false/*toRead*/, true/*toWrite*/ );

   let description = new ImageDescription();
   description.bitsPerSample = image.bitsPerSample;
   description.ieeefpSampleFormat = image.isReal;

   let file = new FileFormatInstance( fileFormat );
   if ( !file.create( filename, hints ) )
      throw new Error( "Error creating file: " + filename );

   window.mainView.exportProperties( file );
   file.keywords = window.keywords;

   file.setOptions( description );
   file.setImageId( id );

   if ( !file.writeImage( image ) )
      throw new Error( "Error writing file: " + filename );

   file.close();
}

function saveHistory( windows, dir ) {
   console.writeln( "Saving image history process containers." );
   let filename = dir + "/history.xpsm";

   let xml = new XMLDocument();
   xml.xml = new XMLDeclaration( "1.0", "UTF-8" );

   let root = new XMLElement( "xpsm" );
   root.setAttribute( "version", "1.0" );
   root.setAttribute( "xmlns", "http:\/\/www.pixinsight.com/xpsm" );
   root.setAttribute( "xmlns:xsi", "http:\/\/www.w3.org/2001/XMLSchema-instance" );
   root.setAttribute( "xsi:schemaLocation", "http:\/\/www.pixinsight.com/xpsm http:\/\/pixinsight.com/xsd/xpsm-1.0.xsd" );

   for ( let i = 0; i < windows.length; ++i ) {
      let window = windows[i];
      let procContainer = window.mainView.processing;
      let id = window.mainView.id;

      // The process container only exposes its XML serialization as a source string, and
      // XMLElement.name is read-only, so the instance element must be renamed before parsing.
      // Both the opening and closing tags carry the name, so every occurrence must be replaced.
      let source = procContainer.toSource( "XPSM 1.0" )
         .replaceAll( "ProcessContainer_instance", id + "_instance" );

      let instanceDoc = new XMLDocument();
      instanceDoc.parse( source );
      // Deep-copy the parsed element so it is detached from instanceDoc before reparenting it.
      root.addChildNode( new XMLElement( instanceDoc.rootElement ) );

      let icon = new XMLElement( "icon" );
      icon.setAttribute( "id", id );
      icon.setAttribute( "instance", id + "_instance" );
      icon.setAttribute( "xpos", "32" );
      icon.setAttribute( "ypos", format( "%d", i * 32 ) );
      root.addChildNode( icon );
   }

   // Assign the fully built tree only once complete: XMLDocument.rootElement adopts a
   // snapshot of the element at assignment time, so children added afterwards would
   // otherwise be invisible to the serialized document.
   xml.rootElement = root;

   xml.autoFormatting = true;
   xml.serializeToFile( filename );
}

function saveProcessingLog( windows, dir ) {
   console.writeln( "Saving processing log." );
   let filename = dir + "/history.log";
   let string = "";

   for ( let i = 0; i < windows.length; ++i ) {
      let window = windows[i];
      let procContainer = window.mainView.processing;
      let id = window.mainView.id;
      string += id + ":\n";
      for ( let j = 0; j < procContainer.length; ++j )
         string += "  " + procContainer[j].processId() + "\n";
      string += "\n";
   }

   File.writeFile( filename, ByteArray.stringToUTF8( string ) );
}

// A class declaration is safe here because this script runs under the v8
// (v8-new) engine selector, which gives every execution a fresh runtime.
class ExportOptionsDialog extends Dialog {
   constructor() {
      super();
      let dialog = this;

      this.directory = "";
      this.exportImages = true;
      this.compressionCodec = DEFAULT_COMPRESSION_CODEC;
      this.compressionLevel = DEFAULT_COMPRESSION_LEVEL;
      this.exportHistory = true;
      this.exportLog = true;

      // --- Export directory ---

      this.dirEdit = new Edit( this );
      this.dirEdit.readOnly = true;
      this.dirEdit.text = this.directory;

      this.dirButton = new PushButton( this );
      this.dirButton.text = "Browse...";
      this.dirButton.onClick = function () {
         let dirDlg = new GetDirectoryDialog();
         dirDlg.initialPath = dialog.directory;
         if ( dirDlg.execute() ) {
            dialog.directory = dirDlg.directoryPath;
            dialog.dirEdit.text = dialog.directory;
            dialog.okButton.enabled = dialog.directory.length > 0;
         }
      };

      this.dirSizer = new HorizontalSizer;
      this.dirSizer.spacing = 6;
      this.dirSizer.add( this.dirEdit, 100 );
      this.dirSizer.add( this.dirButton );

      // --- Images (with compression settings) ---

      this.imagesGroupBox = new GroupBox( this );
      this.imagesGroupBox.title = "Export images (XISF)";
      this.imagesGroupBox.titleCheckBox = true;
      this.imagesGroupBox.checked = this.exportImages;
      this.imagesGroupBox.onCheck = function ( checked ) {
         dialog.exportImages = checked;
      };

      this.codecLabel = new Label( this );
      this.codecLabel.text = "Compression:";
      this.codecLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;

      this.codecCombo = new ComboBox( this );
      for ( let i = 0; i < COMPRESSION_CODECS.length; ++i )
         this.codecCombo.addItem( COMPRESSION_CODECS[i][0] );
      this.codecCombo.currentItem = FMath.max( 0,
         COMPRESSION_CODECS.findIndex( c => c[1] == dialog.compressionCodec ) );
      this.codecCombo.onItemSelected = function ( index ) {
         dialog.compressionCodec = COMPRESSION_CODECS[index][1];
         dialog.levelSpinBox.enabled = dialog.compressionCodec.length > 0;
      };

      this.levelLabel = new Label( this );
      this.levelLabel.text = "Level:";
      this.levelLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;

      this.levelSpinBox = new SpinBox( this );
      this.levelSpinBox.setRange( 0, 100 );
      this.levelSpinBox.value = this.compressionLevel;
      this.levelSpinBox.enabled = this.compressionCodec.length > 0;
      this.levelSpinBox.onValueUpdated = function ( value ) {
         dialog.compressionLevel = value;
      };

      this.compressionSizer = new HorizontalSizer;
      this.compressionSizer.spacing = 6;
      this.compressionSizer.add( this.codecLabel );
      this.compressionSizer.add( this.codecCombo );
      this.compressionSizer.addSpacing( 12 );
      this.compressionSizer.add( this.levelLabel );
      this.compressionSizer.add( this.levelSpinBox );
      this.compressionSizer.addStretch();

      this.imagesGroupBox.sizer = new VerticalSizer;
      this.imagesGroupBox.sizer.margin = 6;
      this.imagesGroupBox.sizer.add( this.compressionSizer );

      // --- History / log ---

      this.historyCheckBox = new CheckBox( this );
      this.historyCheckBox.text = "Export processing history (XPSM)";
      this.historyCheckBox.checked = this.exportHistory;
      this.historyCheckBox.onCheck = function ( checked ) {
         dialog.exportHistory = checked;
      };

      this.logCheckBox = new CheckBox( this );
      this.logCheckBox.text = "Export processing log (text)";
      this.logCheckBox.checked = this.exportLog;
      this.logCheckBox.onCheck = function ( checked ) {
         dialog.exportLog = checked;
      };

      // --- Buttons ---

      this.okButton = new PushButton( this );
      this.okButton.text = "OK";
      this.okButton.defaultButton = true;
      this.okButton.enabled = false;
      this.okButton.onClick = function () {
         dialog.ok();
      };

      this.cancelButton = new PushButton( this );
      this.cancelButton.text = "Cancel";
      this.cancelButton.onClick = function () {
         dialog.cancel();
      };

      this.buttonsSizer = new HorizontalSizer;
      this.buttonsSizer.spacing = 6;
      this.buttonsSizer.addStretch();
      this.buttonsSizer.add( this.okButton );
      this.buttonsSizer.add( this.cancelButton );

      // --- Dialog layout ---

      this.sizer = new VerticalSizer;
      this.sizer.margin = 8;
      this.sizer.spacing = 8;
      this.sizer.add( this.dirSizer );
      this.sizer.add( this.imagesGroupBox );
      this.sizer.add( this.historyCheckBox );
      this.sizer.add( this.logCheckBox );
      this.sizer.add( this.buttonsSizer );

      this.windowTitle = "Export For Archival";
   } // constructor
} // class ExportOptionsDialog


function main() {
   let dlg = new ExportOptionsDialog();
   if ( !dlg.execute() )
      return;

   let dir = dlg.directory;
   let allWindows = ImageWindow.windows;

   console.show();

   if ( dlg.exportImages )
      for ( let i = 0; i < allWindows.length; ++i ) {
         console.writeln( "<br><b>Image " + allWindows[i].mainView.id + "</b>" );
         saveImage( allWindows[i], allWindows[i].mainView.id, dir, dlg.compressionCodec, dlg.compressionLevel );
      }
   console.writeln( "" );

   if ( dlg.exportHistory )
      saveHistory( allWindows, dir );
   if ( dlg.exportLog )
      saveProcessingLog( allWindows, dir );

   console.writeln( "<br><b>Done.</b>" );
}

main();

})();
