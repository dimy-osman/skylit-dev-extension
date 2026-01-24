# Skylit.DEV I/O - IDE Extension

**Real-time file synchronization between your IDE and WordPress Gutenberg editor.**

This VS Code/Cursor extension bypasses WordPress's unreliable WP Cron system by using native file system watching to detect changes and sync them instantly to WordPress via REST API.

---

## The Problem This Solves

WordPress's Skylit plugin relies on WP Cron for syncing files from the filesystem to the Gutenberg editor. On local development environments, WP Cron **does not run automatically** because there's no traffic triggering it. This means:

- You edit an HTML file in your IDE
- You refresh Gutenberg
- **Nothing happens** - your changes aren't there
- You have to manually trigger sync from WordPress admin

This extension eliminates this problem by **watching files directly in your IDE** and pushing changes to WordPress immediately.

---

## How It Works

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│ YOUR IDE (VS Code / Cursor)                                  │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────────┐         ┌────────────────┐           │
│  │  Chokidar        │────────▶│  REST Client   │           │
│  │  File Watcher    │         │  (Axios)       │           │
│  │                  │         │                │           │
│  │  Watches:        │         │  Sends:        │           │
│  │  - *.html        │         │  - POST sync   │           │
│  │  - *.css         │         │  - Auth token  │           │
│  │  - folder moves  │         │  - File data   │           │
│  └──────────────────┘         └────────┬───────┘           │
│                                         │                    │
└─────────────────────────────────────────┼────────────────────┘
                                          │
                                          │ HTTPS
                                          │ /wp-json/skylit/v1/
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────┐
│ WORDPRESS SERVER                                             │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌────────────────────────────────────────────────────┐    │
│  │  REST API Endpoint                                  │    │
│  │  /wp-json/skylit/v1/sync/import-instant            │    │
│  │                                                     │    │
│  │  Receives: HTML/CSS content                        │    │
│  │  Validates: Auth token                             │    │
│  │  Processes: Converts HTML → Gutenberg blocks       │    │
│  │  Updates: wp_posts table                           │    │
│  │  Triggers: Gutenberg editor refresh                │    │
│  └────────────────────────────────────────────────────┘    │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### Component Breakdown

#### 1. File Watcher (`fileWatcher.ts`)

**Technology:** Chokidar (cross-platform Node.js file watcher)

**What it does:**
- Monitors the WordPress `prj-dev-root/` folder recursively
- Detects file changes (create, modify, delete)
- Detects folder movements (to/from `_trash/`)
- Implements debouncing (500ms default) to avoid syncing on every keystroke

**File watching logic:**
```typescript
// Watches these patterns
watcher.watch('prj-dev-root/**/*.html')
watcher.watch('prj-dev-root/**/*.css')

// Ignores these
- .git/
- node_modules/
- _trash/ (except for moves to/from)

// Events handled
.on('change', filePath => syncFile(filePath))
.on('add', dirPath => detectNewFolder(dirPath))
.on('unlink', dirPath => detectFolderTrash(dirPath))
```

**Debouncing:**
- When you type in a file, changes fire constantly (every keystroke)
- Extension waits 500ms after last change before syncing
- Prevents 100s of API calls while you're typing

#### 2. REST Client (`restClient.ts`)

**Technology:** Axios (HTTP client)

**What it does:**
- Sends authenticated HTTP requests to WordPress
- Handles token-based authentication
- Manages request/response cycle

**API Endpoints Used:**

1. **File Sync:** `POST /wp-json/skylit/v1/sync/import-instant`
   ```json
   {
     "post_id": 123,
     "html": "<section>...</section>",
     "css": ".class { color: red; }",
     "token": "abc123..."
   }
   ```

2. **Folder Actions:** `POST /wp-json/skylit/v1/sync/folder-action`
   ```json
   {
     "post_id": 123,
     "action": "trash|restore|delete",
     "token": "abc123..."
   }
   ```

3. **Theme Folder:** `GET /wp-json/skylit/v1/theme/path`
   - Retrieves WordPress theme folder path
   - Used for bidirectional theme file sync

**Authentication:**
- Token stored in VS Code SecretStorage (encrypted)
- Sent in request body (not headers for compatibility)
- WordPress validates token against saved value in options table

#### 3. Workspace Manager (`workspaceManager.ts`)

**What it does:**
- Scans workspace for WordPress installations
- Looks for `wp-config.php` files
- Extracts site URL from wp-config
- Determines `prj-dev-root/` location
- Supports multiple WordPress sites in one workspace

**Detection algorithm:**
```typescript
1. Find all wp-config.php files in workspace
2. For each wp-config:
   - Parse PHP to extract WP_HOME or WP_SITEURL
   - Look for prj-dev-root/ folder nearby
   - Check if folder contains pages/ posts/ products/ etc.
3. Store detected site info (URL, dev folder, theme path)
4. Allow user to connect to each site independently
```

