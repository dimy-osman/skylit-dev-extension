# Skylit.DEV Extension - Debug Output Control

## Overview

The Skylit.DEV extension now includes centralized debug logging that can be toggled on or off through VS Code settings. This prevents console noise while still allowing detailed debugging when needed.

## Settings

### Enable/Disable Debug Output

**Setting Name:** `skylit.debugOutput`  
**Type:** Boolean  
**Default:** `false` (disabled)  
**Description:** Enable debug output in the Output panel (useful for troubleshooting)

## How to Toggle Debug Output

### Method 1: Via Settings UI

1. Open VS Code Settings (`Ctrl+,` or `Cmd+,`)
2. Search for "skylit debug"
3. Check/uncheck the box for **"Skylit.DEV I/O: Debug Output"**

### Method 2: Via settings.json

Add or modify this setting in your `settings.json`:

```json
{
  "skylit.debugOutput": true  // or false to disable
}
```

### Method 3: Via Command Palette

1. Open Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`)
2. Type "Preferences: Open Settings (UI)"
3. Search for "skylit debug"
4. Toggle the setting

## What Gets Logged

### Always Logged (regardless of debug setting):
- ✅ Connection status changes
- ⚠️ Warnings and errors
- ℹ️ Important info messages (activations, token saves, etc.)

### Only Logged When Debug is Enabled:
- 🔍 File watcher events
- 📁 Folder operations
- 🔄 Sync operations
- 📍 Jump-to-code requests
- 🤖 AI request processing
- 📦 Metadata operations
- 🎨 CSS/JS sync details
- All detailed diagnostic information

## Implementation

The debug system uses a centralized `DebugLogger` class that:
- Wraps the VS Code OutputChannel
- Checks the `skylit.debugOutput` setting before logging
- Provides methods: `.log()`, `.info()`, `.warn()`, `.error()`
- Automatically reloads when settings change

## For Developers

### Using DebugLogger in Code

```typescript
import { DebugLogger } from './debugLogger';

// Pass debugLogger to your class
constructor(debugLogger: DebugLogger) {
    this.debugLogger = debugLogger;
}

// Use appropriate methods
this.debugLogger.log('🔍 Debug detail');        // Only when debug enabled
this.debugLogger.info('✅ Important message');  // Always shown
this.debugLogger.warn('⚠️ Warning');            // Always shown
this.debugLogger.error('❌ Error');             // Always shown
```

### Method Guide

- **`.log()`** - Debug details (only when `debugOutput: true`)
- **`.info()`** - Important information (always shown)
- **`.warn()`** - Warnings (always shown)
- **`.error()`** - Errors (always shown)

## Troubleshooting

If you're experiencing issues with the extension:

1. Enable debug output: `"skylit.debugOutput": true`
2. Reproduce the issue
3. Open the Output panel (`View` → `Output`)
4. Select "Skylit.DEV I/O" from the dropdown
5. Review the detailed logs

## Related

This complements the JavaScript debug control in the WordPress plugin:
- **Extension (TypeScript):** Controlled via `skylit.debugOutput` setting
- **WordPress (JavaScript):** Controlled via `SKYLIT_DEBUG_CONFIG.ENABLED` in `skylit-debug-config.js`
