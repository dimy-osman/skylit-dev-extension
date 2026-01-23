# Skylit.DEV I/O - VS Code/Cursor Extension

Instant bidirectional sync between WordPress Gutenberg and your IDE.

## What it does

This extension solves a critical problem: **WP Cron doesn't run automatically on local development**, breaking file-to-WordPress sync. The extension provides:

1. **Instant file watching** - Native file system monitoring (no relying on WP Cron)
2. **Folder action detection** - Trash/restore/delete posts by moving folders
3. **Jump-to-block navigation** - Click block in Gutenberg → IDE opens exact line
4. **Multi-site support** - Manage multiple WordPress projects in one workspace

## Requirements

- **Skylit Dev I/O Plugin** v3.5.0+ installed on your WordPress site
- VS Code 1.80.0+ or Cursor IDE
- Local WordPress development environment

## Quick Setup

1. **Install Extension**
   - Open VS Code/Cursor
   - Search for "Skylit.DEV I/O" in Extensions
   - Click Install

2. **Generate Auth Token**
   - Open your WordPress site
   - Go to **WordPress Admin → Skylit → About**
   - Scroll to "Extension" section
   - Click "Generate Auth Token"
   - Copy the token

3. **Connect Extension**
   - Open your WordPress project in VS Code/Cursor
   - Extension auto-detects WordPress (looks for `wp-config.php`)
   - Click "Skylit" in status bar
   - Choose "Setup Auth Token"
   - Paste token from WordPress

4. **Done!**
   - Status bar shows "✅ Skylit: Connected"
   - Edit files → WordPress updates instantly
   - Move folders to `_trash/` → Posts trash automatically

## Features

### 1. Instant File Sync (IDE → WordPress)

**Problem Solved:** WP Cron doesn't run on local dev, so file changes don't sync to WordPress.

**How Extension Fixes It:**
- Watches your dev folder with native file system monitoring
- Detects HTML/CSS changes in < 100ms
- Sends changes via REST API to WordPress
- WordPress updates Gutenberg editor instantly

**What You See:**
```
Edit: pages/home_123/home_123.html
  ↓ (< 1 second)
Gutenberg editor updates with new content
```

### 2. Folder Action Detection (Trash/Restore/Delete)

**Problem Solved:** Moving folders to `_trash/` didn't trigger WordPress post status changes.

**How Extension Fixes It:**
- Detects when folder moves to/from `_trash/` directory
- Sends folder action to WordPress via REST API
- WordPress calls `wp_trash_post()` / `wp_untrash_post()`

**What You See:**
```
Move folder: pages/about_456/ → _trash/pages/about_456/
  ↓ (< 1 second)
WordPress trashes post, Gutenberg redirects to trash list
```

### 3. Jump-to-Block Navigation (Gutenberg → IDE)

**How It Works:**
- Click any block in Gutenberg editor
- WordPress finds block in HTML file
- Opens file in IDE at exact line number

**What You See:**
```
Click <section> block in Gutenberg
  ↓
IDE opens: pages/home_123/home_123.html at line 42
```

### 4. Multi-Site Support

**How It Works:**
- Extension scans workspace for all `wp-config.php` files
- Detects multiple WordPress installations
- Manages connections/tokens for each site

**What You See:**
- Workspace with 3 WordPress sites
- Extension connects to all 3 simultaneously
- File changes sync to correct site automatically

## Status Bar

Extension shows real-time sync status:

- **✅ Skylit: Connected** - All systems operational
- **🔄 Skylit: Syncing...** - File change detected, sending to WordPress
- **❌ Skylit: Error** - Connection lost or auth failed

Click status bar to open menu:
- Connect/Disconnect
- Setup Auth Token
- Sync Current File
- View Logs

## Commands

Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

- `Skylit: Connect to WordPress` - Establish connection
- `Skylit: Disconnect` - Stop file watching
- `Skylit: Setup Auth Token` - Configure authentication
- `Skylit: Sync Current File` - Force sync current file
- `Skylit: Show Menu` - Open status menu

## Settings

Configure via VS Code/Cursor settings:

