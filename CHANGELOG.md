# Changelog

All notable changes to the Skylit.DEV I/O extension will be documented in this file.

## [1.9.3] - 2026-01-29

### Fixed
- **🐛 Critical: Request file deletion**: Fixed infinite retry loop bug
  - Request file now ALWAYS deleted via `finally` block, even on errors
  - Prevents infinite "slug already exists" errors
  - Added fallback to fs.unlink if VS Code API fails on SSH
  - Delete happens after both success and failure cases

## [1.9.2] - 2026-01-29

### Fixed
- **🔄 Continuous Polling**: Polling now runs continuously instead of stopping after first request
  - Extension polls every 2 seconds for create-post-request.json
  - Processes file when found, then continues polling for next request
  - Works for multiple AI post creation requests without restart

## [1.9.1] - 2026-01-29

### Fixed
- **🔄 SSH Polling Fallback**: Added polling mechanism for create-post-request.json on SSH/remote filesystems
  - File watchers (chokidar) don't always work reliably over SSH
  - Extension now polls every 2 seconds for request file in addition to watching
  - Ensures AI post creation workflow works on remote servers
  - Polling interval stops after request is processed

## [1.7.0] - 2026-01-29

### Added
- **🎯 Cursor Sync**: IDE cursor position now syncs with Gutenberg block selection
  - Move your cursor in the IDE, Gutenberg automatically selects and scrolls to the corresponding block
  - Uses existing polling mechanism (zero additional HTTP requests)
  - 200ms debounce for smooth performance
  - Reads existing `.skylit/metadata/*.json` files to map line numbers to blocks
  - Writes cursor position to `.skylit/active-block.txt` for WordPress to read
  - Can be disabled via `skylit.cursorTracking` setting (default: true)

### Fixed
- **📊 Jump to Line accuracy**: Line metadata now updates immediately after IDE saves
  - Previously, line numbers were incorrect until a second save occurred
  - Now scans HTML and updates line metadata right after import
  - "Jump to Line" feature works correctly on first click

### Technical Details
- Extension: Added `startCursorTracking()`, `handleCursorChange()`, `processCursorPosition()`, `findBlockForLine()` in fileWatcher
- PHP: Enhanced `rest_check_file_changes()` to include `cursor_block_id` in poll response
- Gutenberg: Added `syncCursorBlockSelection()` to handle cursor sync and scroll behavior
- Preserves block selection after `resetBlocks()` when importing changes
- Reuses existing infrastructure (no new endpoints, piggybacks on 1s polling)

---

## [1.4.12] - 2026-01-25

### Fixed
- **🔄 Robust rename detection**: Handles both event orderings when WordPress renames a folder
- VS Code may fire events as CREATE→DELETE or DELETE→CREATE depending on timing
- Now correctly detects renames in **both** directions:
  - DELETE first → track it, if CREATE follows for same post ID → rename
  - CREATE first → delay restore for 1 second, if DELETE follows → rename (cancel restore)
- Eliminates spurious "restore" API calls when WordPress changes slugs

### Technical Details
- Added `pendingRestoreTimers` map to delay restore actions
- If DELETE arrives within 1 second of CREATE, the pending restore is cancelled
- Logs now show: `🔄 RENAME detected (CREATE→DELETE)` or `🔄 RENAME detected (DELETE→CREATE)`

---

## [1.4.11] - 2026-01-25

### Fixed
- **🔄 Server-side rename detection**: Now correctly detects when WordPress renames a folder
- Previously, when WordPress renamed a folder (slug change), the IDE saw DELETE + CREATE events and mistakenly sent a "restore" API call
- Added `recentFolderDeletes` tracking to detect this pattern and skip unnecessary API calls
- Logs now show: `🔄 Server-side RENAME detected: old-slug_X → new-slug_X`

### Technical Details
- When a folder is deleted outside trash, we track it for 5 seconds
- If a CREATE event with the same post ID follows within that window, it's a rename not a restore
- This prevents the IDE from sending spurious restore actions when WordPress changes slugs

---

## [1.4.10] - 2026-01-25

