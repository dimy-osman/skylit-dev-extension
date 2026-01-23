/**
 * File Watcher
 * Monitors dev folder for file changes and triggers sync
 * Also watches for folder movements to/from _trash/ directories
 */

import * as vscode from 'vscode';
import * as chokidar from 'chokidar';
import * as fs from 'fs';
import * as path from 'path';
import { RestClient } from './restClient';
import { StatusBar } from './statusBar';

export class FileWatcher {
    private watcher: chokidar.FSWatcher | null = null;
    private trashWatcher: chokidar.FSWatcher | null = null;
    private themeWatcher: chokidar.FSWatcher | null = null; // Bi-directional: watch theme folder
    private newFolderWatcher: chokidar.FSWatcher | null = null; // Watch for new folders in post-types
    private metadataWatcher: chokidar.FSWatcher | null = null; // Watch for JSON metadata changes
    private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
    private folderActionTimers: Map<string, NodeJS.Timeout> = new Map();
    private newFolderTimers: Map<string, NodeJS.Timeout> = new Map(); // Debounce new folder detection
    private lastSyncTime: Map<string, number> = new Map();
    private lastFolderActionTime: Map<number, number> = new Map();
    private lastThemeSyncTime: Map<string, number> = new Map(); // Track theme file syncs
    private processedNewFolders: Set<string> = new Set(); // Track folders we've already processed
    private pendingRenames: Map<number, { oldPath: string; oldSlug: string; timestamp: number }> = new Map(); // Track folder renames
    private metadataCache: Map<number, { slug: string; title: string; status: string }> = new Map(); // Cache metadata for change detection
    private metadataSyncCooldown: Map<number, number> = new Map(); // Cooldown for metadata syncs
    private devFolder: string;
    private themePath: string | null = null; // Theme folder path (fetched from WordPress)
    private restClient: RestClient;
    private statusBar: StatusBar;
    private outputChannel: vscode.OutputChannel;
    private debounceMs: number = 500;
    private folderActionDebounceMs: number = 1000; // Debounce folder actions
    private folderActionCooldownMs: number = 5000; // Don't re-process same post within 5 seconds
    private syncCooldownMs: number = 3000; // Don't re-sync same file within 3 seconds
    private themeSyncCooldownMs: number = 3000; // Cooldown for theme → dev sync
    private newFolderDebounceMs: number = 2000; // Wait for HTML file to be created
    private renameCooldownMs: number = 2000; // Time window to match unlink+add as rename

    constructor(
        devFolder: string,
        restClient: RestClient,
        statusBar: StatusBar,
        outputChannel: vscode.OutputChannel
    ) {
        this.devFolder = devFolder;
        this.restClient = restClient;
        this.statusBar = statusBar;
        this.outputChannel = outputChannel;

        // Get debounce setting
        const config = vscode.workspace.getConfiguration('skylit');
        this.debounceMs = config.get<number>('debounceMs', 500);
    }

    /**
     * Start watching files
     */
    async start() {
        this.outputChannel.appendLine(`👀 Starting file watcher for: ${this.devFolder}`);

        // Main watcher for ALL file content changes (dynamic - watches everything except excluded)
        this.watcher = chokidar.watch(
            `${this.devFolder}`,
            {
                ignored: [
                    /(^|[\/\\])\../, // Ignore dotfiles
                    '**/node_modules/**',
                    '**/.git/**',
                    '**/.vscode/**',
                    '**/.cursor/**',
                    '**/post-types/**' // Handled separately by Gutenberg sync
                ],
                ignoreInitial: true,
                persistent: true,
                depth: 10, // Watch deeply nested folders
                awaitWriteFinish: {
                    stabilityThreshold: 300,
                    pollInterval: 100
                }
            }
        );

        // Listen for file changes
        this.watcher.on('change', (filePath) => {
            this.outputChannel.appendLine(`📝 File changed: ${filePath}`);
            
            // Normalize path for cross-platform
            const normalizedPath = filePath.replace(/\\/g, '/');
            const devFolderNormalized = this.devFolder.replace(/\\/g, '/');
            
            // Skip if this is in post-types folder (handled by Gutenberg sync)
            if (normalizedPath.includes('/post-types/')) {
                this.handleFileChange(filePath);
                return;
            }
            
            // Everything else is a theme file - sync to theme folder
            // This includes: style.css, functions.php, theme.json, templates/, parts/, 
            // patterns/, assets/, includes/, and any custom folders
            this.handleThemeFileChange(filePath);
        });

        this.watcher.on('error', (error) => {
            this.outputChannel.appendLine(`❌ File watcher error: ${error.message}`);
        });

        // Separate watcher for _trash folder movements
        // We need to watch ALL directories to detect when folders move to/from _trash
        this.trashWatcher = chokidar.watch(
            this.devFolder,
            {
                ignored: [
                    /(^|[\/\\])\../, // Ignore dotfiles
                    '**/node_modules/**',
                    '**/.git/**',
                    '**/assets/**' // Ignore assets folder
                ],
                ignoreInitial: true,
                persistent: true,
                depth: 4, // Watch up to 4 levels deep (e.g., post-types/pages/_trash/slug_123)
                // Don't use awaitWriteFinish for directories - we want immediate detection
            }
        );

        // Listen for folders appearing IN _trash directories (= folder was trashed)
        this.trashWatcher.on('addDir', (dirPath) => {
            this.handlePotentialTrashAction(dirPath, 'add');
        });

        // Listen for folders disappearing FROM _trash directories (= folder was restored)
        this.trashWatcher.on('unlinkDir', (dirPath) => {
            this.handlePotentialTrashAction(dirPath, 'unlink');
        });

        this.trashWatcher.on('error', (error) => {
            this.outputChannel.appendLine(`❌ Trash watcher error: ${error.message}`);
        });

        this.outputChannel.appendLine('✅ File watcher started (including _trash folder monitoring)');

        // Start bi-directional theme watcher
        await this.startThemeWatcher();
        
        // Start new folder watcher for creating posts from IDE
        await this.startNewFolderWatcher();
        
        // Start metadata watcher for JSON → WordPress sync
        await this.startMetadataWatcher();
    }
    
