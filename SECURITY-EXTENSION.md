# Security Implementation - Skylit.DEV I/O Extension

## Version 1.11.0 Security Hardening

This document details the security improvements implemented in version 1.11.0 based on a comprehensive security audit.

---

## Critical Security Fixes

### 1. Protocol Handler Path Validation (CRITICAL)

**Issue**: The `skylit://jump` protocol handler could open arbitrary local files without validation, allowing potential unauthorized file access from malicious browser pages or applications.

**Fix**: (`protocolHandler.ts`)
- **Workspace boundary check**: Files must be within open workspace folders
- **User confirmation**: Files outside workspace require explicit modal approval
- **Input validation**: Line/column numbers are bounded and validated (max line: 1,000,000, max column: 10,000)
- **Error handling**: Shows user-friendly error messages instead of silent failures

**Security Impact**:
- Prevents arbitrary file access (e.g., `/etc/passwd`, system files)
- Users explicitly approve any out-of-workspace file access
- Malicious links can't silently open sensitive files

**Example Protected Scenarios**:
```
❌ skylit://jump?file=/etc/passwd&line=1
   → Shows security warning, requires user confirmation

✅ skylit://jump?file=/workspace/project/file.html&line=42
   → Opens directly (within workspace)
```

---

### 2. HTTP Connection Warning (HIGH)

**Issue**: Auth tokens were transmitted over HTTP without warning, exposing them to network interception on public WiFi or compromised routers.

**Fix**: (`extension.ts`)
- **HTTPS detection**: Validates if site URL uses HTTPS
- **Localhost exception**: Local development (localhost, 127.0.0.1, ::1) bypasses warning
- **Modal warning**: Clear explanation of security risks
- **User choice**: Can cancel connection or proceed with acknowledgment

**Security Impact**:
- Prevents accidental cleartext token transmission in production
- Users make informed decisions about security trade-offs
- Safe local development workflow preserved

**Warning Message**:
```
⚠️ Security Warning

You are connecting over HTTP instead of HTTPS. Your auth token will be 
transmitted in cleartext and could be intercepted.

Use HTTPS in production for secure communication.

[Continue Anyway]  [Cancel]
```

---

### 3. Token Response Update (MEDIUM)

**Issue**: Extension expected full user details (email, name) in token validation response, creating unnecessary PII exposure.

**Fix**: (`types.ts`, `restClient.ts`)
- **Minimal response**: Only `user_id` returned (compatible with plugin v4.9.66+)
- **Reduced logging**: No longer logs email/name to output channel
- **Type safety**: `TokenValidationResponse` interface updated

**Security Impact**:
- Reduced PII exposure in extension logs
- Compatible with plugin-side PII protection
- Leaked logs contain less sensitive information

---

## Performance & Reliability Improvements

### 4. Smart Polling with Exponential Backoff

**Issue**: Jump-to-code polling hit server every 500ms regardless of errors, potentially hammering server during outages.

**Fix**: (`extension.ts`)
- **Dynamic intervals**: Starts at 500ms, backs off to 30s max
- **Exponential backoff**: Doubles interval on consecutive errors
- **Jitter**: ±25% randomization prevents thundering herd
- **Auto-recovery**: Resets to fast polling on success

**Benefits**:
- Reduced server load during network issues
- Prevents rate limiting
- Faster response when healthy (still 500ms)
- Distributed load across multiple extension instances

**Backoff Example**:
```
Attempt 1: 500ms   (success) ✅
Attempt 2: 500ms   (error)   ❌ → backoff to 1000ms
Attempt 3: 1000ms  (error)   ❌ → backoff to 2000ms
Attempt 4: 2000ms  (error)   ❌ → backoff to 4000ms
...
Max:      30000ms (error)   ❌ → stays at 30s
Recovery: 500ms    (success) ✅ → resets to fast
```

---

### 5. Mass Action Confirmation

**Issue**: Users could accidentally trash/restore dozens of folders with no confirmation, leading to bulk operations they didn't intend.

**Fix**: (`fileWatcher.ts`)
- **Threshold detection**: Triggers when >5 folder actions queued
- **Modal confirmation**: Shows count and action type
- **Cancel all**: Single button cancels all pending operations
- **Per-action debouncing**: Individual folder cooldowns still apply