### Fixed
- **🔧 SSH URI scheme fix**: `pathToUri()` now correctly uses workspace folder's URI scheme
- Fixed `vscode.Uri.file()` creating local URIs instead of remote URIs for SSH paths
- Added detailed debug logging to trace new folder detection flow
- Fixed trailing slash in devFolder causing path matching issues

### Technical Details
- New `pathToUri()` function detects workspace URI scheme and constructs proper URIs
- For SSH workspaces, uses `wsUri.with({ path: normalizedPath })` instead of `Uri.file()`
- Added diagnostic logs in `handlePotentialNewFolder` and `createPostFromNewFolder`

---

## [1.4.9] - 2026-01-25

### Changed
- **🔄 Complete VS Code FS API migration**: All file operations now use VS Code's workspace.fs API
- **📂 Folder renaming**: `renamePostFiles()` now uses `vsRename()` instead of `fs.renameSync()`
- **📝 Metadata operations**: All JSON file read/write uses VS Code FS API
- **🔍 New folder watcher**: Uses VS Code's FileSystemWatcher instead of chokidar
- **📊 Directory scanning**: `scanForNewFolders()` uses `vsReadDir()` instead of `fs.readdirSync()`

### Added
- **Helper functions for VS Code FS API**:
  - `vsExists()` - Check if file/folder exists
  - `vsReadDir()` - List directory contents
  - `vsReadFile()` - Read file content
  - `vsWriteFile()` - Write file content
  - `vsRename()` - Rename file/folder

### Technical Details
- All operations that modify files now use VS Code's virtual filesystem layer
- This ensures proper rename/update behavior on SSH (not creating new files)
- File sync, metadata updates, folder renames all SSH-compatible
- Path handling uses `posixJoin()` consistently for cross-platform compatibility

### Impact
- ✅ Slug renaming works on SSH (folder + files renamed, not duplicated)
- ✅ New folder creation from IDE works on SSH
- ✅ Metadata JSON updates work on SSH
- ✅ File sync reads work on SSH
- ✅ All operations work identically on local and remote environments

---

## [1.4.8] - 2026-01-25

### Changed
- **🔄 VS Code native FileSystemWatcher**: Replaced chokidar for trash/restore operations with VS Code's native API
- **📡 SSH compatibility**: VS Code's FileSystemWatcher properly handles SSH remotes through its virtual filesystem layer
- **🎯 Better detection patterns**: Watches for files/folders with `_ID` suffix or in `_trash` directories

### Technical Details
- **Root cause**: Chokidar runs on the host machine and can't properly access SSH virtual filesystem
- **Solution**: Use `vscode.workspace.createFileSystemWatcher()` which integrates with VS Code's remote filesystem layer
- VS Code watcher uses RelativePattern with `post-types/**/*` glob
- Both `onDidCreate` and `onDidDelete` events are monitored for trash/restore detection
- Path patterns checked: contains `_trash`, ends with `_ID`, or contains `_ID/`