    /**
     * Start watching for new folders in post-types directory
     * When a new folder is created without _ID suffix, create a WordPress post
     */
    private async startNewFolderWatcher() {
        const postTypesPath = path.join(this.devFolder, 'post-types');
        
        if (!fs.existsSync(postTypesPath)) {
            this.outputChannel.appendLine('⚠️ post-types folder not found, new folder watcher disabled');
            return;
        }
        
        this.outputChannel.appendLine(`👀 Starting new folder watcher for: ${postTypesPath}`);
        
        // First, scan for existing folders without IDs (created before extension started)
        await this.scanForNewFolders(postTypesPath);
        
        this.newFolderWatcher = chokidar.watch(postTypesPath, {
            ignored: [
                /(^|[\/\\])\../, // Ignore dotfiles
                '**/_trash/**',  // Ignore trash folders
                '**/block-styles/**' // Ignore block-styles subdirs
            ],
            ignoreInitial: true, // Don't process existing folders
            persistent: true,
            depth: 2, // Watch post-types/pages/new-folder level
        });
        
        // Listen for new folders being created
        this.newFolderWatcher.on('addDir', (dirPath) => {
            this.outputChannel.appendLine(`🔔 [Watcher] addDir event: ${path.basename(dirPath)}`);
            
            // Check if this is a rename completion (folder with _ID reappearing)
            const postId = this.extractPostIdFromPath(dirPath);
            if (postId && this.pendingRenames.has(postId)) {
                this.handleRenameComplete(dirPath, postId);
            } else {
                this.handlePotentialNewFolder(dirPath);
            }
        });
        
        // Listen for folders being removed (potential rename start)
        this.newFolderWatcher.on('unlinkDir', (dirPath) => {
            this.outputChannel.appendLine(`🔔 [Watcher] unlinkDir event: ${path.basename(dirPath)}`);
            this.handlePotentialRenameStart(dirPath);
        });
        
        // Also listen for HTML files being added (in case folder was created first, then file)
        this.newFolderWatcher.on('add', (filePath) => {
            if (filePath.endsWith('.html')) {
                this.outputChannel.appendLine(`🔔 [Watcher] HTML file added: ${path.basename(filePath)}`);
                const folderPath = path.dirname(filePath);
                this.handlePotentialNewFolder(folderPath);
            }
        });
        
        this.newFolderWatcher.on('error', (error) => {
            this.outputChannel.appendLine(`❌ New folder watcher error: ${error.message}`);
        });
        
        this.outputChannel.appendLine('✅ New folder watcher started');
    }
    
    /**
     * Start watching for changes in JSON metadata files
     * When slug/title/status changes in JSON, sync to WordPress and rename files if needed
     */
    private async startMetadataWatcher() {
        const metadataPath = path.join(this.devFolder, '.skylit', 'metadata');
        
        if (!fs.existsSync(metadataPath)) {
            this.outputChannel.appendLine('⚠️ .skylit/metadata folder not found, metadata watcher disabled');
            return;
        }
        
        this.outputChannel.appendLine(`👀 Starting metadata watcher for: ${metadataPath}`);
        
        // Load initial metadata cache
        await this.loadMetadataCache(metadataPath);
        
        this.metadataWatcher = chokidar.watch(`${metadataPath}/*.json`, {
            ignoreInitial: true,
            persistent: true,
            awaitWriteFinish: {
                stabilityThreshold: 500,
                pollInterval: 100
            }
        });
        
        this.metadataWatcher.on('change', (filePath) => {
            this.handleMetadataChange(filePath);
        });
        
        this.metadataWatcher.on('error', (error) => {
            this.outputChannel.appendLine(`❌ Metadata watcher error: ${error.message}`);
        });
        
        this.outputChannel.appendLine('✅ Metadata watcher started (JSON → WordPress sync enabled)');
    }
    
    /**
     * Load all metadata files into cache for change detection
     */
    private async loadMetadataCache(metadataPath: string) {
        try {
            const files = fs.readdirSync(metadataPath).filter(f => f.endsWith('.json'));
            
            for (const file of files) {
                const filePath = path.join(metadataPath, file);
                const postId = parseInt(path.basename(file, '.json'), 10);
                
                if (isNaN(postId)) continue;
                
                try {
                    const content = fs.readFileSync(filePath, 'utf8');
                    const data = JSON.parse(content);
                    
                    this.metadataCache.set(postId, {
                        slug: data.slug || '',
                        title: data.title || '',
                        status: data.status || ''
                    });
                } catch (e) {
                    // Skip invalid JSON files
                }
            }
            
            this.outputChannel.appendLine(`📦 Loaded ${this.metadataCache.size} metadata files into cache`);
        } catch (error: any) {
            this.outputChannel.appendLine(`⚠️ Could not load metadata cache: ${error.message}`);
        }
    }
    
