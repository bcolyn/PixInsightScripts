/*
* Utility script to export relevant data from a project for long-term archival.
*
* (c) Benny Colyn 2020-2021
*/

#feature-id    Utilities > Export For Archival

#feature-info  A script to export relevant data for archival.<br/>\
   <br/>\
   A utility script for exporting the images in an open format (XISF) as well as the processing history for future reference.<br/>\
   <br/>\
   Upon startup, asks for a directory to export the data to. If confirmed, will proceed to write all the images in compressed form.<br/>\
   <br/>\
   Copyright &copy; 2020-2021 Benny Colyn

#define VERSION "0.9.0"

"use strict";

// Self-executing closure — keeps all symbols out of the global namespace.
(function () {

function saveImage( window, id, dir ) {
   let filename = dir + "/" + id + ".xisf";
   let image = window.mainView.image;
   let hints = "checksums sha1 compression-codec zlib+sh compression-level 100 fits-keywords properties";
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

   let string = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n";
   string += "<xpsm version=\"1.0\" xmlns=\"http:\/\/www.pixinsight.com/xpsm\" " +
      "xmlns:xsi=\"http:\/\/www.w3.org/2001/XMLSchema-instance\" " +
      "xsi:schemaLocation=\"http:\/\/www.pixinsight.com/xpsm http:\/\/pixinsight.com/xsd/xpsm-1.0.xsd\">\n";

   for ( let i = 0; i < windows.length; ++i ) {
      let window = windows[i];
      let procContainer = window.mainView.processing;
      let id = window.mainView.id;
      let source = procContainer.toSource( "XPSM 1.0" );

      let lines = source.split( "\n" );
      if ( lines.length > 0 ) {
         let firstLine = lines[0].replace( "ProcessContainer_instance", id + "_instance" );
         string += firstLine + "\n";
         for ( let j = 1; j < lines.length; ++j )
            string += lines[j] + "\n";

         string += "   <icon id=\"" + id + "\" instance=\"" + id + "_instance\" " +
            "xpos=\"32\" ypos=\"" + format( "%d", i * 32 ) + "\"/>\n";
      }
   }

   string += "</xpsm>\n";

   File.writeFile( filename, ByteArray.stringToUTF8( string ) );
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
         string += "  " + procContainer.at( j ).processId() + "\n";
      string += "\n";
   }

   File.writeFile( filename, ByteArray.stringToUTF8( string ) );
}

function main() {
   let dlg = new GetDirectoryDialog();
   if ( !dlg.execute() )
      return;

   let dir = dlg.directory;
   let allWindows = ImageWindow.windows;

   console.show();

   for ( let i = 0; i < allWindows.length; ++i ) {
      console.writeln( "<br><b>Image " + allWindows[i].mainView.id + "</b>" );
      saveImage( allWindows[i], allWindows[i].mainView.id, dir );
   }
   console.writeln( "" );

   saveHistory( allWindows, dir );
   saveProcessingLog( allWindows, dir );

   console.writeln( "<br><b>Done.</b>" );
}

main();

})();
