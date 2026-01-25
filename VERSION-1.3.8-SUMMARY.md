# Version 1.3.8 - Automatic Connection & Smart Token Validation

**Release Date:** January 25, 2026

## What's New

### 🚀 Automatic Connection on Startup

The extension now **automatically connects** to WordPress when it detects a Skylit.DEV installation, eliminating the need to manually click "Connect" every time.

**How it works:**
1. Extension starts and scans for WordPress
2. If WordPress + Skylit.DEV plugin found → **Auto-connect**
3. If saved token exists → Validates and connects
4. If token missing or invalid → Shows friendly notification with "Setup Token" button

### 🔑 Smart Token Validation & Error Handling

**Automatic Token Validation:**
- Checks if saved token is still valid
- If invalid or expired → Clears the bad token automatically
- Shows helpful notification with quick "Setup New Token" action
- No more confusing "Invalid token" errors!

**Manual vs Auto-Connect Behavior:**
- **Auto-connect** (on startup): Non-intrusive info messages, no blocking prompts
- **Manual connect** (user clicks): Full prompts for missing token/URL
- Best of both worlds: automatic when possible, interactive when needed

### 🎯 Improved Status Bar & Menu

**Context-Aware Menu:**
- Click status bar when **disconnected** → Quick connect options
- Click status bar when **connected** → Full action menu
- Menu items prioritized based on connection state

**Better Error Messages:**
- Clear status bar messages for each state
- "No auth token - Click to setup"
- "Invalid token - Click to setup"
- "Auto-connect failed - Click to retry"

## Technical Changes

### New Features

1. **Auto-connect on activation** (`src/extension.ts`)
   - Reads `skylit.autoConnect` setting (default: `true`)
   - Calls `connectToWordPress()` with `isAutoConnect: true`
   - Graceful failure - doesn't block or interrupt user

2. **Context-aware connection** (`connectToWordPress()`)
   - New parameter: `isAutoConnect: boolean`
   - Different behavior for auto vs manual connection
   - Auto-connect: Shows info notifications, doesn't block
   - Manual connect: Shows input prompts when needed

3. **Token management improvements** (`authManager.ts`)
   - Added `clearToken()` method
   - Automatically clears invalid tokens
   - Prevents repeated failed connection attempts

4. **Smart menu system** (`skylit.showMenu`)
   - Detects connection state
   - Shows relevant actions only
   - Connect options when disconnected
   - Full menu when connected

### Updated Commands

- `skylit.connect` - Now supports both auto and manual modes
- `skylit.showMenu` - Context-aware menu based on connection state
- All commands provide better error messages with actionable buttons

## Files Changed

- `src/extension.ts` - Auto-connect logic, improved connection handling
- `src/authManager.ts` - Added `clearToken()` method
- `package.json` - Version bump to 1.3.8

## Configuration

The extension respects the existing `skylit.autoConnect` setting:

```json
{
  "skylit.autoConnect": true  // Default: auto-connect on startup
}
```

Set to `false` to disable auto-connect and manually connect each time.

## Benefits

✅ **Zero-click workflow** - Extension connects automatically on startup
✅ **Handles expired tokens** - Clears invalid tokens and prompts for new one
✅ **Non-intrusive** - Auto-connect fails gracefully without blocking
✅ **Clear error messages** - Always know what action to take
✅ **Smart menus** - Only shows relevant options based on state
✅ **One-click token setup** - Quick access from notifications and status bar

## User Experience Flow

### Scenario 1: Happy Path (Saved Valid Token)
```
1. Open workspace in SSH mode
2. Extension detects WordPress ✅
3. Extension finds saved token ✅
4. Extension validates token ✅
5. Auto-connects successfully ✅
6. Status bar shows: "✓ Skylit.DEV I/O - Connected"
7. Start coding! 🎉
```

### Scenario 2: No Token Saved
```
1. Open workspace in SSH mode
2. Extension detects WordPress ✅
3. No saved token found ⚠️
4. Shows notification: "Auth token required" + [Setup Token] button
5. Click [Setup Token] → Enter token → Connects ✅
6. Token saved for next time
```

### Scenario 3: Invalid/Expired Token
```
1. Open workspace in SSH mode
2. Extension detects WordPress ✅
3. Finds saved token but validation fails ❌
4. Clears invalid token automatically
5. Shows notification: "Token is invalid or expired" + [Setup New Token]
6. Click button → Enter new token → Connects ✅
```

## Version History

- **v1.3.5** - Extension appears in SSH mode (`extensionKind: "ui"`)
- **v1.3.6** - Fixed path separators for remote file systems
- **v1.3.7** - VS Code File System API for remote file access
- **v1.3.8** - Automatic connection & smart token validation ← **This version**

## Upgrade Instructions

1. Install `skylit-dev-io-1.3.8.vsix`
2. Reload window
3. Extension will automatically connect if you have a saved token!
4. If you don't have a token saved, click the notification to set it up

## Breaking Changes

None! This version is fully backward compatible.

## Future Improvements

Potential enhancements for future versions:
- Support multiple WordPress sites with saved tokens for each
- Token refresh/renewal automation
- Connection retry with exponential backoff
- Offline mode detection
