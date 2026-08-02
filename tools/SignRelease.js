// ****************************************************************************
// SignRelease.js
// PixInsight JavaScript Runtime (PJSR) Script
//
// Signs the scripts and the update repository built by build-release.py,
// using a Certified PixInsight Developer (or local) signing identity stored
// in a .xssk secure signing keys file.
//
// This is a development tool, not one of the published scripts -- it lives
// under tools/ so build-release.py (which only globs *.js in the repo root)
// never packages it.
//
// Workflow:
//   1. Run this script's "Sign Scripts" step BEFORE `python build-release.py`,
//      so the .xsgn signature files it creates get picked up and bundled
//      into the zip alongside their .js files.
//   2. Run `python build-release.py` to (re)build release/bcolyn-scripts.zip
//      and release/updates.xri.
//   3. Run this script's "Sign updates.xri" step AFTER build-release.py, so
//      the signature covers the final, up-to-date repository document.
// ****************************************************************************

#feature-id    bcolyn.SignRelease : Development > Sign Release
#feature-info  Signs repository scripts and updates.xri with a PixInsight signing identity.

#include <pjsr/Sizer.jsh>
#include <pjsr/TextAlign.jsh>
#include <pjsr/FrameStyle.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/StdIcon.jsh>
#include <pjsr/DataType.jsh>

#define SETTINGS_KEY "SignRelease"

function findRootScripts( repoRoot ) {
   var files = [];
   var ff = new FileFind;
   if ( ff.begin( repoRoot + "/*.js" ) )
   {
      do
      {
         if ( !ff.isDirectory )
            files.push( repoRoot + "/" + ff.name );
      } while ( ff.next() );
   }
   return files;
}

