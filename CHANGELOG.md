# Changelog

All notable changes to the Skylit.DEV I/O extension will be documented in this file.

## [1.13.0] - 2026-02-05

### ✨ New Command: Manage Post

- **New command: "Skylit: Manage Post"**
    - Right-click any post folder → "Skylit: Manage Post"
    - Comprehensive post management menu with multiple options

- **Change Status**
    - Publish, Draft, Pending Review, Private
    - Schedule for later with date/time picker
    - Format: `YYYY-MM-DD HH:MM:SS` (e.g., `2026-02-10 14:30:00`)

- **Rename Slug**
    - Change URL slug (e.g., `my-page` → `new-page`)
    - Validates format (lowercase, numbers, hyphens only)
    - Checks for conflicts with existing posts
    - Folder auto-renames after update

- **Rename Title**
    - Change post title in WordPress
    - Updates immediately

- **Schedule Post**
    - Set future publish date/time
    - Automatically sets status to "future"
    - WordPress auto-publishes at scheduled time

### 🐛 Bug Fix: Double Prompt on Delete

- **Fixed redundant confirmation dialog**
    - When using "Skylit: Delete Post" command, you now only see ONE confirmation dialog
    - Previously showed command confirmation, then file watcher confirmation
    - Now properly skips the second prompt when deleting via command

### Technical Details

- Added `updatePostMeta()` REST client method
- Enhanced WordPress `rest_update_from_metadata()` endpoint with `scheduled_date` support
- Added skip mechanism for FileWatcher delete prompts
- All inputs validated before sending to WordPress

## [1.12.3] - 2026-02-04

### ✨ New Command: Delete Post

- **New command: "Skylit: Delete Post"**

     - Right-click any post folder → "Skylit: Delete Post"
     - Modal dialog with options: "Move to Trash", "Delete Permanently", or "Cancel"
     - Deletes both WordPress post AND local folder
     - Also cleans up metadata file on permanent delete

- **Context menu integration**
     - Right-click folder in Explorer → "Skylit: Delete Post"
     - Right-click in HTML file → "Skylit: Delete Post"

## [1.12.2] - 2026-02-04

### ✨ New Feature: Folder Deletion Prompt

- **Smart deletion handling for post folders**

     - When you delete a folder with a post ID (e.g., `my-page_123/`), the extension now prompts you
     - Options: "Move to Trash", "Delete Permanently", or "Keep in WordPress"
     - Prevents database bloat from orphaned posts

- **Move to Trash**: Moves the WordPress post to trash (recoverable)
- **Delete Permanently**: Removes the post from WordPress database entirely, also cleans up local metadata file
- **Keep in WordPress**: Folder deleted locally, post remains in database (useful for cleanup/reorganization)

### Technical Details

- Detects deletion vs rename by waiting for folder reappearance
- Only prompts for folders with valid `_ID` suffix
- Metadata file (`.skylit/metadata/{postId}.json`) auto-deleted on permanent delete

## [1.12.1] - 2026-02-04

### ✨ New Command: Request WordPress ID

- **New command: "Skylit: Request WordPress ID"**

     - Creates a WordPress post for a folder that doesn't have a valid ID
     - Available from Command Palette or right-click context menu
     - Automatically detects post type from folder location
     - Renames folder and files with the new post ID

- **Context menu integration**
     - Right-click any folder in Explorer → "Skylit: Request WordPress ID"
     - Right-click in any HTML file → "Skylit: Request WordPress ID"

### Use Cases

- Templates with stale/invalid IDs
- Folders manually created without going through WordPress
- Recovering from deleted WordPress posts

## [1.12.0] - 2026-02-04

### ✨ New Feature: HTML Metadata Editing

- **Edit metadata directly in HTML files**

     - Change Slug, Title, and Status in the WordPress Sync Metadata comment
     - Changes automatically sync to WordPress on file save
     - Slug changes automatically rename folder and files