#### 4. Status Bar (`statusBar.ts`)

**What it does:**
- Shows connection status in VS Code status bar
- Updates based on connection/sync state
- Provides quick menu access

**States:**
- `✅ Skylit: Connected` - Watching files, ready to sync
- `🔄 Skylit: Syncing...` - Currently sending data to WordPress
- `❌ Skylit: Error` - Connection failed or auth invalid
- `⏸️  Skylit: Disconnected` - File watching stopped

#### 5. Protocol Handler (`protocolHandler.ts`)

**What it does:**
- Registers `skylit://` URI scheme
- WordPress can open IDE files via: `skylit://open?file=/path/to/file.html&line=42`
- Used for "Jump to Code" feature from Gutenberg

**How Gutenberg → IDE works:**
1. User clicks block in Gutenberg editor
2. JavaScript captures click, sends AJAX to WordPress
3. WordPress searches HTML file for block's position
4. WordPress returns: `{ file: 'pages/home_123/home_123.html', line: 42 }`
5. Gutenberg opens: `skylit://open?file=...&line=42`
6. Extension receives URI, opens file at exact line

---

## Detailed Feature Breakdown

### Feature 1: Instant File Sync (IDE → WordPress)

**Timeline of events:**

```
T=0ms:    You save home_123.html in IDE
T=10ms:   Chokidar fires 'change' event
T=10ms:   Extension starts 500ms debounce timer
T=510ms:  Debounce completes, extension reads file
T=520ms:  POST /wp-json/skylit/v1/sync/import-instant
          {
            post_id: 123,
            html: "<section>...</section>",
            css: ".home { color: blue; }",
            token: "abc123..."
          }
T=800ms:  WordPress receives request
T=810ms:  WordPress validates token
T=820ms:  WordPress parses HTML into Gutenberg blocks
T=850ms:  WordPress updates wp_posts.post_content
T=860ms:  WordPress returns success
T=860ms:  Extension shows "✅ Synced" notification

Meanwhile in browser:
T=0ms:    User has Gutenberg editor open
T=3000ms: Gutenberg polls for updates (every 3 seconds)
T=3050ms: WordPress returns: "content changed"
T=3100ms: Gutenberg refreshes editor with new blocks
```