### Impact
- Trash detection on SSH: Should now receive proper file paths instead of malformed `\` or `/`
- Restore detection on SSH: Now uses VS Code's event system which understands remote URIs

---

## [1.4.7] - 2026-01-25

### Fixed
- **🗑️ Trash watcher path resolution**: Changed from watching entire dev folder to specific post-types paths
- **📂 Improved watch patterns**: Now watches `post-types/**/_trash/**` and `post-types/**/pages/*` specifically
- **🐛 SSH chokidar compatibility**: Fixed malformed paths (`\` or `/`) by targeting specific folders

### Technical Details
- **Root cause**: Watching entire dev folder on SSH caused chokidar to report relative paths incorrectly
- **Solution**: Watch specific glob patterns for trash and page folders instead of entire tree
- Patterns: `post-types/**/_trash/**`, `post-types/**/pages/*`, `post-types/**/posts/*`
- This gives chokidar explicit paths to monitor, avoiding root-level confusion

---

## [1.4.6] - 2026-01-25

### Fixed
- **🔧 SSH watcher initialization**: Watchers now start even when `fs` operations fail on SSH
- **📂 Folder detection fallback**: Extension attempts to watch folders even if `fs.existsSync()` fails
- **🔍 Better error handling**: Wrapped `fs` operations in try-catch for SSH compatibility

### Technical Details
- **Root cause**: Node's `fs` module (existsSync, readdirSync) can't access SSH remote paths, but Chokidar can
- **Solution**: Made folder existence checks non-blocking - watchers start anyway even if `fs` fails
- Wrapped `scanForNewFolders()` and `loadMetadataCache()` in try-catch (use `fs`, expected to fail on SSH)
- Chokidar watchers now initialize regardless of `fs` check results

### Impact
- Trash watcher: Already worked (uses chokidar) ✅
- Post-types watcher: Now starts on SSH ✅  
- Metadata watcher: Now starts on SSH ✅
- All watchers work because chokidar integrates with VS Code's virtual filesystem

---

## [1.4.5] - 2026-01-25

### Fixed
- **🐛 CRITICAL: SSH path joining bug**: Fixed Windows `path.join()` breaking SSH remote paths
- **📂 Post-types and metadata folder detection**: Folders now properly detected on SSH connections
- **🗑️ Trash/restore functionality**: Should now work correctly on SSH (dependent on folder detection fix)

### Technical Details
- **Root cause**: Node's `path.join()` uses OS-specific separators. On Windows, it converts `/home/user/` to `\home\user\` which becomes `C:\home\user\` (invalid SSH path)
- **Solution**: Created `posixJoin()` helper that always uses forward slashes for SSH paths
- Replaced all `path.join(devFolder, ...)` calls with `posixJoin()` for cross-platform compatibility
- This fixes: folder detection, trash watcher, metadata sync, rename operations

### Impact
Before: Extension couldn't find `post-types` or `.skylit/metadata` on SSH because paths were being treated as local Windows paths.
After: All SSH remote paths are properly joined with forward slashes, enabling full functionality on Windows → SSH connections.

---

## [1.4.4] - 2026-01-25

### Added
- **🔍 Enhanced folder detection logging**: Added detailed diagnostics for post-types and .skylit/metadata folder detection
- **📂 Dev folder contents listing**: When folders are not found, extension now lists what's actually in the dev folder for debugging
- **🐛 SSH path debugging**: Better visibility into why watchers might not start on SSH connections

### Technical Details
- Added logging to show exact paths being checked for post-types and metadata folders
- Extension now reports dev folder contents when folders are not found
- Helps diagnose SSH vs local path resolution issues

---

## [1.4.3] - 2026-01-25

### Fixed
- **♻️ SSH trash/restore detection**: Enhanced folder movement detection for SSH/remote filesystems
- **🔍 Verbose logging**: Added detailed debug logging for trash/restore operations to diagnose sync issues
- **📤 Restore from _trash**: Extension now detects when folders appear outside `_trash` directory as potential restore actions
- **🌐 Remote filesystem compatibility**: Improved handling of different filesystem event sequences on SSH connections

### Technical Details
- Added detection for `addDir` events outside trash to catch restore operations
- Enhanced `handlePotentialTrashAction` with comprehensive logging at every decision point
- WordPress API already has server-side validation (checks if post is actually trashed before restoring)
- Trash watcher now logs all folder events for debugging: `addDir`, `unlinkDir`, post ID extraction, trash status

---

## [1.3.4] - 2026-01-24

### Changed
- **🔕 No more auto-prompts on startup**: Extension no longer automatically shows connection dialogs when activated
- **Manual connection workflow**: Extension now loads with red/disconnected status bar, waiting for user to click and initiate connection
- **User-initiated URL/token prompts**: WordPress URL and auth token prompts only appear when user manually clicks "Connect to WordPress"
- **Cleaner startup experience**: Extension silently detects WordPress sites and shows disconnected state without interrupting workflow

### Improved
- Better first-time user experience - no unexpected dialogs
- More predictable connection flow
- User is in full control of when to connect

---

## [1.3.1] - 2026-01-24

### Fixed
- **🌍 Cross-platform compatibility**: Extension now works on Windows, macOS, Linux, and remote SSH servers
- **📦 Webpack bundling**: All dependencies now bundled into single JavaScript file (no more "Cannot find module" errors)
- **🍎 macOS support**: `fsevents` marked as optional dependency, gracefully skipped on Windows/Linux
- **🔧 TypeScript configuration**: Fixed module resolution for proper dependency imports

### Changed
- **BREAKING**: Extension main entry point changed from `./out/extension.js` to `./dist/extension.js`
- Build system switched from TypeScript compiler to Webpack
- All dependencies (chokidar, axios, readdirp, etc.) now bundled into 354KB single file
- VSIX package reduced from multiple files + node_modules to single bundled JavaScript file

### Technical Improvements
- Added webpack configuration for production builds
- Configured webpack to handle platform-specific dependencies
- Updated `.vscodeignore` to exclude source files and node_modules
- Bundle includes all transitive dependencies (no external dependencies needed)
- Extension now truly system-agnostic and SSH-friendly

### Documentation
- **📖 Completely rewritten README**: Now includes detailed technical explanations
- Added architecture diagrams and component breakdowns
- Included timeline explanations of sync operations
- Added troubleshooting section with common issues
- Documented debouncing, folder detection, and API flow
- Added performance metrics and cross-platform notes

---

## [1.3.0] - 2026-01-19

### Added
- **🎯 Automatic plugin detection**: Extension now verifies Skylit.DEV plugin is installed before attempting connection
- **🌐 Enhanced WordPress detection**: Added `public_html` to common WordPress subdirectory patterns (Hostinger, cPanel)
- **🚀 Always-on activation**: Extension activates on any workspace opening, then searches for WordPress + Skylit plugin
- **💬 Smart notifications**: Helpful popup with action buttons when plugin is detected or missing

### Changed
- **BREAKING**: Extension now requires Skylit.DEV plugin to be active to connect
- Activation is no longer limited to folders containing `wp-config.php` directly
- Extension searches upward (parent folders) and downward (subdirectories like `public_html/`) for WordPress
- Better output logging showing WordPress root, plugin version, and configuration

### Fixed
- **SSH Remote Development**: Extension now activates even when opening domain root folder (WordPress in subdirectory)
- Extension works from any parent folder - no need to open WordPress folder directly
- Plugin detection works across multiple installation patterns

### Improved
- Clear error messages when plugin is not found
- Output channel shows full detection flow for debugging
- Status bar immediately shows detection results

---

## [1.2.0] - 2026-01-23

### Changed
- **Removed persistent notifications**: All success/info popups now auto-dismiss via status bar
- Only critical authentication errors show popup notifications
- All sync operations log to output channel instead of showing persistent toasts
- Status bar shows temporary sync status (1.5-2 seconds)

### Improved
- Better user experience with less notification spam
- Status bar now primary feedback mechanism
- Output channel for detailed logs and debugging

---

## [1.1.0] - 2026-01-21

### Added
- **theme.json sync**: Watches `theme.json` in dev folder and syncs to active WordPress theme
- **Global CSS instant import**: Changes to `assets/css/global.css` trigger instant import to WordPress
- Both new features work automatically when files are saved

### Changed
- Updated minimum Skylit.DEV plugin version to 4.0.0

---

## [1.0.0] - 2026-01-19

### Added
- Initial release
- Instant file sync (IDE → WordPress) via native file watching
- Folder action detection (trash/restore/delete)
- Jump-to-block navigation (Gutenberg → IDE)
- Multi-site WordPress support
- Token-based authentication
- Status bar with connection states
- Command palette actions
- Auto-detect WordPress in workspace
- Debounced file changes (configurable)
- Error handling and retry logic

### Technical Details
- Built with TypeScript
- Uses chokidar for file watching
- Uses axios for REST API calls
- Uses VS Code SecretStorage for secure token storage
- Targets VS Code 1.80.0+ (compatible with Cursor IDE)

---

**Note:** This extension requires Skylit.DEV plugin v4.0.0+ on your WordPress site for full functionality. Version 3.5.0+ required for basic file sync.