- **Universal rename support for all post types**

     - Pages, Posts, Templates, Template Parts, Patterns
     - Custom post types also supported
     - Folder/file renaming keeps everything in sync

- **Bidirectional metadata sync**
     - Edit in HTML comment or JSON metadata file
     - Both methods sync to WordPress and update local files

### Example

Edit the metadata comment in any HTML file:

```html
<!--
WordPress Sync Metadata
ID: 123
Slug: my-new-slug
Title: My New Title
Type: page
Status: publish
Modified: 2026-02-04 12:00:00
-->
```

Save the file and the changes will sync to WordPress automatically.

## [1.11.3] - 2026-02-03

### 🔧 Debug Improvements

- **Better error reporting for convert post type**
     - Shows detailed PHP error messages from server
     - Logs file and line number where error occurred
     - More informative error dialogs

## [1.11.2] - 2026-02-03

### 🐛 Critical Fix

- **Authentication Fix for Post Type Converter**
     - Fixed 401 authentication error when using convert command
     - Added proper `convertPostType()` method to `RestClient` class
     - Both manual command and automatic converter now use authenticated requests
     - No longer tries to access private `client` property directly

## [1.11.1] - 2026-02-03

### 🐛 Bug Fixes

- **Post Type Converter Detection Improvements**
     - Fixed file watcher glob pattern that was too restrictive
     - Added workspace event listeners (`onDidRenameFiles`, `onDidDeleteFiles`, `onDidCreateFiles`) for more reliable drag-and-drop detection
     - Improved logging for debugging move detection issues
- **Manual Conversion Command**
     - Added `Skylit: Convert Post Type (for moved folders)` command
     - Allows manual conversion if automatic detection fails
     - Useful for retroactively converting folders that were moved before watcher was active

## [1.11.0] - 2026-02-03

### ✨ New Feature: Universal Post Type Converter

- **Folder Move Detection**

     - Automatically detects when folders are moved between post type directories
     - Supports: pages, posts, templates, template parts, patterns
     - Instant detection with VS Code native UI

- **Conversion Prompt**

     - Shows confirmation dialog when post type change is detected
     - Options: Convert in WordPress, Undo Move, Ignore
     - Non-intrusive modal with clear explanations

- **WordPress Integration**

     - Calls new REST API endpoint `/skylit/v1/convert-post-type`
     - Updates post type in WordPress database
     - Preserves metadata automatically

- **Local Metadata Updates**

     - Updates HTML metadata comments after conversion
     - Synchronizes file system with WordPress state
     - Maintains data consistency

- **Safety Features**
     - User confirmation required for all conversions
     - Easy undo capability (moves folder back)
     - Progress feedback during conversion
     - Error handling and recovery

### 🔧 Technical Details

- New component: `PostTypeConverter` class
- Integrated with existing FileWatcher system
- REST API client integration
- Metadata backup/restore support
- Works with Git operations and manual moves

### 📋 Requires

- WordPress plugin version 5.1.0 or higher
- New REST API endpoint in plugin

## [1.10.8] - 2026-01-30

### 🐛 Fixed

- **Duplicate Detection for Migrated Folders**
     - Extension now checks for existing ID-based folders before creating posts
     - Detects folders migrated by plugin (e.g., `templates/page.html` → `templates/page_294/`)
     - Automatically merges duplicate flat folders into existing ID-based folders
     - Fixes issue where `index.html` and `page.html` without IDs persisted after migration

## [1.10.7] - 2026-01-30

### 🐛 Fixed

- **Templates/Parts Auto-Creation Paths**
     - Fixed folder rename paths for `wp_template` and `wp_template_part`
     - Now correctly renames: `templates/page/` → `templates/page_294/page_294.html`
     - Now correctly renames: `parts/header/` → `parts/header_295/header_295.html`
     - Fixed duplicate detection and merge for templates/parts (prevents double folders after migration)

## [1.10.6] - 2026-01-30

### ✨ Templates & Parts Auto-Creation Support

