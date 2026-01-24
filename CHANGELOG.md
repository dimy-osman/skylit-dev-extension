# Changelog

All notable changes to the Skylit.DEV I/O extension will be documented in this file.

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