function SignReleaseDialog() {
   this.__base__ = Dialog;
   this.__base__();

   var self = this;
   this.windowTitle = "Sign Release";
   this.minWidth = 620;

   var LABEL_W = this.font.width( "Signing keys (.xssk):" ) + 8;

   function makeRow( text ) {
      var l = new Label( self );
      l.text = text;
      l.textAlignment = TextAlign_Right | TextAlign_VertCenter;
      l.minWidth = LABEL_W;
      return l;
   }

   // ---- Repository root ----
   this.rootEdit = new Edit( this );
   this.rootEdit.text = Settings.read( SETTINGS_KEY + "/repoRoot", DataType_UCString ) || "";
   this.rootEdit.toolTip = "Root directory of the PixInsightScripts repository (contains the .js scripts and the release/ folder).";

   this.browseRootButton = new PushButton( this );
   this.browseRootButton.text = "Browse…";
   this.browseRootButton.onClick = function () {
      var dlg = new GetDirectoryDialog;
      dlg.caption = "Select Repository Root";
      if ( self.rootEdit.text.length > 0 )
         dlg.initialPath = self.rootEdit.text;
      if ( dlg.execute() )
         self.rootEdit.text = dlg.directory;
   };

   var rootRow = new HorizontalSizer;
   rootRow.spacing = 6;
   rootRow.add( makeRow( "Repository root:" ) );
   rootRow.add( this.rootEdit, 100 );
   rootRow.add( this.browseRootButton );

   // ---- Signing keys file ----
   this.keysEdit = new Edit( this );
   this.keysEdit.text = Settings.read( SETTINGS_KEY + "/keysFile", DataType_UCString ) || "";
   this.keysEdit.toolTip = "Path to your .xssk secure signing keys file, created with PixInsight's SigningKeys script.";

   this.browseKeysButton = new PushButton( this );
   this.browseKeysButton.text = "Browse…";
   this.browseKeysButton.onClick = function () {
      var dlg = new OpenFileDialog;
      dlg.caption = "Select Signing Keys File";
      dlg.multipleSelections = false;
      dlg.filters = [ [ "Signing Keys (*.xssk)", "*.xssk" ], [ "All Files (*.*)", "*.*" ] ];
      if ( dlg.execute() )
         self.keysEdit.text = dlg.fileName;
   };

   var keysRow = new HorizontalSizer;
   keysRow.spacing = 6;
   keysRow.add( makeRow( "Signing keys (.xssk):" ) );
   keysRow.add( this.keysEdit, 100 );
   keysRow.add( this.browseKeysButton );

   // ---- Password ----
   this.passwordEdit = new Edit( this );
   this.passwordEdit.toolTip = "Password protecting the signing keys file. Not persisted between sessions.";

   var passwordRow = new HorizontalSizer;
   passwordRow.spacing = 6;
   passwordRow.add( makeRow( "Keys password:" ) );
   passwordRow.add( this.passwordEdit, 100 );

   // ---- Entitlements (optional) ----
   this.entitlementsEdit = new Edit( this );
   this.entitlementsEdit.toolTip = "Optional comma-separated entitlements to embed in script signatures (leave blank for none).";

   var entitlementsRow = new HorizontalSizer;
   entitlementsRow.spacing = 6;
   entitlementsRow.add( makeRow( "Entitlements:" ) );
   entitlementsRow.add( this.entitlementsEdit, 100 );

   // ---- Log ----
   this.log = new TextBox( this );
   this.log.readOnly = true;
   this.log.setMinHeight( 220 );
   this.log.styleSheet = "font-family: monospace;";

   function log( text ) {
      self.log.text += text + "\n";
   }

   function currentKeysArgs() {
      var keysFile = self.keysEdit.text.trim();
      var password = self.passwordEdit.text;
      if ( keysFile.length == 0 )
         throw new Error( "Please select a signing keys (.xssk) file." );
      if ( !File.exists( keysFile ) )
         throw new Error( "Signing keys file not found: " + keysFile );
      if ( password.length == 0 )
         throw new Error( "Please enter the signing keys password." );
      return [ keysFile, password ];
   }

   function saveSettings() {
      Settings.write( SETTINGS_KEY + "/repoRoot", DataType_UCString, self.rootEdit.text );
      Settings.write( SETTINGS_KEY + "/keysFile", DataType_UCString, self.keysEdit.text );
   }

   // ---- Sign Scripts button ----
   this.signScriptsButton = new PushButton( this );
   this.signScriptsButton.text = "Sign Scripts (.js → .xsgn)";
   this.signScriptsButton.onClick = function () {
      try {
         saveSettings();
         var keysArgs = currentKeysArgs();
         var repoRoot = self.rootEdit.text.trim();
         var entitlements = self.entitlementsEdit.text.trim().length > 0
            ? self.entitlementsEdit.text.split( "," ).map( function( s ) { return s.trim(); } )
            : [];

         var scripts = findRootScripts( repoRoot );
         if ( scripts.length == 0 )
            throw new Error( "No .js scripts found in " + repoRoot );

         for ( var i = 0; i < scripts.length; ++i )
         {
            var scriptPath = scripts[i];
            var outputPath = File.changeExtension( scriptPath, ".xsgn" );
            Security.generateScriptSignatureFile( outputPath, scriptPath, entitlements, keysArgs[0], keysArgs[1] );
            log( "Signed: " + scriptPath + " -> " + outputPath );
         }
         log( "Done. Now run build-release.py to bundle the .xsgn files, then use \"Sign updates.xri\"." );
      } catch ( ex ) {
         log( "ERROR: " + ex.message );
      }
   };

   // ---- Sign updates.xri button ----
   this.signRepoButton = new PushButton( this );
   this.signRepoButton.text = "Sign updates.xri";
   this.signRepoButton.onClick = function () {
      try {
         saveSettings();
         var keysArgs = currentKeysArgs();
         var repoRoot = self.rootEdit.text.trim();
         var xriPath = repoRoot + "/release/updates.xri";
         if ( !File.exists( xriPath ) )
            throw new Error( "Not found: " + xriPath + " -- run build-release.py first." );

         Security.generateXMLSignature( xriPath, keysArgs[0], keysArgs[1] );
         log( "Signed: " + xriPath );
      } catch ( ex ) {
         log( "ERROR: " + ex.message );
      }
   };

   var buttonsRow = new HorizontalSizer;
   buttonsRow.spacing = 6;
   buttonsRow.addStretch();
   buttonsRow.add( this.signScriptsButton );
   buttonsRow.add( this.signRepoButton );

   this.closeButton = new PushButton( this );
   this.closeButton.text = "Close";
   this.closeButton.onClick = function () {
      self.ok();
   };

   var closeRow = new HorizontalSizer;
   closeRow.addStretch();
   closeRow.add( this.closeButton );

   this.sizer = new VerticalSizer;
   this.sizer.margin = 8;
   this.sizer.spacing = 6;
   this.sizer.add( rootRow );
   this.sizer.add( keysRow );
   this.sizer.add( passwordRow );
   this.sizer.add( entitlementsRow );
   this.sizer.add( buttonsRow );
   this.sizer.add( this.log, 100 );
   this.sizer.add( closeRow );
}
SignReleaseDialog.prototype = new Dialog;

function main() {
   var dialog = new SignReleaseDialog;
   dialog.execute();
}

main();