- **Extension now watches templates and parts folders**
     - Added watchers for `templates/` and `parts/` folders (in addition to `post-types/`)
     - Creates WordPress templates/parts from IDE folders without IDs
     - Example: Create `templates/archive/archive.html` → WordPress creates post, renames to `templates/archive_298/archive_298.html`
- **Folder structure detection updated**
     - Handles: `post-types/pages/`, `templates/`, `parts/`
     - Maps: `templates/` → `wp_template`, `parts/` → `wp_template_part`

## [1.10.5] - 2026-01-30

### 📝 Updated Description

- **Plugin requirement emphasized** - Description now explicitly states "Requires Skylit.DEV WordPress plugin"
- **Clearer value proposition** - Mentions solving WP Cron unreliability on local development

## [1.10.4] - 2026-01-30

### 📝 Marketplace-Ready Documentation

- **Removed all technical internals** - No more API schemas, authentication details, or implementation code
- **Tightened claims** - Removed marketing phrases like "perfect harmony" and "instant"
- **Plugin dependency emphasized** - Clear warning that WordPress plugin is required
- **Removed emoji icons** - Cleaner, more professional tone
- **Fixed broken links** - Replaced placeholder URLs with GitHub links
- **Safer language** - "Changes appear" vs "instant", "Optional sync" vs "automatic"

## [1.10.3] - 2026-01-30

### 📝 Documentation

- **Simplified README** - Removed technical architecture details and code examples
- Rewrote as straightforward user guide focusing on what it does, not how
- Cleaner description in package.json
- Removed obsolete `createPost` command from package.json

## [1.11.0] - 2026-01-30

### 🔒 Security Hardening

- **Protocol Handler Path Validation** (CRITICAL)
     - Added workspace boundary validation for `skylit://jump` protocol
     - Files outside workspace now require explicit user confirmation
     - Line/column numbers validated and bounded (prevent NaN issues)
     - Protects against arbitrary file access from external apps/malicious links
- **HTTP Connection Warning** (HIGH)
     - Added security warning when connecting over HTTP instead of HTTPS
     - Modal dialog explains token transmission risks
     - Localhost connections bypass warning (safe for local dev)
     - Prevents accidental cleartext token exposure on public WiFi/networks
- **Token Response Updated**
     - Compatible with plugin v4.9.66+ minimal token response
     - `TokenValidationResponse` now expects only `user_id` (no email/name)
     - Reduced PII exposure in logs and API responses

### ⚡ Performance & Reliability

- **Smart Polling with Backoff**

     - Jump-to-code polling now uses exponential backoff on errors
     - Starts at 500ms, backs off to max 30s on consecutive failures
     - ±25% jitter prevents thundering herd
     - Auto-recovers to fast polling on success
     - Reduces server load during network issues

- **Mass Action Protection**
     - Bulk folder operations (>5 folders) now require confirmation
     - Modal dialog shows count and action type (trash/restore)
     - User can cancel all pending operations
     - Prevents accidental mass trash/restore

### 🐛 Bug Fixes

- Fixed protocol handler not showing errors to user
- Improved error handling in jump-to-code with user feedback
- Better logging for security-related decisions

## [1.10.0] - 2026-01-30

### Added

- **🧹 Metadata Cleanup System** - Automatic removal of orphaned metadata files
     - Runs on extension startup (initial cleanup)
     - Periodic cleanup every 5 minutes
     - Cleanup stopped on disconnect/deactivate
     - REST client method: `cleanupMetadata()`
     - Integrates with plugin endpoint: `POST /wp-json/skylit/v1/sync/cleanup-metadata`

### Fixed

- **🎯 TypeScript Build Error** - Removed invalid delete action check in fileWatcher
     - Delete action handled by PHP plugin directly, not by extension
     - Fixed compilation error preventing VSIX build

### Changed

- **📦 Extension Architecture** - Metadata cleanup fully integrated
     - `extension.ts`: Added cleanup triggers and interval management
     - `restClient.ts`: Added `cleanupMetadata()` method
     - Compiled VSIX: `skylit-dev-io-1.10.0.vsix` (424.67 KB)

