# Publishing Summary - v1.13.0

## ✅ Successfully Published to Both Marketplaces!

### 📅 Published: February 5, 2026

---

## 🎯 Published To:

### 1. VS Code Marketplace ✅

- **URL:** https://marketplace.visualstudio.com/items?itemName=dimy-osman.skylit-dev-io
- **Status:** Live
- **Token:** Saved in `.tokens` file

### 2. Open VSX Registry ✅

- **URL:** https://open-vsx.org/extension/dimy-osman/skylit-dev-io
- **Status:** Live
- **Token:** Saved in `.tokens` file

---

## 📦 Version Details

**Version:** 1.13.0  
**Package Size:** 461.06 KB (472,127 bytes)  
**Files:** 20 files total

---

## 🚀 What's New in v1.13.0

### ✨ New Feature: Manage Post Command

**Right-click on any post folder → "Skylit: Manage Post"**

#### Available Actions:

1. **📝 Change Status**

      - Publish, Draft, Pending Review, Private
      - Schedule for later with date/time picker

2. **🔤 Rename Slug**

      - Change URL slug (e.g., `my-page` → `new-page`)
      - Validates format & checks conflicts
      - Auto-renames folder

3. **📌 Rename Title**

      - Quick title updates

4. **📅 Schedule Post**
      - Set future publish date/time
      - Format: `YYYY-MM-DD HH:MM:SS`
      - Auto-publishes at scheduled time

### 🐛 Bug Fix

- **Fixed double prompt on delete** - Only one confirmation dialog now appears when deleting via command

---

## 💾 Tokens Saved

Tokens are securely saved in `.tokens` file (gitignored)

### Quick Publish for Next Release:

```powershell
# Option 1: Use the publish script
.\publish.ps1

# Option 2: Manual commands
npx vsce publish -p <VSCE_TOKEN>
npx ovsx publish -p <OVSX_TOKEN>
```

---

## 📊 Marketplace Links

- **VS Code Hub:** https://marketplace.visualstudio.com/manage/publishers/dimy-osman/extensions/skylit-dev-io/hub
- **Open VSX Dashboard:** https://open-vsx.org/user-settings/extensions

---

## 🔐 Security Notes

- ✅ `.tokens` file added to `.gitignore`
- ✅ Tokens will NOT be committed to git
- ✅ Backup tokens in secure password manager
- ⚠️ Tokens expire - regenerate when needed

---

## 📝 Next Steps for Future Releases

1. Update version in `package.json`
2. Update `CHANGELOG.md`
3. Run `npm run package` to build
4. Run `.\publish.ps1` to publish to both marketplaces
5. Or manually publish with tokens from `.tokens` file

---

**Published successfully! 🎉**
