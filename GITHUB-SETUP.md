# Setting Up GitHub Repository for Skylit.DEV I/O Extension

Your extension has been initialized as a separate Git repository. Follow these steps to push it to GitHub:

## Step 1: Create GitHub Repository

1. Go to https://github.com/new
2. Fill in the details:
   - **Repository name**: `skylit-dev-extension` (or your preferred name)
   - **Description**: "VS Code/Cursor extension for instant WordPress Gutenberg sync. Solves WP Cron unreliability on local development."
   - **Visibility**: ✅ Public
   - **Initialize repository**: ❌ Do NOT add README, .gitignore, or license (we already have these)
3. Click "Create repository"

## Step 2: Connect and Push to GitHub

After creating the repo, GitHub will show you commands. Use these:

```bash
cd "c:\Users\osman\OneDrive\Documents\Git-repos\Plugins\SKY-UI\app\public\wp-content\plugins\skylit-dev-ide-extension"

# Add the remote (replace USERNAME with your GitHub username)
git remote add origin https://github.com/USERNAME/skylit-dev-extension.git

# Rename branch to main (if needed)
git branch -M main

# Push to GitHub
git push -u origin main
```

## Step 3: Update package.json

After creating the repo, update the repository URL in `package.json`:

```json
"repository": {
  "type": "git",
  "url": "https://github.com/USERNAME/skylit-dev-extension"
}
```

Then commit and push:

```bash
git add package.json
git commit -m "Update repository URL"
git push
```

## Step 4: Configure GitHub Repository Settings

1. Go to your repo on GitHub: `https://github.com/USERNAME/skylit-dev-extension`
2. Click **Settings** tab
3. In the "About" section (top right), add:
   - **Description**: "VS Code/Cursor extension for instant WordPress Gutenberg sync"
   - **Website**: https://skylit.dev (or your website)
   - **Topics**: Add tags like: `wordpress`, `vscode-extension`, `gutenberg`, `sync`, `cursor`

## Step 5: Create GitHub Release (Optional but Recommended)

When you publish to marketplace, also create a GitHub release:

```bash
# Tag the current version
git tag v1.2.0
git push origin v1.2.0
```

Then on GitHub:
1. Go to "Releases" → "Create a new release"
2. Choose tag: `v1.2.0`
3. Release title: `Skylit Dev I/O v1.2.0`
4. Description: Copy from CHANGELOG.md
5. Attach the `.vsix` file (optional)
6. Click "Publish release"

## Alternative: Use GitHub CLI (Faster)

If you have GitHub CLI installed:

```bash
cd "c:\Users\osman\OneDrive\Documents\Git-repos\Plugins\SKY-UI\app\public\wp-content\plugins\skylit-dev-ide-extension"

# Create repo and push in one command
gh repo create skylit-dev-extension --public --source=. --remote=origin --push

# Set description
gh repo edit --description "VS Code/Cursor extension for instant WordPress Gutenberg sync"
```

## What's Already Done

✅ Git repository initialized in extension folder
✅ Initial commit created with all files
✅ .gitignore configured (excludes node_modules, out/, *.vsix)
✅ All source files staged and committed
✅ Branch set to `main`

## Next Steps

1. ✅ Create GitHub repository (public)
2. ✅ Add remote origin
3. ✅ Push to GitHub
4. ✅ Update package.json with actual repo URL
5. ✅ Ready to publish to marketplace!

---

**Note**: This is a separate repository from your main plugin. They are independent:
- **Main plugin repo**: `SKY-UI/app/public/wp-content/plugins/` (all plugins)
- **Extension repo**: Standalone at GitHub (just the extension)