## [1.9.12] - 2026-01-29

### Fixed

- **⏱️ Duplicate Detection Timing**: Reduced from 5 minutes to 30 seconds
     - WordPress exports happen within seconds, not minutes
     - After 30 seconds, same-name folder creates a NEW post (with auto-numbered slug)
     - Prevents false duplicate detection for intentional new page creations
- **🧹 Cleanup After Merge**: Clear rename tracking after successful duplicate merge
     - Allows creating new pages with same name after duplicate was handled
     - No more permanent blocking of folder names

## [1.9.11] - 2026-01-29

### Fixed

- **🔄 Status Bar Race Condition**: Fixed infinite spinning status bar issue
     - Multiple overlapping `showSyncing()` calls no longer cause permanent spin
     - Status now always resets to base connection state, not captured "current" state
     - Added `showError()` for API errors with auto-reset
     - Added `resetToBase()` for manual reset in catch blocks
     - Error states during post creation now properly reset after 3 seconds

## [1.9.10] - 2026-01-29

### Fixed

- **🔄 Check Order Fix**: Duplicate detection now runs BEFORE "already processed" check
     - Was: `processedNewFolders` check ran first, skipping before duplicate check
     - Now: `recentlyRenamedFolders` check runs first, triggering redirect/cleanup
     - Ensures duplicate folders are merged/deleted even if folder was marked processed

## [1.9.9] - 2026-01-29

### Fixed

- **⏱️ Timing Fix**: Track rename BEFORE starting VS Code rename operation
     - Was: tracking happened after rename completed, but trash handler timer fired during rename
     - Now: tracking happens immediately before rename starts
     - Ensures trash handler always sees the rename tracking when checking

## [1.9.8] - 2026-01-29

### Fixed

- **🚫 False Restore Prevention**: Fixed critical bug where our own renames triggered false "restore" actions
     - Trash handler now checks if folder was just renamed by us before treating as restore
     - Prevents WordPress from exporting duplicate folders after rename
     - No more duplicate `learning-hub/` + `learning-hub_731/` folders

## [1.9.7] - 2026-01-29

### Fixed

- **🔄 Robust Rename Handling**: Fixed rename logic to handle all edge cases
     - Handles case where server already renamed (old WP plugin version)
     - Handles case where both source and target exist (merge)
     - Handles case where source doesn't exist (skip gracefully)
     - Separates folder rename from file rename for reliability
     - No longer throws errors - gracefully handles all scenarios

## [1.9.6] - 2026-01-29

### Changed

- **🔄 VS Code Native Rename**: Extension now does the folder/file rename using VS Code's WorkspaceEdit API
     - Open editors are automatically updated to the new file paths
     - AI editing the file sees the rename happen seamlessly - no duplicate files!
     - WordPress plugin returns post ID, extension handles the rename
     - Uses `vscode.workspace.applyEdit()` with `renameFile` for atomic updates

### Fixed

- AI can now continuously edit without worrying about renamed files
- No more "file not found" errors when folder is renamed
- No more duplicate folders from AI recreating old paths

## [1.9.5] - 2026-01-29

### Added

- **🔄 Duplicate Prevention**: If AI recreates a folder that was just renamed, automatically merges it
     - Tracks recent renames (old folder → new folder with ID)
     - If old folder is recreated within 5 minutes, content is merged to existing folder
     - Duplicate folder is deleted automatically
     - AI can work continuously without waiting - extension handles redirects seamlessly

## [1.9.4] - 2026-01-29

### Added

- **📝 Auto-Create Notification**: When folders without IDs are detected and posts created, writes `last-created-post.json`
     - AI can now create folders directly without request file
     - Extension auto-creates WordPress post and renames folder
     - Notification file contains new path for AI to continue editing
     - Simplifies workflow: just create folder → wait → read result → continue

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
- **📤 Restore from \_trash**: Extension now detects when folders appear outside `_trash` directory as potential restore actions
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
