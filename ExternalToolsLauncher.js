// ****************************************************************************
// ExternalToolsLauncher.js
// PixInsight JavaScript Runtime (PJSR) Script
// ****************************************************************************

#feature-id    Utilities > ExternalToolsLauncher

#feature-info  A dialog-based manager for configuring and launching external \
               programs from within PixInsight. Supports token substitution in \
               argument templates, FITS export of the active image, and live \
               capture of process stdout/stderr.

#feature-icon  @script_icons_dir/ExternalToolsLauncher.png

// --- Required PJSR header includes (defines constants used below) ---
#include <pjsr/DataType.jsh>      // DataType_UCString, DataType_Boolean, ...
#include <pjsr/TextAlign.jsh>     // TextAlign_Left, TextAlign_Right, TextAlign_VertCenter, ...
#include <pjsr/StdButton.jsh>     // StdButton_Ok, StdButton_Yes, StdButton_No, ...
#include <pjsr/StdIcon.jsh>       // StdIcon_Error, StdIcon_Warning, StdIcon_Question, ...
#include <pjsr/Sizer.jsh>         // HorizontalSizer, VerticalSizer
#include <pjsr/FrameStyle.jsh>    // FrameStyle_* (used by Frame widget)

"use strict";

// Self-executing closure — keeps all symbols out of the global namespace.
(function () {

// =============================================================================
// --- Constants ---
// =============================================================================

var SCRIPT_NAME    = "ExternalToolsLauncher";
var SCRIPT_VERSION = "1.0.0";
var SETTINGS_KEY   = "ExternalToolsLauncher"; // Namespace for Settings persistence
var DEFAULT_TIMEOUT_SEC = 60;                  // Default process timeout in seconds
var POLL_INTERVAL_MS    = 100;                 // ExternalProcess polling cadence

// =============================================================================
// --- Data Model ---
// =============================================================================

/**
 * ToolEntry — represents a single configured external tool.
 *
 * @param {String} name        Display label shown in the tool list.
 * @param {String} executable  Full filesystem path to the binary.
 * @param {String} args        Argument template; may contain substitution tokens:
 *                               {fits_path}      — temp FITS path of active image
 *                               {output_dir}     — directory of the active image file
 *                               {filename_noext} — filename of active image without extension
 * @param {String} workingDir  Optional working-directory override.
 * @param {String} description Optional tooltip / notes.
 */
function ToolEntry( name, executable, args, workingDir, description ) {
   this.name        = name        || "";
   this.executable  = executable  || "";
   this.arguments   = args        || "";
   this.workingDir  = workingDir  || "";
   this.description = description || "";
}

/** Return a shallow copy of this entry. */
ToolEntry.prototype.clone = function () {
   return new ToolEntry(
      this.name,
      this.executable,
      this.arguments,
      this.workingDir,
      this.description
   );
};

/** Serialize to a plain JS object suitable for JSON.stringify(). */
ToolEntry.prototype.toObject = function () {
   return {
      name        : this.name,
      executable  : this.executable,
      arguments   : this.arguments,
      workingDir  : this.workingDir,
      description : this.description
   };
};

/** Deserialize from a plain JS object produced by JSON.parse(). */
ToolEntry.fromObject = function ( obj ) {
   return new ToolEntry(
      obj.name        || "",
      obj.executable  || "",
      obj.arguments   || "",
      obj.workingDir  || "",
      obj.description || ""
   );
};

// =============================================================================
// --- Persistence ---
// =============================================================================

/**
 * Persist the tool array to PixInsight's Settings store.
 * @param {ToolEntry[]} tools
 */
function saveTools( tools ) {
   try {
      var payload = [];
      for ( var i = 0; i < tools.length; ++i )
         payload.push( tools[i].toObject() );

      Settings.write(
         SETTINGS_KEY + "/tools",
         DataType_UCString,
         JSON.stringify( payload )
      );
      Console.writeln( "<end><cbr>" + SCRIPT_NAME + ": Saved " + tools.length + " tool(s)." );
   } catch ( ex ) {
      Console.criticalln( SCRIPT_NAME + ": Failed to save settings — " + ex.message );
   }
}

/**
 * Load the tool array from PixInsight's Settings store.
 * Returns an empty array on failure or when no data exists.
 * @returns {ToolEntry[]}
 */
function loadTools() {
   try {
      var raw = Settings.read( SETTINGS_KEY + "/tools", DataType_UCString );
      if ( raw === undefined || raw === null || raw === "" )
         return [];

      var parsed = JSON.parse( raw );
      if ( !Array.isArray( parsed ) )
         return [];

      var tools = [];
      for ( var i = 0; i < parsed.length; ++i )
         tools.push( ToolEntry.fromObject( parsed[i] ) );

      Console.writeln( "<end><cbr>" + SCRIPT_NAME + ": Loaded " + tools.length + " tool(s)." );
      return tools;
   } catch ( ex ) {
      Console.criticalln( SCRIPT_NAME + ": Failed to load settings — " + ex.message );
      return [];
   }
}

// =============================================================================
// --- Token Substitution ---
// =============================================================================

/**
 * Replace all recognized tokens in an argument template string.
 *
 * @param  {String} template       Raw argument template.
 * @param  {String} fitsPath       Value to substitute for {fits_path}.
 * @param  {String} outputDir      Value to substitute for {output_dir}.
 * @param  {String} filenameNoext  Value to substitute for {filename_noext}.
 * @returns {String}               Argument string with tokens replaced.
 */
function substituteTokens( template, fitsPath, outputDir, filenameNoext ) {
   var result = template;
   result = result.replace( /\{fits_path\}/g,      fitsPath      || "" );
   result = result.replace( /\{output_dir\}/g,     outputDir     || "" );
   result = result.replace( /\{filename_noext\}/g, filenameNoext || "" );
   return result;
}

/**
 * Split a command-line argument string into an array of tokens, respecting
 * single- and double-quoted sub-strings (quotes are stripped).
 *
 * @param  {String}   argsString  Raw argument string.
 * @returns {String[]}            Individual argument tokens.
 */
function splitArguments( argsString ) {
   var args      = [];
   var current   = "";
   var inQuote   = false;
   var quoteChar = "";

   for ( var i = 0; i < argsString.length; ++i ) {
      var ch = argsString.charAt( i );

      if ( inQuote ) {
         if ( ch === quoteChar ) {
            inQuote = false; // closing quote — do NOT append it
         } else {
            current += ch;
         }
      } else if ( ch === '"' || ch === "'" ) {
         inQuote   = true;
         quoteChar = ch;   // opening quote — skip it
      } else if ( ch === " " || ch === "\t" ) {
         if ( current.length > 0 ) {
            args.push( current );
            current = "";
         }
      } else {
         current += ch;
      }
   }

   if ( current.length > 0 )
      args.push( current );

   return args;
}

/**
 * Normalize a filesystem path for PJSR:
 *   1. Strip surrounding quote characters (users often paste quoted paths on Windows).
 *   2. Replace all backslashes with forward slashes.
 * @param  {String} p  Raw path (may be quoted and/or contain backslashes).
 * @returns {String}   Clean path with only forward slashes.
 */
function normalizePath( p ) {
   var s = p.trim();
   // Strip a matching pair of surrounding double or single quotes.
   if ( ( s.charAt( 0 ) === '"'  && s.charAt( s.length - 1 ) === '"'  ) ||
        ( s.charAt( 0 ) === "'"  && s.charAt( s.length - 1 ) === "'"  ) ) {
      s = s.slice( 1, s.length - 1 );
   }
   return s.replace( /\\/g, "/" );
}

/**
 * Test whether a file exists.
 * @param  {String}  path  Normalized (forward-slash) path to test.
 * @returns {Boolean}
 */
function fileExists( path ) {
   return File.exists( path );
}

// =============================================================================
// --- FITS Export ---
// =============================================================================

/**
 * Export the main view of the active ImageWindow to a temporary FITS file.
 * Uses ImageWindow.saveAs() — PixInsight selects the FITS format automatically
 * from the .fits extension, with no dialog interaction.
 * Throws an Error with a descriptive message on any failure.
 *
 * @returns {String}  Absolute path to the written FITS file.
 */
function exportActiveImageToFits() {
   var win = ImageWindow.activeWindow;
   if ( win === null || win.isNull )
      throw new Error( "No active image window is open." );

   var tmpPath = File.systemTempDirectory +
                 "/" + SCRIPT_NAME + "_temp_export.fits";

   // saveAs( path, queryOptions, allowMessages, strict, verifyOverwrite )
   // All flags false: silent, no dialogs, overwrite the temp file if it exists.
   if ( !win.saveAs( tmpPath, false, false, false, false ) )
      throw new Error( "ImageWindow.saveAs() failed for path: " + tmpPath );

   Console.writeln( SCRIPT_NAME + ": Exported active image to FITS: " + tmpPath );
   return tmpPath;
}

// =============================================================================
// --- Add / Edit Sub-Dialog ---
// =============================================================================

/**
 * ToolEditDialog — modal child dialog for creating or modifying a ToolEntry.
 *
 * On successful execution (OK), `this.tool` contains the validated entry.
 *
 * @param {Dialog}    parent  Parent dialog (may be null).
 * @param {ToolEntry} tool    Existing entry to edit, or null to create a new one.
 */
function ToolEditDialog( parent, tool ) {
   this.__base__ = Dialog;
   this.__base__();

   var self = this;

   // Work on a clone so the caller's data is unchanged unless we commit.
   this.tool = tool ? tool.clone() : new ToolEntry( "", "", "{fits_path}", "{output_dir}", "" );

   this.windowTitle = tool ? "Edit Tool — " + SCRIPT_NAME
                           : "Add Tool — " + SCRIPT_NAME;
   this.minWidth  = 560;
   this.maxWidth  = 900;

   // ------------------------------------------------------------------
   // Helper: build a two-column form row (Label + control(s)).
   // ------------------------------------------------------------------
   function makeRow( labelText, labelWidth ) {
      var lbl = new Label( self );
      lbl.text          = labelText;
      lbl.textAlignment = TextAlign_Right | TextAlign_VertCenter;
      lbl.setFixedWidth( labelWidth || 120 );
      return lbl;
   }

   var LABEL_W = 120;

   // ---- Name ----
   var nameLabel   = makeRow( "Name:", LABEL_W );
   this.nameEdit   = new Edit( this );
   this.nameEdit.text    = this.tool.name;
   this.nameEdit.toolTip = "A short display label for the tool.";

   var nameRow = new HorizontalSizer;
   nameRow.spacing = 6;
   nameRow.add( nameLabel );
   nameRow.add( this.nameEdit, 100 );

   // ---- Executable ----
   var execLabel     = makeRow( "Executable:", LABEL_W );
   this.execEdit     = new Edit( this );
   this.execEdit.text    = this.tool.executable;
   this.execEdit.toolTip = "Full filesystem path to the binary or script to run.";

   this.browseExecButton           = new PushButton( this );
   this.browseExecButton.text      = "Browse\u2026";
   this.browseExecButton.toolTip   = "Open a file browser to locate the executable.";
   this.browseExecButton.onClick   = function () {
      var dlg                   = new OpenFileDialog;
      dlg.caption               = "Select Executable";
      dlg.multipleSelections    = false;
      // Platform-appropriate executable filters
      dlg.filters = [
         [ "Executables (*.exe *.bat *.cmd *.sh *.py *.rb *.pl)", "*.exe", "*.bat",
           "*.cmd", "*.sh", "*.py", "*.rb", "*.pl" ],
         [ "All Files (*.*)", "*.*" ]
      ];
      if ( dlg.execute() )
         self.execEdit.text = dlg.fileName;
   };

   var execRow = new HorizontalSizer;
   execRow.spacing = 6;
   execRow.add( execLabel );
   execRow.add( this.execEdit, 100 );
   execRow.add( this.browseExecButton );

   // ---- Arguments ----
   var argsLabel   = makeRow( "Arguments:", LABEL_W );
   this.argsEdit   = new Edit( this );
   this.argsEdit.text    = this.tool.arguments;
   this.argsEdit.toolTip =
      "Argument template string. Supported substitution tokens:\n" +
      "  {fits_path}       Path to the temporary FITS file of the active image.\n" +
      "  {output_dir}      Directory containing the active image file.\n" +
      "  {filename_noext}  Filename of the active image, without its extension.\n\n" +
      "Quote arguments that may contain spaces (e.g. \"{fits_path}\").";

   var argsRow = new HorizontalSizer;
   argsRow.spacing = 6;
   argsRow.add( argsLabel );
   argsRow.add( this.argsEdit, 100 );

   // Token quick-reference hint
   var tokenHint           = new Label( this );
   tokenHint.text          = "Available tokens:  {fits_path}   {output_dir}   {filename_noext}";
   tokenHint.textAlignment = TextAlign_Left | TextAlign_VertCenter;
   tokenHint.styleSheet    = "color: gray; font-style: italic;";

   var tokenRow = new HorizontalSizer;
   tokenRow.addSpacing( LABEL_W + 6 );
   tokenRow.add( tokenHint );

   // ---- Working Directory ----
   var wdirLabel     = makeRow( "Working Dir:", LABEL_W );
   this.wdirEdit     = new Edit( this );
   this.wdirEdit.text    = this.tool.workingDir;
   this.wdirEdit.toolTip =
      "Optional working directory for the process.\n" +
      "Leave blank to use the directory that contains the executable.";

   this.browseWdirButton           = new PushButton( this );
   this.browseWdirButton.text      = "Browse\u2026";
   this.browseWdirButton.toolTip   = "Open a directory browser to select the working directory.";
   this.browseWdirButton.onClick   = function () {
      // GetDirectoryDialog is available in PixInsight 1.8.5+
      var dlg     = new GetDirectoryDialog;
      dlg.caption = "Select Working Directory";
      if ( dlg.execute() )
         self.wdirEdit.text = dlg.directory;
   };

   var wdirRow = new HorizontalSizer;
   wdirRow.spacing = 6;
   wdirRow.add( wdirLabel );
   wdirRow.add( this.wdirEdit, 100 );
   wdirRow.add( this.browseWdirButton );

   // ---- Description ----
   var descLabel   = makeRow( "Description:", LABEL_W );
   this.descEdit   = new Edit( this );
   this.descEdit.text    = this.tool.description;
   this.descEdit.toolTip = "Optional notes or tooltip text for this tool.";

   var descRow = new HorizontalSizer;
   descRow.spacing = 6;
   descRow.add( descLabel );
   descRow.add( this.descEdit, 100 );

   // ---- Separator ----
   var sep       = new Frame( this );
   sep.minHeight = 1;
   sep.maxHeight = 1;
   sep.styleSheet = "background: #888;";

   // ---- OK / Cancel ----
   this.okButton               = new PushButton( this );
   this.okButton.text          = "OK";
   this.okButton.icon          = this.scaledResource( ":/icons/ok.png" );
   this.okButton.defaultButton = true;
   this.okButton.onClick       = function () {
      var name = self.nameEdit.text.trim();
      var exec = self.execEdit.text.trim();

      if ( name === "" ) {
         ( new MessageBox(
            "Tool name cannot be empty.\nPlease enter a display name.",
            SCRIPT_NAME, StdIcon_Error, StdButton_Ok
         ) ).execute();
         self.nameEdit.focus();
         return;
      }
      if ( exec === "" ) {
         ( new MessageBox(
            "Executable path cannot be empty.\nPlease enter or browse for the binary path.",
            SCRIPT_NAME, StdIcon_Error, StdButton_Ok
         ) ).execute();
         self.execEdit.focus();
         return;
      }

      self.tool.name        = name;
      self.tool.executable  = exec;
      self.tool.arguments   = self.argsEdit.text;
      self.tool.workingDir  = self.wdirEdit.text.trim();
      self.tool.description = self.descEdit.text;

      self.ok();
   };

   this.cancelButton           = new PushButton( this );
   this.cancelButton.text      = "Cancel";
   this.cancelButton.icon      = this.scaledResource( ":/icons/cancel.png" );
   this.cancelButton.onClick   = function () { self.cancel(); };

   var buttonRow = new HorizontalSizer;
   buttonRow.spacing = 6;
   buttonRow.addStretch();
   buttonRow.add( this.okButton );
   buttonRow.add( this.cancelButton );

   // ---- Layout ----
   this.sizer         = new VerticalSizer;
   this.sizer.margin  = 10;
   this.sizer.spacing = 7;
   this.sizer.add( nameRow );
   this.sizer.add( execRow );
   this.sizer.add( argsRow );
   this.sizer.add( tokenRow );
   this.sizer.add( wdirRow );
   this.sizer.add( descRow );
   this.sizer.addSpacing( 4 );
   this.sizer.add( sep );
   this.sizer.addSpacing( 2 );
   this.sizer.add( buttonRow );

   this.adjustToContents();
}

ToolEditDialog.prototype = new Dialog;

// =============================================================================
// --- Main Dialog ---
// =============================================================================

/**
 * ExternalToolsLauncherDialog — the primary UI for managing and launching tools.
 */
function ExternalToolsLauncherDialog() {
   this.__base__ = Dialog;
   this.__base__();

   var self = this;

   // Load persisted tools on open.
   this.tools = loadTools();

   this.windowTitle = SCRIPT_NAME + "  v" + SCRIPT_VERSION;
   this.minWidth    = 740;
   this.minHeight   = 560;

   // ------------------------------------------------------------------
   // Title / description bar
   // ------------------------------------------------------------------
   var titleLabel            = new Label( this );
   titleLabel.useRichText    = true;
   titleLabel.text           =
      "<b>" + SCRIPT_NAME + "</b> &mdash; " +
      "Manage and launch configurable external programs from within PixInsight.";
   titleLabel.textAlignment  = TextAlign_Left | TextAlign_VertCenter;

   // ------------------------------------------------------------------
   // TreeBox — tool list
   // ------------------------------------------------------------------
   this.toolsTree                    = new TreeBox( this );
   this.toolsTree.alternateRowColor  = true;
   this.toolsTree.numberOfColumns    = 3;
   this.toolsTree.headerVisible      = true;
   this.toolsTree.rootDecoration     = false;
   this.toolsTree.multipleSelection  = false;
   this.toolsTree.minHeight          = 200;
   this.toolsTree.toolTip            = "Double-click a row to edit the tool.";

   this.toolsTree.setHeaderText( 0, "Name" );
   this.toolsTree.setHeaderText( 1, "Executable" );
   this.toolsTree.setHeaderText( 2, "Arguments" );

   this.toolsTree.setColumnWidth( 0, 160 );
   this.toolsTree.setColumnWidth( 1, 260 );
   this.toolsTree.setColumnWidth( 2, 260 );

   this.toolsTree.onCurrentNodeUpdated = function ( node ) {
      self.updateButtonStates();
   };

   this.toolsTree.onNodeDoubleClicked = function ( node, col ) {
      self.onEditTool();
   };

   // ------------------------------------------------------------------
   // Tool-management sidebar buttons
   // ------------------------------------------------------------------
   function makeToolButton( label, iconRes, tip, handler ) {
      var btn       = new PushButton( self );
      btn.text      = label;
      btn.toolTip   = tip;
      btn.onClick   = handler;
      try { btn.icon = self.scaledResource( iconRes ); } catch ( _ ) {}
      return btn;
   }

   this.addButton    = makeToolButton( "Add",       ":/icons/add.png",
      "Add a new external tool to the list.",
      function () { self.onAddTool(); } );

   this.editButton   = makeToolButton( "Edit",      ":/icons/edit.png",
      "Edit the selected tool.",
      function () { self.onEditTool(); } );

   this.removeButton = makeToolButton( "Remove",    ":/icons/remove.png",
      "Remove the selected tool from the list.",
      function () { self.onRemoveTool(); } );

   this.moveUpButton = makeToolButton( "Move Up",   ":/icons/up.png",
      "Move the selected tool one position up.",
      function () { self.onMoveUp(); } );

   this.moveDownButton = makeToolButton( "Move Down", ":/icons/down.png",
      "Move the selected tool one position down.",
      function () { self.onMoveDown(); } );

   var sidebarSizer = new VerticalSizer;
   sidebarSizer.spacing = 4;
   sidebarSizer.add( this.addButton );
   sidebarSizer.add( this.editButton );
   sidebarSizer.add( this.removeButton );
   sidebarSizer.addSpacing( 8 );
   sidebarSizer.add( this.moveUpButton );
   sidebarSizer.add( this.moveDownButton );
   sidebarSizer.addStretch();

   var treeSection = new HorizontalSizer;
   treeSection.spacing = 6;
   treeSection.add( this.toolsTree, 100 );
   treeSection.add( sidebarSizer );

   // ------------------------------------------------------------------
   // Launch options row (timeout only — FITS export is inferred from args)
   // ------------------------------------------------------------------
   var timeoutLabel            = new Label( this );
   timeoutLabel.text           = "Timeout (s):";
   timeoutLabel.textAlignment  = TextAlign_Right | TextAlign_VertCenter;

   this.timeoutSpinBox         = new SpinBox( this );
   this.timeoutSpinBox.minimum = 1;
   this.timeoutSpinBox.maximum = 3600;
   this.timeoutSpinBox.value   = DEFAULT_TIMEOUT_SEC;
   this.timeoutSpinBox.toolTip =
      "Maximum number of seconds to wait for the launched process to finish.\n" +
      "The process is forcibly terminated if this limit is exceeded.";

   var optionsRow = new HorizontalSizer;
   optionsRow.spacing = 8;
   optionsRow.addStretch();
   optionsRow.add( timeoutLabel );
   optionsRow.add( this.timeoutSpinBox );

   // ------------------------------------------------------------------
   // Launch button
   // ------------------------------------------------------------------
   this.launchButton           = new PushButton( this );
   this.launchButton.text      = "  Launch Selected Tool";
   this.launchButton.toolTip   = "Run the selected tool with the configured arguments.";
   this.launchButton.enabled   = false;
   try { this.launchButton.icon = this.scaledResource( ":/icons/power.png" ); } catch ( _ ) {}
   this.launchButton.onClick   = function () { self.onLaunch(); };

   var launchRow = new HorizontalSizer;
   launchRow.add( this.launchButton );
   launchRow.addStretch();

   // ------------------------------------------------------------------
   // Console output area
   // ------------------------------------------------------------------
   var consoleLabel            = new Label( this );
   consoleLabel.text           = "Process Output:";
   consoleLabel.textAlignment  = TextAlign_Left | TextAlign_VertCenter;

   this.consoleTextBox             = new TextBox( this );
   this.consoleTextBox.readOnly    = true;
   this.consoleTextBox.minHeight   = 160;
   this.consoleTextBox.styleSheet  =
      "font-family: 'Courier New', Courier, monospace; font-size: 9pt;";
   this.consoleTextBox.toolTip     =
      "Captured stdout and stderr from the most recently launched process.";

   this.clearConsoleButton         = new PushButton( this );
   this.clearConsoleButton.text    = "Clear";
   this.clearConsoleButton.toolTip = "Clear the output area.";
   this.clearConsoleButton.onClick = function () {
      self.consoleTextBox.text = "";
   };

   var consoleTitleRow = new HorizontalSizer;
   consoleTitleRow.add( consoleLabel );
   consoleTitleRow.addStretch();
   consoleTitleRow.add( this.clearConsoleButton );

   // ------------------------------------------------------------------
   // Separator
   // ------------------------------------------------------------------
   var sep       = new Frame( this );
   sep.minHeight = 1;
   sep.maxHeight = 1;
   sep.styleSheet = "background: #888;";

   // ------------------------------------------------------------------
   // Bottom row: Reset | --- | OK | Cancel
   // ------------------------------------------------------------------
   this.okButton               = new PushButton( this );
   this.okButton.text          = "OK";
   this.okButton.defaultButton = true;
   this.okButton.toolTip       = "Save the tool list and close the dialog.";
   try { this.okButton.icon = this.scaledResource( ":/icons/ok.png" ); } catch ( _ ) {}
   this.okButton.onClick       = function () {
      saveTools( self.tools );
      self.ok();
   };

   this.cancelButton           = new PushButton( this );
   this.cancelButton.text      = "Cancel";
   this.cancelButton.toolTip   = "Close without saving any changes.";
   try { this.cancelButton.icon = this.scaledResource( ":/icons/cancel.png" ); } catch ( _ ) {}
   this.cancelButton.onClick   = function () { self.cancel(); };

   this.resetButton            = new PushButton( this );
   this.resetButton.text       = "Reset";
   this.resetButton.toolTip    = "Remove all tools from the list and clear persisted settings.";
   try { this.resetButton.icon = this.scaledResource( ":/icons/reload.png" ); } catch ( _ ) {}
   this.resetButton.onClick    = function () {
      var mb = new MessageBox(
         "Remove <b>all</b> tools from the list?<br/>" +
         "This cannot be undone within the current session.",
         SCRIPT_NAME,
         StdIcon_Question,
         StdButton_Yes,
         StdButton_No
      );
      if ( mb.execute() === StdButton_Yes ) {
         self.tools = [];
         self.rebuildTree();
         self.updateButtonStates();
         saveTools( self.tools );
      }
   };

   var bottomRow = new HorizontalSizer;
   bottomRow.spacing = 6;
   bottomRow.add( this.resetButton );
   bottomRow.addStretch();
   bottomRow.add( this.okButton );
   bottomRow.add( this.cancelButton );

   // ------------------------------------------------------------------
   // Root layout
   // ------------------------------------------------------------------
   this.sizer         = new VerticalSizer;
   this.sizer.margin  = 10;
   this.sizer.spacing = 8;
   this.sizer.add( titleLabel );
   this.sizer.addSpacing( 2 );
   this.sizer.add( treeSection, 50 );
   this.sizer.add( optionsRow );
   this.sizer.add( launchRow );
   this.sizer.add( consoleTitleRow );
   this.sizer.add( this.consoleTextBox, 50 );
   this.sizer.addSpacing( 2 );
   this.sizer.add( sep );
   this.sizer.add( bottomRow );

   // Populate the tree and sync button states.
   this.rebuildTree();
   this.updateButtonStates();

   this.adjustToContents();
}

ExternalToolsLauncherDialog.prototype = new Dialog;

// =============================================================================
// --- Main Dialog: Tree Helpers ---
// =============================================================================

/**
 * Rebuild the TreeBox from scratch using this.tools.
 * Attempts to preserve the current selection index.
 */
ExternalToolsLauncherDialog.prototype.rebuildTree = function () {
   var prevIdx = this.selectedIndex();
   this.toolsTree.clear();

   for ( var i = 0; i < this.tools.length; ++i ) {
      var t    = this.tools[i];
      var node = new TreeBoxNode( this.toolsTree );
      node.setText( 0, t.name );
      node.setText( 1, t.executable );
      node.setText( 2, t.arguments );
      if ( t.description )
         node.setToolTip( 0, t.description );
      node.selectable = true;
   }

   if ( this.tools.length > 0 ) {
      var selectIdx = ( prevIdx >= 0 )
                      ? Math.min( prevIdx, this.tools.length - 1 )
                      : 0;
      this.toolsTree.currentNode = this.toolsTree.child( selectIdx );
   }
};

/**
 * Return the 0-based index of the currently highlighted TreeBox node,
 * or -1 if nothing is selected.
 */
ExternalToolsLauncherDialog.prototype.selectedIndex = function () {
   var node = this.toolsTree.currentNode;
   if ( node === null ) return -1;
   for ( var i = 0; i < this.toolsTree.numberOfChildren; ++i ) {
      if ( this.toolsTree.child( i ) === node ) return i;
   }
   return -1;
};

/**
 * Sync the enabled/disabled state of all action buttons with the
 * current selection and list contents.
 */
ExternalToolsLauncherDialog.prototype.updateButtonStates = function () {
   var idx          = this.selectedIndex();
   var hasSel       = idx >= 0;
   var notFirst     = hasSel && idx > 0;
   var notLast      = hasSel && idx < this.tools.length - 1;

   this.editButton.enabled      = hasSel;
   this.removeButton.enabled    = hasSel;
   this.moveUpButton.enabled    = notFirst;
   this.moveDownButton.enabled  = notLast;
   this.launchButton.enabled    = hasSel;
};

// =============================================================================
// --- Main Dialog: Tool-Management Actions ---
// =============================================================================

/** Open the Add dialog and, on confirmation, append the new entry. */
ExternalToolsLauncherDialog.prototype.onAddTool = function () {
   var dlg = new ToolEditDialog( this, null );
   if ( dlg.execute() ) {
      this.tools.push( dlg.tool );
      this.rebuildTree();
      this.toolsTree.currentNode = this.toolsTree.child( this.tools.length - 1 );
      this.updateButtonStates();
   }
};

/** Open the Edit dialog for the selected entry and, on confirmation, update it. */
ExternalToolsLauncherDialog.prototype.onEditTool = function () {
   var idx = this.selectedIndex();
   if ( idx < 0 ) return;

   var dlg = new ToolEditDialog( this, this.tools[idx] );
   if ( dlg.execute() ) {
      this.tools[idx] = dlg.tool;
      this.rebuildTree();
      this.toolsTree.currentNode = this.toolsTree.child( idx );
      this.updateButtonStates();
   }
};

/** Confirm and remove the selected entry. */
ExternalToolsLauncherDialog.prototype.onRemoveTool = function () {
   var idx = this.selectedIndex();
   if ( idx < 0 ) return;

   var mb = new MessageBox(
      "Remove tool <b>'" + this.tools[idx].name + "'</b>?",
      SCRIPT_NAME,
      StdIcon_Question,
      StdButton_Yes,
      StdButton_No
   );
   if ( mb.execute() === StdButton_Yes ) {
      this.tools.splice( idx, 1 );
      this.rebuildTree();
      this.updateButtonStates();
   }
};

/** Swap the selected entry with the one above it. */
ExternalToolsLauncherDialog.prototype.onMoveUp = function () {
   var idx = this.selectedIndex();
   if ( idx <= 0 ) return;

   var tmp              = this.tools[idx];
   this.tools[idx]      = this.tools[idx - 1];
   this.tools[idx - 1]  = tmp;

   this.rebuildTree();
   this.toolsTree.currentNode = this.toolsTree.child( idx - 1 );
   this.updateButtonStates();
};

/** Swap the selected entry with the one below it. */
ExternalToolsLauncherDialog.prototype.onMoveDown = function () {
   var idx = this.selectedIndex();
   if ( idx < 0 || idx >= this.tools.length - 1 ) return;

   var tmp              = this.tools[idx];
   this.tools[idx]      = this.tools[idx + 1];
   this.tools[idx + 1]  = tmp;

   this.rebuildTree();
   this.toolsTree.currentNode = this.toolsTree.child( idx + 1 );
   this.updateButtonStates();
};

// =============================================================================
// --- Main Dialog: Launch Action ---
// =============================================================================

/**
 * Build the token values, optionally export a temp FITS, validate the
 * executable, then run it via ExternalProcess with a synchronous poll loop.
 */
ExternalToolsLauncherDialog.prototype.onLaunch = function () {
   var self = this;
   var idx  = this.selectedIndex();
   if ( idx < 0 ) return;

   var tool = this.tools[idx];

   // ---- Gather token values from the active ImageWindow ----
   var fitsPath      = "";
   var outputDir     = "";
   var filenameNoext = "";

   var win = ImageWindow.activeWindow;
   if ( !win.isNull ) {
      var fp = win.filePath;
      if ( fp && fp !== "" ) {
         outputDir     = normalizePath( File.extractDrive( fp ) + File.extractDirectory( fp ) );
         filenameNoext = File.extractName( fp );
      }
   }

   // ---- FITS export: inferred automatically when {fits_path} appears in args ----
   if ( tool.arguments.indexOf( "{fits_path}" ) >= 0 ) {
      if ( win.isNull ) {
         ( new MessageBox(
            "The argument template uses <b>{fits_path}</b>, " +
            "but there is no active image window open.",
            SCRIPT_NAME, StdIcon_Warning, StdButton_Ok
         ) ).execute();
         return;
      }
      try {
         fitsPath = exportActiveImageToFits();
      } catch ( ex ) {
         ( new MessageBox(
            "Failed to export the active image to FITS:\n\n" + ex.message,
            SCRIPT_NAME, StdIcon_Error, StdButton_Ok
         ) ).execute();
         return;
      }
   }

   // ---- Normalize all paths to forward slashes (PJSR requirement on Windows) ----
   var exePath  = normalizePath( tool.executable );
   var wdirPath = normalizePath( tool.workingDir );

   // ---- Validate executable ----
   if ( !fileExists( exePath ) ) {
      ( new MessageBox(
         "The executable was not found at the specified path:\n\n" +
         exePath + "\n\n" +
         "Please edit the tool and verify the path.",
         SCRIPT_NAME, StdIcon_Error, StdButton_Ok
      ) ).execute();
      return;
   }

   // ---- Resolve tokens in arguments and working directory ----
   var resolvedArgs = substituteTokens(
      tool.arguments, fitsPath, outputDir, filenameNoext
   );
   var resolvedWdir = substituteTokens(
      wdirPath, fitsPath, outputDir, filenameNoext
   );
   // If the working dir still contains an unresolved token (e.g. {output_dir}
   // when no image file is saved to disk yet), clear it so the process falls
   // back to the executable's own directory rather than receiving a bad path.
   if ( resolvedWdir.indexOf( "{" ) >= 0 )
      resolvedWdir = "";

   var argList = splitArguments( resolvedArgs );

   Console.writeln( "<end><cbr><b>" + SCRIPT_NAME + "</b>: Launching — " + tool.name );
   Console.writeln( "  Executable : " + exePath );
   Console.writeln( "  Arguments  : " + resolvedArgs );
   if ( resolvedWdir )
      Console.writeln( "  Working Dir: " + resolvedWdir );

   // ---- Set up process ----
   this.consoleTextBox.text = "";
   this.appendConsole( "[ Launching: " + tool.name + " ]\n" );
   this.appendConsole( "  " + exePath + " " + resolvedArgs + "\n\n" );

   var proc = new ExternalProcess;

   // Determine working directory: explicit override, else exe's own directory.
   if ( resolvedWdir !== "" ) {
      proc.workingDirectory = resolvedWdir;
   } else {
      var exeDir = File.extractDrive( exePath ) +
                   File.extractDirectory( exePath );
      if ( exeDir && exeDir !== "" )
         proc.workingDirectory = exeDir;
   }

   // ---- Start ----
   try {
      proc.start( exePath, argList );
   } catch ( ex ) {
      this.appendConsole( "[ERROR] Could not start process:\n" + ex.message + "\n" );
      Console.criticalln( SCRIPT_NAME + ": Could not start process — " + ex.message );
      ( new MessageBox(
         "Could not start the process:\n\n" + ex.message,
         SCRIPT_NAME, StdIcon_Error, StdButton_Ok
      ) ).execute();
      return;
   }

   // ---- Poll loop — keeps the UI responsive ----
   var timeoutMs = this.timeoutSpinBox.value * 1000;
   var elapsed   = 0;
   var timedOut  = false;

   while ( proc.isRunning ) {
      msleep( POLL_INTERVAL_MS );
      elapsed += POLL_INTERVAL_MS;
      processEvents(); // yield to the UI event loop

      if ( elapsed >= timeoutMs ) {
         timedOut = true;
         break;
      }
   }

   if ( timedOut ) {
      try { proc.terminate(); } catch ( _ ) {}
      var timeoutMsg =
         "[TIMEOUT] Process exceeded " + this.timeoutSpinBox.value +
         " second(s) and was forcibly terminated.\n";
      this.appendConsole( timeoutMsg );
      Console.warningln( SCRIPT_NAME + ": " + timeoutMsg.trim() );
   } else {
      // Give the process a moment to flush its buffers, then wait for clean exit.
      try { proc.waitForFinished( 5000 ); } catch ( _ ) {}
   }

   // ---- Capture output ----
   // readAllStandardOutput() / readAllStandardError() return ByteArray objects;
   // call toString() to obtain a UTF-8 string.
   var stdoutRaw = "";
   var stderrRaw = "";
   try {
      var outBytes = proc.readAllStandardOutput();
      if ( outBytes && outBytes.length > 0 )
         stdoutRaw = outBytes.toString( "UTF-8" );
   } catch ( _ ) {}
   try {
      var errBytes = proc.readAllStandardError();
      if ( errBytes && errBytes.length > 0 )
         stderrRaw = errBytes.toString( "UTF-8" );
   } catch ( _ ) {}

   var exitCode = -1;
   try { exitCode = proc.exitCode; } catch ( _ ) {}

   // ---- Display in console TextBox ----
   if ( stdoutRaw.length > 0 )
      this.appendConsole( "[stdout]\n" + stdoutRaw + "\n" );
   if ( stderrRaw.length > 0 )
      this.appendConsole( "[stderr]\n" + stderrRaw + "\n" );
   this.appendConsole( "[ Process exited with code: " + exitCode + " ]\n" );

   Console.writeln(
      SCRIPT_NAME + ": Process '" + tool.name + "' finished — exit code " + exitCode
   );
};

/**
 * Append text to the console TextBox.
 * @param {String} text
 */
ExternalToolsLauncherDialog.prototype.appendConsole = function ( text ) {
   this.consoleTextBox.text += text;
};

// =============================================================================
// --- Entry Point ---
// =============================================================================

function main() {
   Console.show();
   Console.writeln(
      "<end><cbr><b>" + SCRIPT_NAME + " v" + SCRIPT_VERSION + "</b><br/>" +
      "PixInsight External Tools Launcher — ready."
   );

   var dlg = new ExternalToolsLauncherDialog();
   dlg.execute();
}

main();

})(); // end self-executing closure

// ****************************************************************************
// End of ExternalToolsLauncher.js
// ****************************************************************************
