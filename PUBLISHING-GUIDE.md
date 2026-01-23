# Publishing Skylit Dev I/O to VS Code Marketplace

## Prerequisites

✅ **Completed:**
- [x] Extension built and compiled
- [x] `package.json` configured
- [x] `README.md` comprehensive documentation
- [x] `CHANGELOG.md` version history
- [x] `LICENSE` file (GPL-2.0)
- [x] Icon file (`media/icon.png`)
- [x] `.vscodeignore` file created
- [x] Version bumped to 1.2.0

⚠️ **Still Required:**

1. **Valid GitHub Repository**
   - Current: `https://github.com/skylit/skylit-dev-extension`
   - Action: Create this repository and push code
   - Update `package.json` if URL changes

2. **Publisher Account Setup**
   - Go to: https://marketplace.visualstudio.com/manage
   - Sign in with Microsoft account
   - Create publisher ID (currently set as "skylit")
   - Get Personal Access Token (PAT) from Azure DevOps

3. **Icon Verification**
   - Icon must be at least 128x128 pixels
   - Verify `media/icon.png` meets size requirements

## Steps to Publish

### 1. Install vsce (VS Code Extension Manager)

```bash
npm install -g @vscode/vsce
```

### 2. Create Publisher Account

1. Go to https://marketplace.visualstudio.com/manage
2. Click "Create Publisher"
3. Enter publisher details:
   - **Publisher ID**: `skylit` (or choose different)
   - **Display Name**: Skylit or Skylit.DEV
   - **Email**: Your contact email

### 3. Get Personal Access Token (PAT)

1. Go to: https://dev.azure.com/[your-org]/_usersSettings/tokens
2. Click "New Token"
3. Set:
   - **Name**: VS Code Marketplace Publishing
   - **Organization**: All accessible organizations
   - **Scopes**: Custom defined → Marketplace → Manage
   - **Expiration**: 90 days (or longer)
4. Copy the token (save it securely!)

### 4. Login with vsce

```bash
vsce login skylit
# Paste your PAT when prompted
```

### 5. Package the Extension

```bash
cd skylit-dev-ide-extension
vsce package
```

This creates `skylit-dev-io-1.2.0.vsix`

### 6. Test the Package Locally

Install in VS Code:
```bash
code --install-extension skylit-dev-io-1.2.0.vsix
```

Or in Cursor:
- Extensions → "..." menu → "Install from VSIX"
- Select the .vsix file

### 7. Publish to Marketplace

```bash
vsce publish
```

Or publish specific version:
```bash
vsce publish 1.2.0
```

Or publish the .vsix file:
```bash
vsce publish skylit-dev-io-1.2.0.vsix
```

## Post-Publishing

### Update Repository

If you change the GitHub URL in package.json, update it and republish:

```bash
# Update package.json repository URL
vsce publish patch  # Bumps to 1.2.1
```

### Monitor Reviews & Issues

- Check marketplace page: https://marketplace.visualstudio.com/items?itemName=skylit.skylit-dev-io
- Monitor GitHub issues
- Respond to user reviews

## Updating the Extension

### For bug fixes (1.2.0 → 1.2.1):
```bash
vsce publish patch
```

### For new features (1.2.0 → 1.3.0):
```bash
vsce publish minor
```

### For breaking changes (1.2.0 → 2.0.0):
```bash
vsce publish major
```

## Troubleshooting

### "Publisher 'skylit' not found"
- Create publisher account first
- Verify you're logged in: `vsce ls-publishers`

### "Repository URL not found"
- Make sure GitHub repo exists and is public
- Push all code before publishing

### Package too large
- Check `.vscodeignore` is excluding unnecessary files
- Run `vsce ls` to see what files will be included

### Icon issues
- Icon must be PNG format
- Minimum 128x128 pixels
- Square aspect ratio recommended

## Current Package Details

- **Name**: skylit-dev-io
- **Display Name**: Skylit.DEV I/O - WordPress Sync
- **Publisher**: skylit
- **Version**: 1.2.0
- **License**: GPL-2.0-or-later
- **Engine**: VS Code 1.80.0+

## Next Steps

1. ✅ Create GitHub repository at specified URL
2. ✅ Create publisher account "skylit" on marketplace
3. ✅ Get PAT from Azure DevOps
4. ✅ Run `vsce package` to create .vsix
5. ✅ Test locally before publishing
6. ✅ Run `vsce publish` when ready

---

**Note**: First-time publishing can take 5-10 minutes for marketplace review. Subsequent updates are usually instant.