    /**
     * Handle changes to a metadata JSON file
     */
    private async handleMetadataChange(filePath: string) {
        const fileName = path.basename(filePath);
        const postId = parseInt(path.basename(fileName, '.json'), 10);
        
        if (isNaN(postId)) {
            return;
        }
        
        // Check cooldown
        const lastSync = this.metadataSyncCooldown.get(postId) || 0;
        if (Date.now() - lastSync < 2000) {
            return; // Skip if recently synced (prevent loops)
        }
        
        this.outputChannel.appendLine(`🔔 [Metadata] Change detected: ${fileName}`);
        
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const newData = JSON.parse(content);
            
            const oldData = this.metadataCache.get(postId);
            
            // Check what changed
            const changes: { slug?: string; title?: string; status?: string } = {};
            let hasChanges = false;
            
            if (oldData) {
                if (newData.slug && newData.slug !== oldData.slug) {
                    changes.slug = newData.slug;
                    hasChanges = true;
                    this.outputChannel.appendLine(`   📝 Slug changed: ${oldData.slug} → ${newData.slug}`);
                }
                if (newData.title && newData.title !== oldData.title) {
                    changes.title = newData.title;
                    hasChanges = true;
                    this.outputChannel.appendLine(`   📝 Title changed: ${oldData.title} → ${newData.title}`);
                }
                if (newData.status && newData.status !== oldData.status) {
                    changes.status = newData.status;
                    hasChanges = true;
                    this.outputChannel.appendLine(`   📝 Status changed: ${oldData.status} → ${newData.status}`);
                    this.outputChannel.appendLine(`   ℹ️  This change came from WordPress (not IDE)`);
                }
            } else {
                // First time seeing this file, just cache it
                this.metadataCache.set(postId, {
                    slug: newData.slug || '',
                    title: newData.title || '',
                    status: newData.status || ''
                });
                return;
            }
            
            if (!hasChanges) {
                // Update cache even if no tracked changes (other fields may have changed)
                this.metadataCache.set(postId, {
                    slug: newData.slug || oldData.slug,
                    title: newData.title || oldData.title,
                    status: newData.status || oldData.status
                });
                return;
            }
            
            // Set cooldown
            this.metadataSyncCooldown.set(postId, Date.now());
            
            // If slug changed, rename folder and files first
            if (changes.slug) {
                await this.renamePostFiles(postId, oldData.slug, changes.slug, newData.postType || 'page');
            }
            
            // Sync changes to WordPress
            this.statusBar.showSyncing('Syncing metadata...');
            
            try {
                const response = await this.restClient.updateFromMetadata(postId, changes);
                
                if (response.success) {
                    this.statusBar.showSuccess('Metadata synced');
                    
                    // Update cache with new values
                    this.metadataCache.set(postId, {
                        slug: changes.slug || oldData.slug,
                        title: changes.title || oldData.title,
                        status: changes.status || oldData.status
                    });
                    
                    // No popup notification - status bar is enough
                } else {
                    this.outputChannel.appendLine(`⚠️ Metadata sync failed: ${response.error}`);
                    // Only log to output, no popup
                }
            } catch (error: any) {
                this.outputChannel.appendLine(`❌ Metadata sync error: ${error.message}`);
                // Only show error popups for critical errors
            }
            
        } catch (error: any) {
            this.outputChannel.appendLine(`❌ Failed to parse metadata: ${error.message}`);
        }
    }
    
    /**
     * Rename post folder and files when slug changes in metadata
     */
    private async renamePostFiles(postId: number, oldSlug: string, newSlug: string, postType: string) {
        this.outputChannel.appendLine(`📂 Renaming files for post ${postId}: ${oldSlug} → ${newSlug}`);
        
        try {
            // Build paths
            const postTypeFolderName = postType + 's'; // e.g., 'page' → 'pages'
            const postTypePath = path.join(this.devFolder, 'post-types', postTypeFolderName);
            
            const oldFolderName = `${oldSlug}_${postId}`;
            const newFolderName = `${newSlug}_${postId}`;
            
            const oldFolderPath = path.join(postTypePath, oldFolderName);
            const newFolderPath = path.join(postTypePath, newFolderName);
            
            // Check if old folder exists
            if (!fs.existsSync(oldFolderPath)) {
                this.outputChannel.appendLine(`⚠️ Old folder not found: ${oldFolderName}`);
                return;
            }
            
            // Check if new folder already exists
            if (fs.existsSync(newFolderPath)) {
                this.outputChannel.appendLine(`⚠️ New folder already exists: ${newFolderName}`);
                return;
            }
            
            // Rename files inside the folder first
            const oldHtmlPath = path.join(oldFolderPath, `${oldFolderName}.html`);
            const newHtmlPath = path.join(oldFolderPath, `${newFolderName}.html`);
            const oldCssPath = path.join(oldFolderPath, `${oldFolderName}.css`);
            const newCssPath = path.join(oldFolderPath, `${newFolderName}.css`);
            
            if (fs.existsSync(oldHtmlPath)) {
                fs.renameSync(oldHtmlPath, newHtmlPath);
                this.outputChannel.appendLine(`   ✓ HTML: ${oldFolderName}.html → ${newFolderName}.html`);
            }
            
            if (fs.existsSync(oldCssPath)) {
                fs.renameSync(oldCssPath, newCssPath);
                this.outputChannel.appendLine(`   ✓ CSS: ${oldFolderName}.css → ${newFolderName}.css`);
            }
            
            // Rename the folder
            fs.renameSync(oldFolderPath, newFolderPath);
            this.outputChannel.appendLine(`   ✓ Folder: ${oldFolderName} → ${newFolderName}`);
            
            // Update JSON's file path to stay in sync
            const newFilePath = `post-types/${postTypeFolderName}/${newFolderName}/${newFolderName}.html`;
            await this.updateJsonMetadataFilePath(postId, newFilePath);
            
            // Handle open editors - close old file and open new file
            await this.handleFileRename(oldFolderPath, `post-types/${postTypeFolderName}/${newFolderName}`, postId);
            
        } catch (error: any) {
            this.outputChannel.appendLine(`❌ Failed to rename files: ${error.message}`);
        }
    }
    
    /**
     * Update only the file path in JSON metadata (for internal updates that shouldn't trigger full sync)
     */
    private async updateJsonMetadataFilePath(postId: number, newFilePath: string) {
        const metadataPath = path.join(this.devFolder, '.skylit', 'metadata', `${postId}.json`);
        
        if (!fs.existsSync(metadataPath)) {
            return;
        }
        
        try {
            // Set cooldown to prevent triggering another sync
            this.metadataSyncCooldown.set(postId, Date.now());
            
            const content = fs.readFileSync(metadataPath, 'utf8');
            const metadata = JSON.parse(content);
            
            metadata.file = newFilePath;
            metadata.lastExported = new Date().toISOString().replace('T', ' ').substring(0, 19);
            
            fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 4));
            this.outputChannel.appendLine(`   ✓ JSON file path updated`);
            
        } catch (error: any) {
            this.outputChannel.appendLine(`⚠️ Could not update JSON file path: ${error.message}`);
        }
    }
    
    /**
     * Extract post ID from folder path (e.g., "about-us_123" → 123)
     */
    private extractPostIdFromPath(dirPath: string): number | null {
        const folderName = path.basename(dirPath);
        const match = folderName.match(/_(\d+)$/);
        return match ? parseInt(match[1], 10) : null;
    }
    
    /**
     * Extract slug from folder name (e.g., "about-us_123" → "about-us")
     */
    private extractSlugFromFolderName(folderName: string): string {
        return folderName.replace(/_\d+$/, '');
    }
    
    /**
     * Handle potential rename start (folder with _ID removed)
     */
    private handlePotentialRenameStart(dirPath: string) {
        const normalizedPath = dirPath.replace(/\\/g, '/');
        const folderName = path.basename(normalizedPath);
        const postId = this.extractPostIdFromPath(dirPath);
        
        // Only track folders with _ID suffix (existing posts)
        if (!postId) {
            return;
        }
        
        // Don't track trash operations
        if (normalizedPath.includes('/_trash/')) {
            return;
        }
        
        const oldSlug = this.extractSlugFromFolderName(folderName);
        
        this.outputChannel.appendLine(`🔄 Folder removed (potential rename): ${folderName}`);
        
        // Store for matching with subsequent addDir
        this.pendingRenames.set(postId, {
            oldPath: normalizedPath,
            oldSlug: oldSlug,
            timestamp: Date.now()
        });
        
        // Clean up after timeout (if no addDir follows, it was a delete, not rename)
        setTimeout(() => {
            if (this.pendingRenames.has(postId)) {
                const pending = this.pendingRenames.get(postId)!;
                if (Date.now() - pending.timestamp >= this.renameCooldownMs) {
                    this.pendingRenames.delete(postId);
                    this.outputChannel.appendLine(`🗑️ Folder delete confirmed (no rename): ${folderName}`);
                }
            }
        }, this.renameCooldownMs + 100);
    }
    
    /**
     * Handle rename completion (folder with same _ID reappeared with new name)
     */
    private async handleRenameComplete(dirPath: string, postId: number) {
        const normalizedPath = dirPath.replace(/\\/g, '/');
        const folderName = path.basename(normalizedPath);
        const newSlug = this.extractSlugFromFolderName(folderName);
        
        const pending = this.pendingRenames.get(postId);
        if (!pending) {
            return;
        }
        
        // Clear the pending rename
        this.pendingRenames.delete(postId);
        
        // Check if slug actually changed
        if (pending.oldSlug === newSlug) {
            this.outputChannel.appendLine(`🔄 Folder moved but slug unchanged: ${folderName}`);
            return;
        }
        
        this.outputChannel.appendLine(`📝 Folder renamed: ${pending.oldSlug}_${postId} → ${newSlug}_${postId}`);
        this.statusBar.showSyncing('Updating slug...');
        
        try {
            const response = await this.restClient.updatePostSlug(postId, newSlug);
            
            if (response.success) {
                this.statusBar.showSuccess('Slug updated');
                this.outputChannel.appendLine(`✅ WordPress slug updated: ${pending.oldSlug} → ${newSlug}`);
                
                // Update JSON metadata to stay in sync with folder
                await this.updateJsonMetadata(postId, { slug: newSlug });
                
                // Update local cache
                const cached = this.metadataCache.get(postId);
                if (cached) {
                    cached.slug = newSlug;
                    this.metadataCache.set(postId, cached);
                }
                
                // Show notification
                const config = vscode.workspace.getConfiguration('skylit');
                if (config.get<boolean>('showNotifications', true)) {
                    vscode.window.showInformationMessage(
                        `✅ Slug updated: ${pending.oldSlug} → ${newSlug}`
                    );
                }
            } else {
                this.outputChannel.appendLine(`⚠️ Could not update slug: ${response.error}`);
            }
        } catch (error: any) {
            this.outputChannel.appendLine(`❌ Failed to update slug: ${error.message}`);
            vscode.window.showErrorMessage(`Failed to update slug: ${error.message}`);
        }
    }
    
    /**
     * Update JSON metadata file to stay in sync with folder structure
     */
    private async updateJsonMetadata(postId: number, updates: { slug?: string; title?: string; status?: string; file?: string }) {
        const metadataPath = path.join(this.devFolder, '.skylit', 'metadata', `${postId}.json`);
        
        if (!fs.existsSync(metadataPath)) {
            this.outputChannel.appendLine(`⚠️ Metadata file not found: ${postId}.json`);
            return;
        }
        
        try {
            // Set cooldown to prevent the change from triggering another sync
            this.metadataSyncCooldown.set(postId, Date.now());
            
            const content = fs.readFileSync(metadataPath, 'utf8');
            const metadata = JSON.parse(content);
            
            // Apply updates
            if (updates.slug !== undefined) {
                const oldSlug = metadata.slug;
                metadata.slug = updates.slug;
                
                // Also update the file path to match
                const newFolderName = `${updates.slug}_${postId}`;
                if (metadata.file) {
                    metadata.file = metadata.file.replace(
                        new RegExp(`${oldSlug}_${postId}`, 'g'),
                        newFolderName
                    );
                }
            }
            if (updates.title !== undefined) {
                metadata.title = updates.title;
            }
            if (updates.status !== undefined) {
                metadata.status = updates.status;
            }
            if (updates.file !== undefined) {
                metadata.file = updates.file;
            }
            
            metadata.lastExported = new Date().toISOString().replace('T', ' ').substring(0, 19);
            
            // Write back
            fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 4));
            this.outputChannel.appendLine(`📦 JSON metadata updated: ${postId}.json`);
            
        } catch (error: any) {
            this.outputChannel.appendLine(`❌ Failed to update JSON metadata: ${error.message}`);
        }
    }
    
    /**
     * Handle potential new folder that might need a WordPress post created
     */
    private handlePotentialNewFolder(dirPath: string) {
        const normalizedPath = dirPath.replace(/\\/g, '/');
        const devFolderNormalized = this.devFolder.replace(/\\/g, '/');
        
        // Get relative path from dev folder
        const relativePath = normalizedPath.replace(devFolderNormalized + '/', '');
        
        // Must be in post-types/[type]/[folder] format
        const parts = relativePath.split('/');
        if (parts.length !== 3 || parts[0] !== 'post-types') {
            return; // Not a content folder
        }
        
        const postTypeFolder = parts[1]; // e.g., "pages", "posts"
        const folderName = parts[2];     // e.g., "about-us" or "about-us_123"
        
        // Skip if already has _ID suffix (already linked to a post)
        if (/_\d+$/.test(folderName)) {
            return;
        }
        
        // Skip if in _trash
        if (folderName === '_trash' || relativePath.includes('/_trash/')) {
            return;
        }
        
        // Skip if already processed
        if (this.processedNewFolders.has(normalizedPath)) {
            return;
        }
        
        this.outputChannel.appendLine(`📁 New folder detected: ${relativePath}`);
        
        // Debounce to wait for HTML file to be created
        const debounceKey = `new-folder-${normalizedPath}`;
        if (this.newFolderTimers.has(debounceKey)) {
            clearTimeout(this.newFolderTimers.get(debounceKey)!);
        }
        
        const timer = setTimeout(async () => {
            this.newFolderTimers.delete(debounceKey);
            await this.createPostFromNewFolder(normalizedPath, postTypeFolder, folderName, relativePath);
        }, this.newFolderDebounceMs);
        
        this.newFolderTimers.set(debounceKey, timer);
    }
    
    /**
     * Create a WordPress post from a new folder
     */
    private async createPostFromNewFolder(
        folderPath: string,
        postTypeFolder: string,
        folderName: string,
        relativePath: string
    ) {
        // Check if folder still exists and has HTML file
        if (!fs.existsSync(folderPath)) {
            this.outputChannel.appendLine(`⚠️ Folder no longer exists: ${relativePath}`);
            return;
        }
        
        // Look for HTML file
        const htmlFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.html'));
        if (htmlFiles.length === 0) {
            this.outputChannel.appendLine(`⏳ No HTML file yet in ${relativePath}, will retry when HTML is added...`);
            // Don't add to processedNewFolders - the HTML 'add' event will trigger another attempt
            return;
        }
        
        // Mark as processed to prevent duplicate calls
        this.processedNewFolders.add(folderPath);
        this.outputChannel.appendLine(`✓ HTML file found: ${htmlFiles[0]}`);
        
        // Map folder name to post type
        const postType = this.mapFolderToPostType(postTypeFolder);
        
        this.outputChannel.appendLine(`📄 Creating ${postType} from: ${relativePath}`);
        this.statusBar.showSyncing(`Creating ${postType}...`);
        
        try {
            const response = await this.restClient.createPostFromFolder(relativePath, postType);
            
            if (response.success && response.post_id) {
                this.statusBar.showSuccess(`Created: ${response.title}`);
                this.outputChannel.appendLine(
                    `✅ Created ${postType} "${response.title}" (ID: ${response.post_id})`
                );
                this.outputChannel.appendLine(`   Folder renamed: ${response.old_folder} → ${response.new_folder}`);
                
                // Mark the new folder as processed too (so we don't try to create again)
                if (response.new_folder) {
                    const newFolderPath = this.devFolder.replace(/\\/g, '/') + '/' + response.new_folder;
                    this.processedNewFolders.add(newFolderPath);
                }
                
                // Handle open editors - close old file and open new file
                await this.handleFileRename(folderPath, response.new_folder, response.post_id);
                
                // Show notification
                const config = vscode.workspace.getConfiguration('skylit');
                if (config.get<boolean>('showNotifications', true)) {
                    vscode.window.showInformationMessage(
                        `✅ Created ${postType}: ${response.title} (ID: ${response.post_id})`
                    );
                }
            } else {
                this.outputChannel.appendLine(`⚠️ Could not create post: ${response.error}`);
                // Remove from processed so it can be retried
                this.processedNewFolders.delete(folderPath);
            }
        } catch (error: any) {
            this.outputChannel.appendLine(`❌ Failed to create post: ${error.message}`);
            this.processedNewFolders.delete(folderPath);
            vscode.window.showErrorMessage(`Failed to create ${postType}: ${error.message}`);
        }
    }
    
    /**
     * Handle file rename in open editors
     * Closes old file if open and opens new file
     */
    private async handleFileRename(oldFolderPath: string, newRelativePath: string | undefined, postId: number) {
        if (!newRelativePath) return;
        
        try {
            // Build paths
            const newFolderPath = path.join(this.devFolder, newRelativePath);
            const newFolderName = path.basename(newFolderPath);
            const newHtmlPath = path.join(newFolderPath, `${newFolderName}.html`);
            
            // Find any open editors with files from the old folder
            const oldFolderPathNormalized = oldFolderPath.replace(/\\/g, '/');
            
            for (const tabGroup of vscode.window.tabGroups.all) {
                for (const tab of tabGroup.tabs) {
                    if (tab.input instanceof vscode.TabInputText) {
                        const uri = tab.input.uri;
                        const uriPath = uri.fsPath.replace(/\\/g, '/');
                        
                        // Check if this file was from the old folder
                        if (uriPath.startsWith(oldFolderPathNormalized)) {
                            this.outputChannel.appendLine(`📂 Closing old file: ${path.basename(uriPath)}`);
                            
                            // Close the old tab
                            await vscode.window.tabGroups.close(tab);
                        }
                    }
                }
            }
            
            // Open the new file
            if (fs.existsSync(newHtmlPath)) {
                this.outputChannel.appendLine(`📂 Opening new file: ${newFolderName}.html`);
                const newUri = vscode.Uri.file(newHtmlPath);
                await vscode.window.showTextDocument(newUri);
            }
        } catch (error: any) {
            this.outputChannel.appendLine(`⚠️ Could not update open editors: ${error.message}`);
        }
    }
    
    /**
     * Map post-types folder name to WordPress post type
     */
    private mapFolderToPostType(folderName: string): string {
        const mappings: Record<string, string> = {
            'pages': 'page',
            'posts': 'post',
            'products': 'product',
            'wp_template': 'wp_template',
            'wp_template_part': 'wp_template_part',
            'wp_block': 'wp_block'
        };
        
        return mappings[folderName] || folderName;
    }
    
    /**
     * Scan post-types directory for existing folders without IDs
     * Creates WordPress posts for any that don't exist yet
     */
    private async scanForNewFolders(postTypesPath: string) {
        this.outputChannel.appendLine('🔍 Scanning for folders without post IDs...');
        
        try {
            // Get all post type subdirectories (pages, posts, etc.)
            const postTypeDirs = fs.readdirSync(postTypesPath, { withFileTypes: true })
                .filter(dirent => dirent.isDirectory() && !dirent.name.startsWith('.') && dirent.name !== '_trash');
            
            let foundCount = 0;
            let createdCount = 0;
            
            for (const postTypeDir of postTypeDirs) {
                const postTypePath = path.join(postTypesPath, postTypeDir.name);
                const postType = this.mapFolderToPostType(postTypeDir.name);
                
                // Get content folders within this post type
                const contentFolders = fs.readdirSync(postTypePath, { withFileTypes: true })
                    .filter(dirent => 
                        dirent.isDirectory() && 
                        !dirent.name.startsWith('.') && 
                        dirent.name !== '_trash' &&
                        dirent.name !== 'block-styles'
                    );
                
                for (const contentFolder of contentFolders) {
                    const folderName = contentFolder.name;
                    const folderPath = path.join(postTypePath, folderName);
                    
                    // Skip if already has _ID suffix
                    if (/_\d+$/.test(folderName)) {
                        continue;
                    }
                    
                    // Check if has HTML file
                    const files = fs.readdirSync(folderPath);
                    const hasHtml = files.some(f => f.endsWith('.html'));
                    
                    if (!hasHtml) {
                        this.outputChannel.appendLine(`   ⏭️ Skipping ${folderName} (no HTML file)`);
                        continue;
                    }
                    
                    foundCount++;
                    this.outputChannel.appendLine(`   📁 Found new folder: ${postTypeDir.name}/${folderName}`);
                    
                    // Build relative path for API call
                    const relativePath = `post-types/${postTypeDir.name}/${folderName}`;
                    
                    // Create the post
                    try {
                        const response = await this.restClient.createPostFromFolder(relativePath, postType);
                        
                        if (response.success && response.post_id) {
                            createdCount++;
                            this.outputChannel.appendLine(
                                `   ✅ Created ${postType} "${response.title}" (ID: ${response.post_id})`
                            );
                            
                            // Mark as processed
                            this.processedNewFolders.add(folderPath.replace(/\\/g, '/'));
                        } else {
                            this.outputChannel.appendLine(`   ⚠️ Could not create: ${response.error}`);
                        }
                    } catch (error: any) {
                        this.outputChannel.appendLine(`   ❌ Error creating post: ${error.message}`);
                    }
                }
            }
            
            if (foundCount === 0) {
                this.outputChannel.appendLine('   ✅ No new folders found (all have post IDs)');
            } else {
                this.outputChannel.appendLine(`🔍 Scan complete: ${createdCount}/${foundCount} posts created`);
                
                // Log to output only, no popup
                if (createdCount > 0) {
                    this.outputChannel.appendLine(`✅ Created ${createdCount} new WordPress post(s) from dev folder`);
                }
            }
        } catch (error: any) {
            this.outputChannel.appendLine(`❌ Scan error: ${error.message}`);
        }
    }

    /**
     * Start watching theme folder for bi-directional sync
     * When theme files change, sync back to dev folder
     */
    private async startThemeWatcher() {
        try {
            // Get theme path from WordPress
            const assetStatus = await this.restClient.getAssetStatus();
            this.themePath = assetStatus.theme_path;

            if (!this.themePath) {
                this.outputChannel.appendLine('⚠️ Could not get theme path, bi-directional sync disabled');
                return;
            }

            this.outputChannel.appendLine(`👀 Starting theme watcher for bi-directional sync: ${this.themePath}`);

            // Watch ALL theme files for bi-directional sync (dynamic)
            this.themeWatcher = chokidar.watch(
                this.themePath,
                {
                    ignored: [
                        /(^|[\/\\])\../, // Ignore dotfiles
                        '**/node_modules/**',
                        '**/.git/**',
                        '**/.vscode/**',
                        '**/.cursor/**'
                    ],
                    ignoreInitial: true,
                    persistent: true,
                    depth: 10, // Watch deeply nested folders
                    awaitWriteFinish: {
                        stabilityThreshold: 300,
                        pollInterval: 100
                    }
                }
            );

            // Listen for theme file changes
            this.themeWatcher.on('change', (filePath) => {
                this.handleThemeAssetChange(filePath);
            });

            // Listen for new theme files
            this.themeWatcher.on('add', (filePath) => {
                this.handleThemeAssetChange(filePath);
            });

            this.themeWatcher.on('error', (error) => {
                this.outputChannel.appendLine(`❌ Theme watcher error: ${error.message}`);
            });

            this.outputChannel.appendLine('✅ Theme watcher started (bi-directional sync enabled)');

        } catch (error: any) {
            this.outputChannel.appendLine(`⚠️ Could not start theme watcher: ${error.message}`);
            this.outputChannel.appendLine('   Bi-directional sync will be disabled');
        }
    }

    /**
     * Handle any theme file change - sync back to dev folder (dynamic)
     */
    private async handleThemeAssetChange(filePath: string) {
        const fileName = path.basename(filePath);
        const normalizedPath = filePath.replace(/\\/g, '/');
        const themePathNormalized = this.themePath?.replace(/\\/g, '/') || '';
        
        // Get relative path from theme folder
        const relativePath = themePathNormalized ? 
            normalizedPath.replace(themePathNormalized + '/', '') : fileName;
        
        // Check cooldown - don't sync if we just synced TO theme (prevent circular sync)
        const now = Date.now();
        const lastSync = this.lastThemeSyncTime.get(normalizedPath) || 0;
        const timeSinceLastSync = now - lastSync;
        
        if (timeSinceLastSync < this.themeSyncCooldownMs) {
            this.outputChannel.appendLine(
                `⏸️ Skipping theme→dev sync (cooldown: ${Math.round((this.themeSyncCooldownMs - timeSinceLastSync) / 1000)}s remaining)`
            );
            return;
        }

        // Determine file type for logging
        let fileType = 'file';
        if (relativePath.startsWith('assets/css/')) fileType = 'CSS';
        else if (relativePath.startsWith('assets/js/')) fileType = 'JS';
        else if (relativePath.startsWith('assets/')) fileType = 'asset';
        else if (relativePath.startsWith('includes/')) fileType = 'PHP include';
        else if (relativePath.startsWith('templates/')) fileType = 'template';
        else if (relativePath.startsWith('parts/')) fileType = 'template part';
        else if (relativePath.startsWith('patterns/')) fileType = 'pattern';
        else if (fileName === 'theme.json') fileType = 'theme config';
        else if (fileName === 'style.css') fileType = 'theme stylesheet';
        else if (fileName === 'functions.php') fileType = 'theme functions';
        
        this.outputChannel.appendLine(`🔄 Theme ${fileType} changed: ${relativePath}, syncing to dev folder...`);

        // Debounce the sync
        const debounceKey = `theme-${normalizedPath}`;
        if (this.debounceTimers.has(debounceKey)) {
            clearTimeout(this.debounceTimers.get(debounceKey)!);
        }

        const timer = setTimeout(async () => {
            this.debounceTimers.delete(debounceKey);
            await this.executeThemeToDevSync(filePath);
        }, this.debounceMs);

        this.debounceTimers.set(debounceKey, timer);
    }

    /**
     * Execute theme → dev folder sync
     */
    private async executeThemeToDevSync(filePath: string) {
        const fileName = path.basename(filePath);
        
        try {
            this.statusBar.showSyncing(`${fileName} → dev`);
            
            // Sync from theme to dev folder
            const response = await this.restClient.syncAssetsFromTheme();
            
            // Record sync time to prevent circular sync
            this.lastThemeSyncTime.set(filePath.replace(/\\/g, '/'), Date.now());
            
            if (response.success) {
                this.statusBar.showSuccess(`${fileName} synced to dev`);
                this.outputChannel.appendLine(`✅ ${fileName} synced from theme to dev folder`);
                
                // Show notification if enabled
                // No popup notification - status bar shows connection
            }
        } catch (error: any) {
            this.outputChannel.appendLine(`❌ Theme→dev sync error: ${error.message}`);
        }
    }

    /**
     * Handle potential trash/restore action from folder movement
     * This is called when a folder is added or removed from the filesystem
     */
    private handlePotentialTrashAction(dirPath: string, eventType: 'add' | 'unlink') {
        // Normalize path separators for cross-platform compatibility
        const normalizedPath = dirPath.replace(/\\/g, '/');
        
        // Check if this is a post type folder (contains _ID suffix pattern)
        const folderName = path.basename(normalizedPath);
        const postIdMatch = folderName.match(/_(\d+)$/);
        
        if (!postIdMatch) {
            // Not a post folder (doesn't have _ID suffix), skip
            return;
        }

        const postId = parseInt(postIdMatch[1], 10);

        // Check if this folder is inside a _trash directory
        const isInTrash = normalizedPath.includes('/_trash/');
        
        // Determine the action based on event type and location
        let action: 'trash' | 'restore' | null = null;

        if (eventType === 'add' && isInTrash) {
            // Folder appeared IN _trash → it was TRASHED
            action = 'trash';
            this.outputChannel.appendLine(`🗑️ Detected folder moved TO trash: ${folderName} (Post ID: ${postId})`);
        } else if (eventType === 'unlink' && isInTrash) {
            // Folder disappeared FROM _trash → it was RESTORED
            action = 'restore';
            this.outputChannel.appendLine(`♻️ Detected folder moved FROM trash: ${folderName} (Post ID: ${postId})`);
        }

        if (!action) {
            // Not a trash-related action, skip
            return;
        }

        // Debounce to prevent double-fires (moving a folder can trigger multiple events)
        this.debounceFolderAction(postId, action);
    }

    /**
     * Debounce folder action to prevent duplicate API calls
     * Moving a folder can trigger multiple filesystem events
     */
    private debounceFolderAction(postId: number, action: 'trash' | 'restore') {
        const key = `${postId}-${action}`;

        // Check cooldown - don't process if we just processed this post
        const now = Date.now();
        const lastActionTime = this.lastFolderActionTime.get(postId) || 0;
        const timeSinceLastAction = now - lastActionTime;

        if (timeSinceLastAction < this.folderActionCooldownMs) {
            this.outputChannel.appendLine(
                `⏸️ Skipping folder action (cooldown: ${Math.round((this.folderActionCooldownMs - timeSinceLastAction) / 1000)}s remaining)`
            );
            return;
        }

        // Clear existing timer for this action
        if (this.folderActionTimers.has(key)) {
            clearTimeout(this.folderActionTimers.get(key)!);
        }

        // Set new timer
        const timer = setTimeout(async () => {
            this.folderActionTimers.delete(key);
            await this.executeFolderAction(postId, action);
        }, this.folderActionDebounceMs);

        this.folderActionTimers.set(key, timer);
    }

    /**
     * Execute folder action (trash/restore) after debounce
     */
    private async executeFolderAction(postId: number, action: 'trash' | 'restore') {
        try {
            this.outputChannel.appendLine(`📤 Sending ${action} action for post ${postId}...`);

            // Send folder action to WordPress
            const response = await this.restClient.sendFolderAction(postId, action);

            // Record action time AFTER successful action
            this.lastFolderActionTime.set(postId, Date.now());

            if (response.success) {
                const actionVerb = action === 'trash' ? 'trashed' : 'restored';
                this.outputChannel.appendLine(`✅ Post ${postId} ${actionVerb} successfully`);
                
                // Show notification
                const config = vscode.workspace.getConfiguration('skylit');
                if (config.get<boolean>('showNotifications', true)) {
                    vscode.window.showInformationMessage(
                        `✅ Post ${postId} ${actionVerb} in WordPress`
                    );
                }
            }

        } catch (error: any) {
            this.outputChannel.appendLine(`❌ Folder action error: ${error.message}`);
            vscode.window.showErrorMessage(`Failed to ${action} post ${postId}: ${error.message}`);
        }
    }

    /**
     * Handle any theme file change (dynamic - syncs to theme folder)
     * This handles all files except post-types/ which is handled by Gutenberg sync
     */
    private async handleThemeFileChange(filePath: string) {
        const fileName = path.basename(filePath);
        const normalizedPath = filePath.replace(/\\/g, '/');
        const devFolderNormalized = this.devFolder.replace(/\\/g, '/');
        
        // Get relative path from dev folder
        const relativePath = normalizedPath.replace(devFolderNormalized + '/', '');
        
        // Check cooldown - prevent circular sync
        const now = Date.now();
        const lastSync = this.lastSyncTime.get(normalizedPath) || 0;
        const timeSinceLastSync = now - lastSync;
        
        if (timeSinceLastSync < this.syncCooldownMs) {
            this.outputChannel.appendLine(
                `⏸️ Skipping dev→theme sync (cooldown: ${Math.round((this.syncCooldownMs - timeSinceLastSync) / 1000)}s remaining)`
            );
            return;
        }
        
        // Determine file type for logging
        let fileType = 'theme file';
        if (relativePath.startsWith('assets/css/')) fileType = 'CSS';
        else if (relativePath.startsWith('assets/js/')) fileType = 'JS';
        else if (relativePath.startsWith('assets/')) fileType = 'asset';
        else if (relativePath.startsWith('includes/')) fileType = 'PHP include';
        else if (relativePath.startsWith('templates/')) fileType = 'template';
        else if (relativePath.startsWith('parts/')) fileType = 'template part';
        else if (relativePath.startsWith('patterns/')) fileType = 'pattern';
        else if (fileName === 'theme.json') fileType = 'theme config';
        else if (fileName === 'style.css') fileType = 'theme stylesheet';
        else if (fileName === 'functions.php') fileType = 'theme functions';
        
        this.outputChannel.appendLine(`📦 ${fileType} changed: ${relativePath}, syncing to theme...`);
        
        try {
            this.statusBar.showSyncing(fileName);
            
            // Sync all theme files to theme folder
            const response = await this.restClient.syncAssetsToTheme();
            
            // Record sync time
            this.lastSyncTime.set(normalizedPath, Date.now());
            
            // Mark corresponding theme file
            if (this.themePath) {
                const themeFilePath = this.themePath.replace(/\\/g, '/') + '/' + relativePath;
                this.lastThemeSyncTime.set(themeFilePath, Date.now());
            }
            
            if (response.success) {
                this.statusBar.showSuccess(`${fileName} synced`);
                this.outputChannel.appendLine(`✅ ${relativePath} synced to theme`);
                
                const config = vscode.workspace.getConfiguration('skylit');
                if (config.get<boolean>('showNotifications', true)) {
                    vscode.window.showInformationMessage(`✅ ${fileName} synced to theme`);
                }
            }
        } catch (error: any) {
            this.outputChannel.appendLine(`❌ Theme sync error: ${error.message}`);
            vscode.window.showErrorMessage(`Sync failed: ${error.message}`);
        }
    }

    /**
     * Handle theme.json change - sync to active theme
     * @deprecated Use handleThemeFileChange instead
     */
    private async handleThemeJsonChange(filePath: string) {
        // Now handled by handleThemeFileChange
        await this.handleThemeFileChange(filePath);
    }

    /**
     * Handle asset file change (CSS/JS in assets folder)
     * Syncs assets from dev folder to active theme
     */
    private async handleAssetChange(filePath: string) {
        const fileName = path.basename(filePath);
        const normalizedPath = filePath.replace(/\\/g, '/');
        const isCss = normalizedPath.includes('/assets/css/');
        const isJs = normalizedPath.includes('/assets/js/');
        
        // Check cooldown - don't sync if we just synced FROM theme (prevent circular sync)
        const now = Date.now();
        const lastSync = this.lastSyncTime.get(normalizedPath) || 0;
        const timeSinceLastSync = now - lastSync;
        
        if (timeSinceLastSync < this.syncCooldownMs) {
            this.outputChannel.appendLine(
                `⏸️ Skipping dev→theme sync (cooldown: ${Math.round((this.syncCooldownMs - timeSinceLastSync) / 1000)}s remaining)`
            );
            return;
        }
        
        const assetType = isCss ? 'CSS' : isJs ? 'JS' : 'asset';
        this.outputChannel.appendLine(`📦 ${assetType} asset changed: ${fileName}, syncing to theme...`);
        
        try {
            this.statusBar.showSyncing(fileName);
            
            // Sync assets to theme
            const response = await this.restClient.syncAssetsToTheme();
            
            // Record sync time to prevent circular sync from theme watcher
            this.lastSyncTime.set(normalizedPath, Date.now());
            
            // Also mark the corresponding theme file as recently synced
            if (this.themePath) {
                const themeFilePath = normalizedPath.replace(
                    this.devFolder.replace(/\\/g, '/'),
                    this.themePath.replace(/\\/g, '/')
                );
                this.lastThemeSyncTime.set(themeFilePath, Date.now());
            }
            
            if (response.success) {
                this.statusBar.showSuccess(`${fileName} synced to theme`);
                this.outputChannel.appendLine(`✅ ${fileName} synced to active theme`);
                
                // No popup notification - status bar is enough
            }
        } catch (error: any) {
            this.outputChannel.appendLine(`❌ Asset sync error: ${error.message}`);
        }
    }

    /**
     * Handle PHP include file change (in /includes folder)
     * Syncs PHP files from dev folder to theme
     */
    private async handleIncludeChange(filePath: string) {
        const fileName = path.basename(filePath);
        const normalizedPath = filePath.replace(/\\/g, '/');
        
        // Check cooldown - don't sync if we just synced FROM theme (prevent circular sync)
        const now = Date.now();
        const lastSync = this.lastSyncTime.get(normalizedPath) || 0;
        const timeSinceLastSync = now - lastSync;
        
        if (timeSinceLastSync < this.syncCooldownMs) {
            this.outputChannel.appendLine(
                `⏸️ Skipping dev→theme PHP sync (cooldown: ${Math.round((this.syncCooldownMs - timeSinceLastSync) / 1000)}s remaining)`
            );
            return;
        }
        
        this.outputChannel.appendLine(`📄 PHP include changed: ${fileName}, syncing to theme...`);
        
        try {
            this.statusBar.showSyncing(fileName);
            
            // Sync all assets and includes to theme
            const response = await this.restClient.syncAssetsToTheme();
            
            // Record sync time to prevent circular sync from theme watcher
            this.lastSyncTime.set(normalizedPath, Date.now());
            
            // Also mark the corresponding theme file as recently synced
            if (this.themePath) {
                const themeFilePath = normalizedPath.replace(
                    this.devFolder.replace(/\\/g, '/'),
                    this.themePath.replace(/\\/g, '/')
                );
                this.lastThemeSyncTime.set(themeFilePath, Date.now());
            }
            
            if (response.success) {
                this.statusBar.showSuccess(`${fileName} synced to theme`);
                this.outputChannel.appendLine(`✅ ${fileName} synced to active theme`);
                
                // No popup notification - status bar is enough
            }
        } catch (error: any) {
            this.outputChannel.appendLine(`❌ PHP sync error: ${error.message}`);
        }
    }

    /**
     * Check if file is a root theme file (style.css, functions.php at dev folder root)
     */
    private isRootThemeFile(normalizedPath: string, devFolderNormalized: string): boolean {
        const rootFiles = ['style.css', 'functions.php'];
        
        for (const rootFile of rootFiles) {
            const expectedPath = `${devFolderNormalized}/${rootFile}`;
            if (normalizedPath === expectedPath || normalizedPath.endsWith(`/${rootFile}`) && 
                !normalizedPath.includes('/assets/') && 
                !normalizedPath.includes('/post-types/')) {
                // Make sure it's at the root level (no subdirectories except the dev folder itself)
                const relativePath = normalizedPath.replace(devFolderNormalized + '/', '');
                if (relativePath === rootFile) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Handle theme structure file change (root files, templates, parts, patterns)
     * Syncs to theme folder
     */
    private async handleThemeStructureChange(filePath: string) {
        const fileName = path.basename(filePath);
        const normalizedPath = filePath.replace(/\\/g, '/');
        
        // Check cooldown
        const now = Date.now();
        const lastSync = this.lastSyncTime.get(normalizedPath) || 0;
        const timeSinceLastSync = now - lastSync;
        
        if (timeSinceLastSync < this.syncCooldownMs) {
            this.outputChannel.appendLine(
                `⏸️ Skipping theme structure sync (cooldown: ${Math.round((this.syncCooldownMs - timeSinceLastSync) / 1000)}s remaining)`
            );
            return;
        }
        
        // Determine file type for logging
        let fileType = 'theme file';
        if (normalizedPath.includes('/templates/')) {
            fileType = 'template';
        } else if (normalizedPath.includes('/parts/')) {
            fileType = 'template part';
        } else if (normalizedPath.includes('/patterns/')) {
            fileType = 'pattern';
        } else if (fileName === 'style.css') {
            fileType = 'theme stylesheet';
        } else if (fileName === 'functions.php') {
            fileType = 'theme functions';
        }
        
        this.outputChannel.appendLine(`🎨 ${fileType} changed: ${fileName}, syncing to theme...`);
        
        try {
            this.statusBar.showSyncing(fileName);
            
            // Sync all theme structure to theme
            const response = await this.restClient.syncAssetsToTheme();
            
            // Record sync time
            this.lastSyncTime.set(normalizedPath, Date.now());
            
            // Mark corresponding theme file
            if (this.themePath) {
                const themeFilePath = normalizedPath.replace(
                    this.devFolder.replace(/\\/g, '/'),
                    this.themePath.replace(/\\/g, '/')
                );
                this.lastThemeSyncTime.set(themeFilePath, Date.now());
            }
            
            if (response.success) {
                this.statusBar.showSuccess(`${fileName} synced to theme`);
                this.outputChannel.appendLine(`✅ ${fileName} synced to active theme`);
                
                const config = vscode.workspace.getConfiguration('skylit');
                if (config.get<boolean>('showNotifications', true)) {
                    vscode.window.showInformationMessage(`✅ ${fileName} synced to theme`);
                }
            }
        } catch (error: any) {
            this.outputChannel.appendLine(`❌ Theme structure sync error: ${error.message}`);
        }
    }

    /**
     * Handle file change with debouncing
     */
    private handleFileChange(filePath: string) {
        // Clear existing timer for this file
        if (this.debounceTimers.has(filePath)) {
            clearTimeout(this.debounceTimers.get(filePath)!);
        }

        // Set new timer
        const timer = setTimeout(async () => {
            await this.syncFile(filePath);
            this.debounceTimers.delete(filePath);
        }, this.debounceMs);

        this.debounceTimers.set(filePath, timer);
    }

    /**
     * Sync file to WordPress
     */
    async syncFile(filePath: string) {
        try {
            // Check cooldown - don't sync if we just synced this file
            const now = Date.now();
            const lastSync = this.lastSyncTime.get(filePath) || 0;
            const timeSinceLastSync = now - lastSync;
            
            if (timeSinceLastSync < this.syncCooldownMs) {
                this.outputChannel.appendLine(
                    `⏸️ Skipping sync (cooldown: ${Math.round((this.syncCooldownMs - timeSinceLastSync) / 1000)}s remaining)`
                );
                return;
            }

            // Extract post info from file path
            const postInfo = this.extractPostInfo(filePath);
            if (!postInfo) {
                this.outputChannel.appendLine(`⚠️ Cannot extract post info from: ${filePath}`);
                return;
            }

            const { postId, postFolder } = postInfo;
            const fileName = path.basename(filePath);

            // CRITICAL: Check if this change was caused by a recent WordPress export
            // This prevents circular sync: IDE → WP → Export → IDE detects change → loop
            try {
                const checkResult = await this.restClient.checkForChanges(postId);
                if (checkResult.skip_import) {
                    this.outputChannel.appendLine(
                        `⏭️ Skipping sync (recent export - circular sync prevention)`
                    );
                    return;
                }
            } catch (error) {
                // If check fails, continue with sync (better to sync than skip)
                this.outputChannel.appendLine(`⚠️ Could not check export status, proceeding with sync`);
            }

            // Show syncing status
            this.statusBar.showSyncing(fileName);

            // Read HTML and CSS files
            const htmlPath = path.join(postFolder, `${path.basename(postFolder)}.html`);
            const cssPath = path.join(postFolder, `${path.basename(postFolder)}.css`);

            let html = '';
            let css = '';

            if (fs.existsSync(htmlPath)) {
                html = fs.readFileSync(htmlPath, 'utf8');
            }

            if (fs.existsSync(cssPath)) {
                css = fs.readFileSync(cssPath, 'utf8');
            }

            // Sync to WordPress (restClient will handle logging)
            const response = await this.restClient.syncFile(postId, html, css);

            // Record sync time AFTER successful sync
            this.lastSyncTime.set(filePath, Date.now());

            if (response.success) {
                this.statusBar.showSuccess(`Synced ${fileName}`);
                
                // Show notification if enabled
                const config = vscode.workspace.getConfiguration('skylit');
                if (config.get<boolean>('showNotifications', true)) {
                    vscode.window.showInformationMessage(
                        `✅ Synced: ${fileName} (${response.blocks_updated || 0} blocks)`
                    );
                }
            }

        } catch (error: any) {
            this.outputChannel.appendLine(`❌ Sync error: ${error.message}`);
            vscode.window.showErrorMessage(`Sync failed: ${error.message}`);
        }
    }

    /**
     * Extract post ID and folder from file path
     * Format: /post-types/pages/about-us_123/about-us_123.html
     */
    private extractPostInfo(filePath: string): { postId: number; postFolder: string } | null {
        // Get the folder containing this file
        const isFile = fs.existsSync(filePath) && fs.statSync(filePath).isFile();
        const folder = isFile ? path.dirname(filePath) : filePath;
        const folderName = path.basename(folder);

        // Extract post ID from folder name (format: slug_ID)
        const match = folderName.match(/_(\d+)$/);
        if (!match) {
            return null;
        }

        const postId = parseInt(match[1], 10);
        
        return {
            postId,
            postFolder: folder
        };
    }

    /**
     * Stop watching files
     */
    dispose() {
        // Stop main file watcher
        if (this.watcher) {
            this.watcher.close();
            this.outputChannel.appendLine('👋 File watcher stopped');
        }

        // Stop trash folder watcher
        if (this.trashWatcher) {
            this.trashWatcher.close();
            this.outputChannel.appendLine('👋 Trash folder watcher stopped');
        }

        // Stop theme folder watcher (bi-directional sync)
        if (this.themeWatcher) {
            this.themeWatcher.close();
            this.outputChannel.appendLine('👋 Theme watcher stopped');
        }
        
        // Stop new folder watcher
        if (this.newFolderWatcher) {
            this.newFolderWatcher.close();
            this.outputChannel.appendLine('👋 New folder watcher stopped');
        }
        
        // Stop metadata watcher
        if (this.metadataWatcher) {
            this.metadataWatcher.close();
            this.outputChannel.appendLine('👋 Metadata watcher stopped');
        }
        
        // Clear metadata cache
        this.metadataCache.clear();
        this.metadataSyncCooldown.clear();

        // Clear all file debounce timers
        this.debounceTimers.forEach(timer => clearTimeout(timer));
        this.debounceTimers.clear();

        // Clear all folder action timers
        this.folderActionTimers.forEach(timer => clearTimeout(timer));
        this.folderActionTimers.clear();
        
        // Clear new folder timers
        this.newFolderTimers.forEach(timer => clearTimeout(timer));
        this.newFolderTimers.clear();
        
        // Clear sync cooldown tracking
        this.lastSyncTime.clear();
        
        // Clear theme sync cooldown tracking
        this.lastThemeSyncTime.clear();
        
        // Clear folder action cooldown tracking
        this.lastFolderActionTime.clear();
        
        // Clear processed folders tracking
        this.processedNewFolders.clear();
        
        // Clear pending renames
        this.pendingRenames.clear();
    }
}