**Benefits**:
- Prevents accidental bulk operations
- Clear user intent confirmation
- Easy to cancel if mistake detected
- Doesn't interfere with normal 1-5 folder operations

**Confirmation Dialog**:
```
⚠️ Bulk Operation Detected

12 folders will be trashed in WordPress.

Continue?

[Yes, Continue]  [Cancel All]
```

---

## Security Best Practices

### For Users

1. **Always use HTTPS in production**
   - Only use HTTP for local development (localhost)
   - Configure SSL certificate for staging/production sites

2. **Review protocol handler prompts**
   - When asked to open files outside workspace, verify the path
   - Cancel if you don't recognize the file location

3. **Keep extension updated**
   - Security fixes are released promptly
   - Enable auto-updates in VS Code

4. **Protect your auth token**
   - Don't share token or paste in public forums
   - Regenerate token if compromised
   - Use different tokens per device/team member

### For Developers

1. **Path validation patterns**
   - Always check workspace boundaries for file operations
   - Use `vscode.workspace.workspaceFolders` for validation
   - Require explicit user confirmation for out-of-workspace access

2. **Network security**
   - Validate HTTPS for production connections
   - Allow localhost exception for development
   - Log security decisions for audit trail

3. **Error handling**
   - Implement exponential backoff for polling
   - Add jitter to prevent thundering herd
   - Show user-friendly error messages

4. **User confirmations**
   - Use modal dialogs for destructive operations
   - Show clear consequences of actions
   - Provide cancel options for bulk operations

---

## Testing Security Features

### Protocol Handler Security

Test that files outside workspace require confirmation:

1. Trigger protocol from browser: `skylit://jump?file=/etc/hosts&line=1`
2. Should show security warning modal
3. Verify "Cancel" prevents file from opening

### HTTP Warning

Test HTTPS enforcement:

1. Set site URL to `http://example.com` (no HTTPS)
2. Attempt to connect
3. Should show security warning about cleartext transmission

### Mass Action Protection

Test bulk operation confirmation:

1. Select 10+ folders in file explorer
2. Move all to `_trash/` folder
3. Should show confirmation dialog with count

### Polling Backoff

Test error recovery:

1. Disconnect WordPress (kill server)
2. Watch output channel - should see increasing intervals
3. Restart WordPress
4. Polling should recover to fast 500ms

---

## Compatibility

**Requires Plugin Version**: 4.9.66 or higher
- Token validation endpoint returns minimal response
- All REST endpoints support new security model

**VS Code Version**: 1.80.0 or higher
- Uses modal dialogs (requires modern VS Code)
- FileSystemWatcher API for remote workspaces

**Backward Compatibility**: ✅
- Works with older plugin versions (graceful degradation)
- HTTP still works (with warning)
- No breaking changes to existing workflows

---

## Security Audit Trail

All security-related decisions are logged to the Output panel:

```
⚠️ Security Warning: Connecting over HTTP
✅ User acknowledged HTTP security risk and continued
⚠️ File outside workspace: /path/to/file.txt
✅ User approved opening file outside workspace
⚠️ Jump polling error (3 consecutive). Backing off to 4000ms
✅ User confirmed bulk trash operation (12 folders)
```

Enable debug output in settings for detailed audit trail.

---

## Reporting Security Issues

If you discover a security vulnerability:

1. **Do NOT** open a public GitHub issue
2. Email security concerns privately to the maintainer
3. Include:
   - Extension version
   - Steps to reproduce
   - Potential impact assessment
   - Suggested fix (if any)

We aim to respond within 48 hours and release fixes promptly.

---

## Future Security Enhancements

Planned for future releases:

1. **Token Expiry** - Optional 30-day token expiration
2. **Token Scopes** - Per-endpoint capability restrictions
3. **Rate Limiting** - Client-side rate limit tracking
4. **Audit Logging** - Structured security event logs
5. **CSP Headers** - Content Security Policy validation

---

## Credits

Security audit and fixes implemented: January 2026

Based on comprehensive security review covering:
- Protocol handler vulnerabilities
- Network security (HTTPS/HTTP)
- Token management
- Polling behavior
- Bulk operations
- Error handling
- PII protection

All critical and high-priority issues addressed in v1.11.0.