```json
{
  "skylit.autoConnect": true,           // Auto-connect when WP detected
  "skylit.debounceMs": 500,             // Delay before syncing (ms)
  "skylit.showNotifications": true,     // Show sync success/error toasts
  "skylit.siteUrl": ""                  // Override auto-detected site URL
}
```

## Troubleshooting

### Extension Not Connecting

**Check:**
1. Is Skylit plugin installed and activated?
2. Is plugin version 3.5.0 or higher?
3. Is auth token valid? (regenerate in WordPress)
4. Is WordPress site running? (visit site URL in browser)

**Fix:**
- Click status bar → "Setup Auth Token"
- Regenerate token in WordPress Admin → Skylit → About
- Paste new token in extension

### File Changes Not Syncing

**Check:**
1. Is extension connected? (status bar shows "✅ Connected")
2. Are you editing files inside dev folder? (e.g., `wp-content/prj-dev-root/`)
3. Are you editing HTML/CSS files? (JS/PHP sync differently)

**Fix:**
- Right-click file → "Skylit: Sync Current File"
- Check Output panel (`View → Output → Skylit Dev UI`) for errors

### Folder Actions Not Working

**Check:**
1. Are you moving entire post folder? (e.g., `pages/home_123/`)
2. Is destination `_trash/` directory? (not Recycle Bin)
3. Is folder name format correct? (`{slug}_{post_id}/`)

**Fix:**
- Check extension logs for detected folder actions
- Verify post ID matches WordPress post

## How It Works

### Architecture

```
┌─────────────────────────┐
│  VS Code/Cursor IDE     │
│  - File Watcher         │
│  - REST API Client      │
│  - Auth Manager         │
└───────────┬─────────────┘
            │
            │ REST API (HTTP)
            │ POST /wp-json/skylit/v1/sync/import-instant
            │ POST /wp-json/skylit/v1/sync/folder-action
            │
            ↓
┌─────────────────────────┐
│  WordPress Plugin       │
│  - REST API Endpoints   │
│  - Sync Engine          │
│  - Block Compiler       │
└───────────┬─────────────┘
            │
            ↓
┌─────────────────────────┐
│  Gutenberg Editor       │
│  - Real-time Polling    │
│  - Block Navigation     │
└─────────────────────────┘
```

### Sync Flow

1. **You edit file:** `pages/home_123/home_123.html`
2. **Chokidar detects change** (< 100ms)
3. **Extension debounces** (500ms - wait for typing to stop)
4. **REST API call:** `POST /sync/import-instant` with HTML/CSS
5. **WordPress imports:** Converts HTML → Gutenberg blocks
6. **Gutenberg polls** (3s interval): Checks for updates
7. **Editor refreshes:** Shows new content

**Total time: IDE edit → Gutenberg update = ~4 seconds**

(3s from polling delay, <1s from sync itself)

## Comparison: With vs Without Extension

| Feature | Without Extension | With Extension |
|---------|-------------------|----------------|
| **IDE → WP Sync** | Manual button click only | Instant (< 1s) |
| **WP Cron Reliability** | Doesn't run on local dev | Not needed |
| **Folder Trash/Restore** | Manual in WordPress | Instant (move folder) |
| **Jump to Code** | Not available | Click block → IDE opens |
| **Multi-Site** | One at a time | All sites simultaneously |

## Roadmap

**Current Version (1.0):**
- ✅ Instant file sync (HTML/CSS)
- ✅ Folder action detection
- ✅ Jump-to-block navigation
- ✅ Multi-site support

**Future Versions:**
- WebSocket support (< 100ms latency)
- Conflict detection (check post lock)
- Visual diff view
- Live collaboration features

## Support

**Issues:**
- [GitHub Issues](https://github.com/skylit/skylit-dev-extension/issues)

**Documentation:**
- [Skylit Plugin Docs](https://github.com/skylit/skylit-dev-ui)
- [Extension Guide](https://skylit.dev/docs/extension)

## License

GPL-2.0-or-later

---

**Made with ❤️ by Skylit.DEV**
