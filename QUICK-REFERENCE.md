# Quick Reference - Skylit.DEV I/O Extension v1.3.1

## Latest Build
```
File: skylit-dev-io-1.3.1.vsix
Size: 383 KB (383,559 bytes)
Date: January 24, 2026 at 18:28
Location: skylit-dev-ide-extension/skylit-dev-io-1.3.1.vsix
```

## What's New in 1.3.1
✅ Cross-platform support (Windows, Mac, Linux, SSH)  
✅ Webpack bundling (all dependencies in single file)  
✅ Comprehensive technical documentation  
✅ Fixed "Cannot find module 'readdirp'" error  

## Installation
```bash
# Install from VSIX
Extensions panel → ... → Install from VSIX → Select skylit-dev-io-1.3.1.vsix
```

## Quick Setup
1. Install extension from VSIX
2. WordPress Admin → Skylit → About → Generate Token
3. Status bar → Click "Skylit" → Setup Auth Token
4. Paste token → Done!

## How It Works (30 Second Version)
```
You edit file
    ↓ (100ms)
Chokidar detects change
    ↓ (500ms debounce)
Extension reads file
    ↓ (200ms)
POST to WordPress REST API
    ↓ (100ms)
WordPress imports to Gutenberg
    ↓ (3s poll interval)
Editor updates
```

## Troubleshooting
```bash
# Extension won't connect?
1. Check WordPress is running: curl http://localhost:8000
2. Regenerate token in WordPress
3. Click status bar → Setup Auth Token → paste new token

# Files not syncing?
1. Check status bar shows "Connected"
2. Check file is *.html or *.css
3. Check file is in prj-dev-root/ folder
4. View → Output → Skylit Dev UI (check logs)

# Folder actions not working?
1. Must move entire folder (not just file)
2. Destination must be _trash/ (not OS Recycle Bin)
3. Folder name must be {slug}_{post_id}/
```

## Key Concepts

### Debouncing
Extension waits 500ms after you stop typing before syncing.  
Prevents 100s of API calls while you type.

### Folder Detection
```
pages/about_456/ → _trash/pages/about_456/ = TRASH
_trash/pages/about_456/ → pages/about_456/ = RESTORE
Delete _trash/pages/about_456/ = DELETE
```

### Multi-Site
Extension scans workspace for all wp-config.php files.  
Automatically connects to all detected WordPress sites.

## Performance
- File detection: < 100ms
- Debounce wait: 500ms (configurable)
- API request: 50-200ms
- **Total sync time: ~700-800ms**
- Memory: 30-50 MB
- CPU: < 1% idle

## Documentation
- **README.md**: Full technical documentation (20 KB)
- **CHANGELOG.md**: Version history
- **CROSS-PLATFORM-FIX.md**: Technical details of cross-platform support
- **VERSION-1.3.1-SUMMARY.md**: This release summary

## Support
- Check Output panel: View → Output → "Skylit Dev UI"
- Read troubleshooting section in README
- Check extension logs for API errors

## Previous Versions
- 1.0.0: Initial release (57 KB)
- 1.2.0: Removed notification spam (732 KB)
- 1.3.0: Plugin detection improvements (377 KB)
- **1.3.1: Cross-platform + documentation (383 KB) ← LATEST**

---

**Always use the highest version number!**  
Version 1.3.1 = Most recent = Most bug fixes = Most features