**Total latency:** ~4 seconds (mostly from Gutenberg's 3s poll interval)

### Feature 2: Folder Action Detection

**How folder watching works:**

Extension watches for these specific patterns:
```
pages/about_456/         ← Original location
_trash/pages/about_456/  ← Trashed location
```

**Trash detection:**
```typescript
// When folder moves TO _trash/
1. Extension detects: unlink event for pages/about_456/
2. Extension checks: Does _trash/pages/about_456/ now exist?
3. If yes: POST /folder-action { action: "trash", post_id: 456 }
4. WordPress calls: wp_trash_post(456)
5. Post status → "trash"
6. Gutenberg redirects to trash page
```

**Restore detection:**
```typescript
// When folder moves FROM _trash/
1. Extension detects: add event for pages/about_456/
2. Extension checks: Did _trash/pages/about_456/ just disappear?
3. If yes: POST /folder-action { action: "restore", post_id: 456 }
4. WordPress calls: wp_untrash_post(456)
5. Post status → "publish" (or previous status)
6. Gutenberg shows restored post
```

**Delete detection:**
```typescript
// When folder is permanently deleted from _trash/
1. Extension detects: unlink event for _trash/pages/about_456/
2. Extension checks: Folder gone from both locations?
3. If yes: POST /folder-action { action: "delete", post_id: 456 }
4. WordPress calls: wp_delete_post(456)
5. Post removed from database
```

### Feature 3: New Folder Detection

**When you create a new post folder:**

```typescript
// User creates: pages/new-page/
1. Extension detects new folder
2. Extension waits 2 seconds (for HTML file creation)
3. If new-page.html exists:
   - POST /folder-action { action: "create", slug: "new-page" }
   - WordPress creates new post
   - WordPress returns new post_id
   - Extension renames folder: new-page/ → new-page_789/
4. If no HTML file: ignore (might be a temp folder)
```

### Feature 4: Bidirectional Theme Sync

**WordPress theme files sync both directions:**

**Theme → Dev:**
- WordPress child theme files (`.php`, `.css`, `.js`)
- When modified in WordPress Customizer
- Extension polls WordPress every 5 seconds
- Downloads changed files to `themes/child-theme/` folder

**Dev → Theme:**
- When you edit theme files in IDE
- Extension uploads to WordPress theme directory
- WordPress refreshes Customizer automatically

---

## Installation & Setup

### 1. Prerequisites

**You must have:**
- Skylit Dev I/O WordPress plugin v3.5.0+ installed and activated
- A WordPress development folder structure like this:
  ```
  wp-content/
  ├── prj-dev-root/          ← Extension watches this
  │   ├── pages/
  │   │   └── home_123/
  │   │       ├── home_123.html
  │   │       └── home_123.css
  │   ├── posts/
  │   ├── products/
  │   └── _trash/
  ├── themes/
  └── plugins/
  ```

### 2. Install Extension

**From Marketplace:**
1. Open VS Code/Cursor
2. Extensions panel (Ctrl+Shift+X)
3. Search: "Skylit.DEV I/O"
4. Click Install

**From VSIX file:**
1. Download `skylit-dev-io-X.X.X.vsix`
2. Extensions panel → `...` → Install from VSIX
3. Select downloaded file

### 3. Generate Auth Token in WordPress

1. Open WordPress admin
2. Navigate to **Skylit → About**
3. Scroll to **"Extension"** section
4. Click **"Generate Auth Token"**
5. Copy the generated token (long alphanumeric string)

**What this does:**
- Creates a random 64-character token
- Saves to WordPress options: `update_option('skylit_extension_token', $token)`
- Extension uses this token to authenticate API requests

### 4. Connect Extension

1. Open your WordPress project in VS Code/Cursor
2. Extension auto-detects WordPress (searches for `wp-config.php`)
3. Status bar shows: **"⏸️  Skylit: Disconnected"**
4. Click status bar
5. Choose **"Setup Auth Token"**
6. Paste token from WordPress
7. Status bar updates: **"✅ Skylit: Connected"**

**What happens internally:**
```typescript
1. Token stored: await context.secrets.store('skylit_token', token)
2. Workspace scanned: find wp-config.php, extract site URL
3. Dev folder located: find prj-dev-root/ relative to wp-config
4. File watcher started: chokidar.watch(devFolder)
5. Test connection: GET /wp-json/skylit/v1/health
6. If success: status = "Connected"
```

---

## Configuration

### Extension Settings

Open VS Code Settings (Ctrl+,) and search for "Skylit":

```jsonc
{
  // Auto-connect when WordPress detected in workspace
  "skylit.autoConnect": true,
  
  // Milliseconds to wait after file change before syncing
  // Higher = fewer API calls, lower = faster sync
  "skylit.debounceMs": 500,
  
  // Show desktop notifications for sync success/errors
  "skylit.showNotifications": true,
  
  // Override auto-detected WordPress site URL
  // Leave empty to auto-detect from wp-config.php
  "skylit.siteUrl": ""
}
```

### Debounce Explanation

**Without debounce:**
```
You type: "Hello World"
H → sync
He → sync
Hel → sync
Hell → sync
Hello → sync
Hello  → sync
Hello W → sync
... (11 API calls)
```

**With 500ms debounce:**
```
You type: "Hello World"
H → (wait)
He → (reset timer)
Hel → (reset timer)
...
Hello World → (wait 500ms) → sync
(1 API call)
```

---

## Commands

Access via Command Palette (Ctrl+Shift+P / Cmd+Shift+P):

| Command | What It Does |
|---------|--------------|
| `Skylit: Scan for WordPress` | Re-scan workspace for WordPress installations |
| `Skylit: Connect to WordPress` | Start file watching and connect to WordPress |
| `Skylit: Disconnect` | Stop file watching (changes won't sync) |
| `Skylit: Setup Auth Token` | Enter/update WordPress authentication token |
| `Skylit: Sync Current File` | Force immediate sync of currently open file |
| `Skylit: Show Menu` | Open quick menu from status bar |

---

## Troubleshooting

### Extension Not Connecting

**Symptom:** Status bar stuck on "Disconnected" or "Error"

**Check:**
```bash
# 1. Is WordPress running?
curl http://localhost:8000

# 2. Is REST API accessible?
curl http://localhost:8000/wp-json/

# 3. Is Skylit plugin active?
# Check: WordPress Admin → Plugins → Skylit Dev I/O (must be blue/active)

# 4. Is token correct?
# Regenerate in WordPress, paste again in extension
```

**Fix:**
1. Click status bar → "Disconnect"
2. WordPress Admin → Skylit → About → Generate New Token
3. Click status bar → "Setup Auth Token"
4. Paste new token
5. Click status bar → "Connect"

### File Changes Not Syncing

**Symptom:** You edit files, but Gutenberg doesn't update

**Check:**
1. Status bar shows "✅ Connected" (not disconnected/error)
2. File is inside `prj-dev-root/` folder
3. File is `*.html` or `*.css` (other extensions not watched)
4. Post folder follows format: `{slug}_{post_id}/`

**Debug:**
```typescript
// Open Output panel
View → Output → Select "Skylit Dev UI"

// You should see:
[14:23:45] File changed: pages/home_123/home_123.html
[14:23:45] Debouncing for 500ms...
[14:23:46] Syncing to WordPress...
[14:23:46] POST /wp-json/skylit/v1/sync/import-instant
[14:23:47] ✓ Sync successful

// If you see errors:
[14:23:47] ✗ Sync failed: 401 Unauthorized
// ^ Token invalid, regenerate in WordPress

[14:23:47] ✗ Sync failed: 404 Not Found
// ^ Post ID doesn't exist in WordPress

[14:23:47] ✗ Sync failed: ECONNREFUSED
// ^ WordPress not running
```

**Force sync:**
1. Open file in editor
2. Command Palette → "Skylit: Sync Current File"
3. Check Output panel for response

### Folder Actions Not Working

**Symptom:** Moving folders to `_trash/` doesn't trash posts

**Common mistakes:**
```
✗ Wrong: pages/home_123 → Recycle Bin (OS trash, extension can't detect)
✓ Right: pages/home_123 → _trash/pages/home_123 (extension detects)

✗ Wrong: pages/home/ → _trash/pages/home/ (no post ID in folder name)
✓ Right: pages/home_123/ → _trash/pages/home_123/ (has post ID)

✗ Wrong: pages/home_123.html → _trash/ (moving file, not folder)
✓ Right: pages/home_123/ → _trash/ (moving entire folder)
```

**Check folder name:**
```typescript
// Folder name must be: {slug}_{post_id}
pages/about_456/          ← Correct
pages/456/                ← Wrong (no slug)
pages/about/              ← Wrong (no post ID)
pages/about-page_456/     ← Correct (slug can have hyphens)
```

### Performance Issues

**Symptom:** Extension feels slow, many notifications

**Possible causes:**
1. **Debounce too low:** Set `skylit.debounceMs` higher (1000-2000ms)
2. **Too many files:** Extension watches entire `prj-dev-root/`, if you have 1000s of files, performance drops
3. **Network latency:** Slow connection to WordPress server

**Optimize:**
```jsonc
{
  // Increase debounce (wait longer before syncing)
  "skylit.debounceMs": 1500,
  
  // Disable notifications (less UI overhead)
  "skylit.showNotifications": false,
  
  // Manually control connection
  "skylit.autoConnect": false
}
```

---

## Cross-Platform Support

This extension is fully cross-platform and works identically on:
- ✅ Windows (local)
- ✅ macOS (local)
- ✅ Linux (local)
- ✅ Remote SSH (Linux servers)
- ✅ WSL (Windows Subsystem for Linux)

**How this is achieved:**
- All dependencies bundled via webpack into single JavaScript file
- Platform-specific modules (like `fsevents` on macOS) marked as optional
- Uses Node.js `path` module for cross-platform path handling
- File watcher (chokidar) handles OS differences internally

**Remote SSH:**
When you connect to a remote server via SSH, the extension runs **on the remote server** (not your local machine). This means:
- File watching happens on the server
- API calls are made from server to WordPress (likely localhost on server)
- No network latency between extension and WordPress

---

## Technical Specifications

### Dependencies

**Runtime:**
- `chokidar` ^3.5.3 - File system watcher
- `axios` ^1.6.0 - HTTP client

**Dev:**
- `typescript` ^5.0.0 - Type-safe compilation
- `webpack` ^5.104.1 - Dependency bundling
- `ts-loader` ^9.5.4 - TypeScript webpack loader

### Bundle Size

- **extension.js**: 354 KB (minified, all dependencies included)
- **VSIX package**: 377 KB total (includes docs, icon, source maps)

### Performance Metrics

**File change detection:** < 100ms (chokidar native file watching)
**Debounce delay:** 500ms (configurable)
**API request time:** 50-200ms (depends on server)
**Total sync time:** ~700-800ms (detection + debounce + request)
**Memory usage:** ~30-50 MB (Node.js + dependencies)
**CPU usage:** < 1% idle, ~2-5% during sync

---

## Roadmap

### Current Version (1.3.1)
- ✅ Cross-platform support (Windows, Mac, Linux, SSH)
- ✅ File sync (HTML/CSS)
- ✅ Folder actions (trash/restore/delete)
- ✅ Jump-to-code (Gutenberg → IDE)
- ✅ Multi-site support
- ✅ Theme bidirectional sync
- ✅ New folder detection

### Future Versions
- **v1.4.0**: WebSocket support (eliminate polling, < 500ms latency)
- **v1.5.0**: Conflict detection (warn if file edited in both places)
- **v1.6.0**: Visual diff viewer (see changes before syncing)
- **v2.0.0**: Live collaboration (multiple developers, one site)

---

## License

GPL-2.0-or-later

---

**Version**: 1.3.1  
**Last Updated**: January 2026  
**Made by**: Skylit.DEV
