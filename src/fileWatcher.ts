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
import { DebugLogger } from './debugLogger';

/**
 * Join paths using forward slashes (POSIX-style)
 * This is needed for SSH/remote paths on Windows hosts
 */
function posixJoin(...parts: string[]): string {
    return parts.join('/').replace(/\/+/g, '/');
}

/**
 * Convert a file path to a proper VS Code URI
 * This handles SSH/remote paths by using the workspace folder's URI scheme
 */
function pathToUri(filePath: string): vscode.Uri {
    const normalizedPath = filePath.replace(/\\/g, '/');
    
    // Get workspace folders to determine the correct URI scheme
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        const wsFolder = workspaceFolders[0];
        const wsUri = wsFolder.uri;
        
        // If workspace is remote (SSH, WSL, etc.), use its scheme
        if (wsUri.scheme !== 'file') {
            // Extract the workspace path and see if our path is relative to it
            const wsPath = wsUri.path;
            
            // Check if the path starts with the workspace path
            if (normalizedPath.startsWith(wsPath)) {
                // Path is within workspace, use joinPath for proper URI
                const relativePath = normalizedPath.substring(wsPath.length);
                return vscode.Uri.joinPath(wsUri, relativePath);
            }
            
            // Path might be outside workspace but still remote
            // Construct URI with same authority (host) but different path
            return wsUri.with({ path: normalizedPath });
        }
    }
    
    // Fallback to file:// URI for local paths
    return vscode.Uri.file(normalizedPath);
}

/**
 * VS Code FileSystem helper functions for SSH compatibility
 * These use vscode.workspace.fs which works with remote filesystems
 */
async function vsExists(filePath: string): Promise<boolean> {
    try {
        const uri = pathToUri(filePath);
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

async function vsReadDir(dirPath: string): Promise<[string, vscode.FileType][]> {
    try {
        const uri = pathToUri(dirPath);
        return await vscode.workspace.fs.readDirectory(uri);
    } catch {
        return [];
    }
}

async function vsReadFile(filePath: string): Promise<string> {
    const uri = pathToUri(filePath);
    const content = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(content).toString('utf8');
}

async function vsWriteFile(filePath: string, content: string): Promise<void> {
    const uri = pathToUri(filePath);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
}

async function vsRename(oldPath: string, newPath: string): Promise<void> {
    const oldUri = pathToUri(oldPath);
    const newUri = pathToUri(newPath);
    await vscode.workspace.fs.rename(oldUri, newUri, { overwrite: false });
}

/**
 * Folding State Manager
 * Tracks and restores editor folding states per file
 * Works with block-level change detection to preserve folding for unchanged blocks
 */
class FoldingStateManager {
    private foldingStates: Map<string, number[]> = new Map(); // file path -> folded line numbers
    private debugLogger: DebugLogger;
    
    constructor(debugLogger: DebugLogger) {
        this.debugLogger = debugLogger;
    }
    
    /**
     * Save current folding state for a file
     * Note: VS Code doesn't expose folding state directly, so we use a workaround
     * by tracking the visible ranges before file changes
     */
    async saveFoldingState(filePath: string): Promise<void> {
        const normalizedPath = filePath.replace(/\\/g, '/');
        const uri = pathToUri(normalizedPath);
        
        // Find editor for this file
        const editor = vscode.window.visibleTextEditors.find(
            e => e.document.uri.toString() === uri.toString()
        );
        
        if (!editor) {
            return;
        }
        
        // Get visible ranges - collapsed regions will create gaps in visible ranges
        const visibleRanges = editor.visibleRanges;
        if (visibleRanges.length <= 1) {
            // Single visible range means no folding (or whole document visible)
            this.foldingStates.set(normalizedPath, []);
            return;
        }
        
        // Detect folded regions by finding gaps between visible ranges
        const foldedLines: number[] = [];
        for (let i = 0; i < visibleRanges.length - 1; i++) {
            const currentEnd = visibleRanges[i].end.line;
            const nextStart = visibleRanges[i + 1].start.line;
            
            // If there's a gap, there's a folded region
            if (nextStart > currentEnd + 1) {
                // The line before the gap is the fold point
                foldedLines.push(currentEnd);
            }
        }
        
        this.foldingStates.set(normalizedPath, foldedLines);
        this.debugLogger.log(`📁 Saved folding state: ${foldedLines.length} folded regions`);
    }
    
    /**
     * Restore folding state for unchanged blocks
     * Uses block change info from the API to determine which folds to restore
     */
    async restoreFoldingState(
        filePath: string, 
        unchangedBlocks: Array<{ startLine: number; endLine: number; layoutBlockId: string }>
    ): Promise<void> {
        const normalizedPath = filePath.replace(/\\/g, '/');
        const savedFolds = this.foldingStates.get(normalizedPath);
        
        if (!savedFolds || savedFolds.length === 0) {
            return;
        }
        
        const uri = pathToUri(normalizedPath);
        
        // Find editor for this file
        const editor = vscode.window.visibleTextEditors.find(
            e => e.document.uri.toString() === uri.toString()
        );
        
        if (!editor) {
            // Try to open the file
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc);
            } catch {
                return;
            }
        }
        
        // Get the active editor
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor || activeEditor.document.uri.toString() !== uri.toString()) {
            return;
        }
        
        // Filter saved folds to only restore those within unchanged blocks
        const foldsToRestore: number[] = [];
        
        for (const foldLine of savedFolds) {
            // Check if this fold line is within an unchanged block
            const isInUnchangedBlock = unchangedBlocks.some(block => {
                // Fold line should be within the block's range
                return foldLine >= block.startLine && foldLine <= block.endLine;
            });
            
            if (isInUnchangedBlock) {
                foldsToRestore.push(foldLine);
            }
        }
        
        if (foldsToRestore.length === 0) {
            return;
        }
        
        this.debugLogger.log(`📂 Restoring ${foldsToRestore.length} folds for unchanged blocks`);
        
        // Restore folds using VS Code fold command
        for (const line of foldsToRestore) {
            try {
                // Move cursor to the line and fold
                const position = new vscode.Position(line, 0);
                activeEditor.selection = new vscode.Selection(position, position);
                await vscode.commands.executeCommand('editor.fold', { 
                    selectionLines: [line] 
                });
            } catch (e) {
                // Fold might fail if line doesn't have foldable content
            }
        }
        
        // Clear saved state after restoration
        this.foldingStates.delete(normalizedPath);
    }
    
    /**
     * Clear all saved folding states
     */
    clear(): void {
        this.foldingStates.clear();
    }
}

export class FileWatcher {
    private watcher: chokidar.FSWatcher | null = null;
    private trashWatcher: chokidar.FSWatcher | null = null;
    private themeWatcher: chokidar.FSWatcher | null = null; // Bi-directional: watch theme folder
    private newFolderWatcher: chokidar.FSWatcher | null = null; // Watch for new folders in post-types
    private metadataWatcher: chokidar.FSWatcher | null = null; // Watch for JSON metadata changes
    private vscodeTrashWatcher: vscode.FileSystemWatcher | null = null; // VS Code native watcher for SSH compatibility
    private vscodeNewFolderWatcher: vscode.FileSystemWatcher | null = null; // VS Code native watcher for new folder creation
    private pollingIntervals: NodeJS.Timeout[] = []; // Polling intervals for SSH compatibility
    private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
    private folderActionTimers: Map<string, NodeJS.Timeout> = new Map();
    private newFolderTimers: Map<string, NodeJS.Timeout> = new Map(); // Debounce new folder detection
    private lastSyncTime: Map<string, number> = new Map();
    private lastFolderActionTime: Map<number, number> = new Map();
    private lastThemeSyncTime: Map<string, number> = new Map(); // Track theme file syncs
    private processedNewFolders: Set<string> = new Set(); // Track folders we've already processed
    private recentlyRenamedFolders: Map<string, { newFolder: string; postId: number; timestamp: number }> = new Map(); // Track old→new renames to prevent duplicates
    private pendingRenames: Map<number, { oldPath: string; oldSlug: string; timestamp: number }> = new Map(); // Track folder renames
    private recentFolderDeletes: Map<number, { path: string; timestamp: number }> = new Map(); // Track recent deletes to detect server-side renames
    private pendingRestoreTimers: Map<number, NodeJS.Timeout> = new Map(); // Pending restore timers that can be cancelled
    private metadataCache: Map<number, { slug: string; title: string; status: string }> = new Map(); // Cache metadata for change detection
    private metadataSyncCooldown: Map<number, number> = new Map(); // Cooldown for metadata syncs
    private devFolder: string;
    private themePath: string | null = null; // Theme folder path (fetched from WordPress)
    private restClient: RestClient;
    private statusBar: StatusBar;
    private debugLogger: DebugLogger;
    private debounceMs: number = 500;
    private folderActionDebounceMs: number = 1000; // Debounce folder actions
    private folderActionCooldownMs: number = 5000; // Don't re-process same post within 5 seconds
    private syncCooldownMs: number = 3000; // Don't re-sync same file within 3 seconds
    private themeSyncCooldownMs: number = 3000; // Cooldown for theme → dev sync
    private newFolderDebounceMs: number = 2000; // Wait for HTML file to be created
    private renameCooldownMs: number = 2000; // Time window to match unlink+add as rename
    private foldingManager: FoldingStateManager; // Manages folding state for unchanged blocks
    private cursorSelectionListener: vscode.Disposable | null = null; // Cursor tracking for GT sync
    private cursorDebounceTimer: NodeJS.Timeout | null = null; // Debounce cursor position updates
    private lastCursorBlockId: string | null = null; // Avoid writing same block repeatedly
    private cursorTrackingEnabled: boolean = true; // Can be disabled via settings

    constructor(
        devFolder: string,
        restClient: RestClient,
        statusBar: StatusBar,
        debugLogger: DebugLogger
    ) {
        this.devFolder = devFolder;
        this.restClient = restClient;
        this.statusBar = statusBar;
        this.debugLogger = debugLogger;
        this.foldingManager = new FoldingStateManager(debugLogger);

        // Get debounce setting
        const config = vscode.workspace.getConfiguration('skylit');
        this.debounceMs = config.get<number>('debounceMs', 500);
        this.cursorTrackingEnabled = config.get<boolean>('cursorTracking', true);
    }

    /**
     * Start watching files
     */
    async start() {
        this.debugLogger.log(`👀 Starting file watcher for: ${this.devFolder}`);

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
            this.debugLogger.log(`📝 File changed: ${filePath}`);
            
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
            this.debugLogger.log(`❌ File watcher error: ${error.message}`);
        });

        // Use VS Code's native FileSystemWatcher for trash operations
        // This properly handles SSH remotes through VS Code's virtual filesystem
        const postTypesPath = posixJoin(this.devFolder, 'post-types');
        
        this.debugLogger.log(`🔍 [Trash Watcher] Setting up VS Code native watcher for: ${postTypesPath}`);
        
        // Create a glob pattern that matches files in post-types folders
        // VS Code watcher works with Uri patterns
        const trashPattern = new vscode.RelativePattern(
            vscode.Uri.file(postTypesPath),
            '**/*'  // Watch all files and folders
        );
        
        this.vscodeTrashWatcher = vscode.workspace.createFileSystemWatcher(trashPattern, false, true, false);
        
        // Listen for files/folders being created (could be trash or restore)
        this.vscodeTrashWatcher.onDidCreate((uri) => {
            const filePath = uri.fsPath;
            this.debugLogger.log(`🔍 [VS Code Watcher] Created: ${filePath}`);
            
            // Check if this is a directory by looking at the path pattern
            // Folders with _ID suffix in post-types are what we care about
            if (filePath.includes('_trash') || /_\d+$/.test(path.basename(filePath)) || /_\d+[\/\\]/.test(filePath)) {
                this.handlePotentialTrashAction(filePath, 'add');
            }
        });
        
        // Listen for files/folders being deleted (could be trash or restore)
        this.vscodeTrashWatcher.onDidDelete((uri) => {
            const filePath = uri.fsPath;
            this.debugLogger.log(`🔍 [VS Code Watcher] Deleted: ${filePath}`);
            
            // Check if this is a post folder being removed from _trash (restore)
            if (filePath.includes('_trash') || /_\d+$/.test(path.basename(filePath)) || /_\d+[\/\\]/.test(filePath)) {
                this.handlePotentialTrashAction(filePath, 'unlink');
            }
        });
        
        this.debugLogger.log('✅ File watcher started (including VS Code native _trash folder monitoring)');

        // Start bi-directional theme watcher
        await this.startThemeWatcher();
        
        // Start new folder watcher for creating posts from IDE
        await this.startNewFolderWatcher();
        
        // Start metadata watcher for JSON → WordPress sync
        await this.startMetadataWatcher();
        
        // Start cursor tracking for Gutenberg block selection sync
        this.startCursorTracking();
    }
    
    /**
     * Start watching for new folders in post-types directory
     * When a new folder is created without _ID suffix, create a WordPress post
     * Uses VS Code's native FileSystemWatcher for SSH compatibility
     */
    private async startNewFolderWatcher() {
        const postTypesPath = posixJoin(this.devFolder, 'post-types');
        
        this.debugLogger.log(`🔍 [New Folder Watcher] Setting up VS Code native watcher for: ${postTypesPath}`);
        this.debugLogger.log(`🔍 [New Folder Watcher] Dev folder: ${this.devFolder}`);
        
        // First, scan for existing folders without IDs (created before extension started)
        // This uses VS Code FS API for SSH compatibility
        try {
            await this.scanForNewFolders(postTypesPath);
        } catch (err: any) {
            this.debugLogger.log(`⚠️ Could not scan for existing folders: ${err.message}`);
            this.debugLogger.log(`ℹ️ Watcher will still monitor for new folders created after connection`);
        }
        
        // Create VS Code native FileSystemWatcher (works on SSH)
        const newFolderPattern = new vscode.RelativePattern(
            vscode.Uri.file(postTypesPath),
            '**/*'  // Watch all files and folders
        );
        
        this.vscodeNewFolderWatcher = vscode.workspace.createFileSystemWatcher(newFolderPattern, false, true, false);
        
        // Listen for files/folders being created (new folder or HTML file added)
        this.vscodeNewFolderWatcher.onDidCreate((uri) => {
            const filePath = uri.fsPath.replace(/\\/g, '/');
            
            // Skip trash folders
            if (filePath.includes('/_trash/') || filePath.includes('\\_trash\\')) {
                return;
            }
            
            // Check if this is an HTML file
            if (filePath.endsWith('.html')) {
                this.debugLogger.log(`🔔 [VS Code Watcher] HTML file created: ${path.basename(filePath)}`);
                const folderPath = path.dirname(filePath).replace(/\\/g, '/');
                this.handlePotentialNewFolder(folderPath);
                return;
            }
            
            // Check if this is a folder (has no extension or is a known folder pattern)
            const baseName = path.basename(filePath);
            if (!baseName.includes('.') || /_\d+$/.test(baseName)) {
                this.debugLogger.log(`🔔 [VS Code Watcher] Folder created: ${baseName}`);
                
                // Check if this is a rename completion (folder with _ID reappearing)
                const postId = this.extractPostIdFromPath(filePath);
                if (postId && this.pendingRenames.has(postId)) {
                    this.handleRenameComplete(filePath, postId);
                } else {
                    this.handlePotentialNewFolder(filePath);
                }
            }
        });
        
        // Listen for files/folders being deleted (potential rename start)
        this.vscodeNewFolderWatcher.onDidDelete((uri) => {
            const filePath = uri.fsPath.replace(/\\/g, '/');
            
            // Skip trash folders
            if (filePath.includes('/_trash/') || filePath.includes('\\_trash\\')) {
                return;
            }
            
            // Check if this is a post folder (has _ID suffix)
            const baseName = path.basename(filePath);
            if (/_\d+$/.test(baseName)) {
                this.debugLogger.log(`🔔 [VS Code Watcher] Folder deleted: ${baseName}`);
                this.handlePotentialRenameStart(filePath);
            }
        });
        
        this.debugLogger.log('✅ New folder watcher started (VS Code native)');
    }
    
    /**
     * Start watching for changes in JSON metadata files
     * When slug/title/status changes in JSON, sync to WordPress and rename files if needed
     */
    private async startMetadataWatcher() {
        const metadataPath = posixJoin(this.devFolder, '.skylit', 'metadata');
        
        this.debugLogger.log(`🔍 [Metadata Watcher] Checking for .skylit/metadata at: ${metadataPath}`);
        
        // Check if folder exists (may fail on SSH, that's OK - chokidar can still watch it)
        let folderExists = false;
        try {
            folderExists = fs.existsSync(metadataPath);
        } catch (err: any) {
            this.debugLogger.log(`🔍 [Metadata Watcher] Could not check folder existence (SSH?): ${err.message}`);
            this.debugLogger.log(`🔍 [Metadata Watcher] Will try to watch anyway (chokidar handles SSH paths)`);
        }
        
        if (!folderExists) {
            this.debugLogger.log(`⚠️ .skylit/metadata folder not found via fs.existsSync() at: ${metadataPath}`);
            
            // Try to list what's in .skylit folder if it exists (diagnostic)
            const skylitPath = posixJoin(this.devFolder, '.skylit');
            try {
                if (fs.existsSync(skylitPath)) {
                    const contents = fs.readdirSync(skylitPath);
                    this.debugLogger.log(`🔍 [Metadata Watcher] .skylit folder contents: ${contents.join(', ')}`);
                } else {
                    this.debugLogger.log(`🔍 [Metadata Watcher] .skylit folder does not exist via fs at: ${skylitPath}`);
                }
            } catch (err: any) {
                this.debugLogger.log(`🔍 [Metadata Watcher] Could not read .skylit folder with fs (SSH expected): ${err.message}`);
            }
            
            // On SSH, fs operations fail but chokidar can still watch the path
            // Try to start the watcher anyway
            this.debugLogger.log(`🔄 [Metadata Watcher] Attempting to start watcher anyway (SSH compatibility)`);
        }
        
        this.debugLogger.log(`👀 Starting metadata watcher for: ${metadataPath}`);
        
        // Load initial metadata cache
        // This uses fs operations which may fail on SSH - that's OK
        try {
            await this.loadMetadataCache(metadataPath);
        } catch (err: any) {
            this.debugLogger.log(`⚠️ Could not load metadata cache (SSH expected): ${err.message}`);
            this.debugLogger.log(`ℹ️ Watcher will still monitor for metadata changes after connection`);
        }
        
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
            this.debugLogger.log(`❌ Metadata watcher error: ${error.message}`);
        });
        
        this.debugLogger.log('✅ Metadata watcher started (JSON → WordPress sync enabled)');
    }
    
    
    /**
     * Load all metadata files into cache for change detection
     * Uses VS Code's workspace.fs API for SSH compatibility
     */
    private async loadMetadataCache(metadataPath: string) {
        try {
            // Use VS Code FS API for SSH compatibility
            const dirEntries = await vsReadDir(metadataPath);
            const jsonFiles = dirEntries
                .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.json'))
                .map(([name]) => name);
            
            for (const file of jsonFiles) {
                const filePath = posixJoin(metadataPath, file);
                const postId = parseInt(path.basename(file, '.json'), 10);
                
                if (isNaN(postId)) continue;
                
                try {
                    const content = await vsReadFile(filePath);
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
            
            this.debugLogger.log(`📦 Loaded ${this.metadataCache.size} metadata files into cache`);
        } catch (error: any) {
            this.debugLogger.log(`⚠️ Could not load metadata cache: ${error.message}`);
        }
    }
    
    /**
     * Handle changes to a metadata JSON file
     * Uses VS Code's workspace.fs API for SSH compatibility
     */
    private async handleMetadataChange(filePath: string) {
        const normalizedPath = filePath.replace(/\\/g, '/');
        const fileName = path.basename(normalizedPath);
        const postId = parseInt(path.basename(fileName, '.json'), 10);
        
        if (isNaN(postId)) {
            return;
        }
        
        // Check cooldown
        const lastSync = this.metadataSyncCooldown.get(postId) || 0;
        if (Date.now() - lastSync < 2000) {
            return; // Skip if recently synced (prevent loops)
        }
        
        this.debugLogger.log(`🔔 [Metadata] Change detected: ${fileName}`);
        
        try {
            const content = await vsReadFile(normalizedPath);
            const newData = JSON.parse(content);
            
            const oldData = this.metadataCache.get(postId);
            
            // Check what changed
            const changes: { slug?: string; title?: string; status?: string } = {};
            let hasChanges = false;
            
            if (oldData) {
                if (newData.slug && newData.slug !== oldData.slug) {
                    changes.slug = newData.slug;
                    hasChanges = true;
                    this.debugLogger.log(`   📝 Slug changed: ${oldData.slug} → ${newData.slug}`);
                }
                if (newData.title && newData.title !== oldData.title) {
                    changes.title = newData.title;
                    hasChanges = true;
                    this.debugLogger.log(`   📝 Title changed: ${oldData.title} → ${newData.title}`);
                }
                if (newData.status && newData.status !== oldData.status) {
                    changes.status = newData.status;
                    hasChanges = true;
                    this.debugLogger.log(`   📝 Status changed: ${oldData.status} → ${newData.status}`);
                    this.debugLogger.log(`   ℹ️  This change came from WordPress (not IDE)`);
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
                    this.debugLogger.log(`⚠️ Metadata sync failed: ${response.error}`);
                    // Only log to output, no popup
                }
            } catch (error: any) {
                this.debugLogger.log(`❌ Metadata sync error: ${error.message}`);
                // Only show error popups for critical errors
            }
            
        } catch (error: any) {
            this.debugLogger.log(`❌ Failed to parse metadata: ${error.message}`);
        }
    }
    
    /**
     * Rename post folder and files when slug changes in metadata
     * Uses VS Code's workspace.fs API for SSH compatibility
     */
    private async renamePostFiles(postId: number, oldSlug: string, newSlug: string, postType: string) {
        this.debugLogger.log(`📂 Renaming files for post ${postId}: ${oldSlug} → ${newSlug}`);
        
        try {
            // Build paths
            const postTypeFolderName = postType + 's'; // e.g., 'page' → 'pages'
            const postTypePath = posixJoin(this.devFolder, 'post-types', postTypeFolderName);
            
            const oldFolderName = `${oldSlug}_${postId}`;
            const newFolderName = `${newSlug}_${postId}`;
            
            const oldFolderPath = posixJoin(postTypePath, oldFolderName);
            const newFolderPath = posixJoin(postTypePath, newFolderName);
            
            // Check if old folder exists (using VS Code FS API)
            if (!await vsExists(oldFolderPath)) {
                this.debugLogger.log(`⚠️ Old folder not found: ${oldFolderName}`);
                return;
            }
            
            // Check if new folder already exists
            if (await vsExists(newFolderPath)) {
                this.debugLogger.log(`⚠️ New folder already exists: ${newFolderName}`);
                return;
            }
            
            // Rename files inside the folder first (using VS Code FS API)
            const oldHtmlPath = posixJoin(oldFolderPath, `${oldFolderName}.html`);
            const newHtmlPath = posixJoin(oldFolderPath, `${newFolderName}.html`);
            const oldCssPath = posixJoin(oldFolderPath, `${oldFolderName}.css`);
            const newCssPath = posixJoin(oldFolderPath, `${newFolderName}.css`);
            
            if (await vsExists(oldHtmlPath)) {
                await vsRename(oldHtmlPath, newHtmlPath);
                this.debugLogger.log(`   ✓ HTML: ${oldFolderName}.html → ${newFolderName}.html`);
            }
            
            if (await vsExists(oldCssPath)) {
                await vsRename(oldCssPath, newCssPath);
                this.debugLogger.log(`   ✓ CSS: ${oldFolderName}.css → ${newFolderName}.css`);
            }
            
            // Rename the folder (using VS Code FS API)
            await vsRename(oldFolderPath, newFolderPath);
            this.debugLogger.log(`   ✓ Folder: ${oldFolderName} → ${newFolderName}`);
            
            // Update JSON's file path to stay in sync
            const newFilePath = `post-types/${postTypeFolderName}/${newFolderName}/${newFolderName}.html`;
            await this.updateJsonMetadataFilePath(postId, newFilePath);
            
            // Handle open editors - close old file and open new file
            await this.handleFileRename(oldFolderPath, `post-types/${postTypeFolderName}/${newFolderName}`, postId);
            
        } catch (error: any) {
            this.debugLogger.log(`❌ Failed to rename files: ${error.message}`);
        }
    }
    
    /**
     * Update only the file path in JSON metadata (for internal updates that shouldn't trigger full sync)
     * Uses VS Code's workspace.fs API for SSH compatibility
     */
    private async updateJsonMetadataFilePath(postId: number, newFilePath: string) {
        const metadataPath = posixJoin(this.devFolder, '.skylit', 'metadata', `${postId}.json`);
        
        if (!await vsExists(metadataPath)) {
            return;
        }
        
        try {
            // Set cooldown to prevent triggering another sync
            this.metadataSyncCooldown.set(postId, Date.now());
            
            const content = await vsReadFile(metadataPath);
            const metadata = JSON.parse(content);
            
            metadata.file = newFilePath;
            metadata.lastExported = new Date().toISOString().replace('T', ' ').substring(0, 19);
            
            await vsWriteFile(metadataPath, JSON.stringify(metadata, null, 4));
            this.debugLogger.log(`   ✓ JSON file path updated`);
            
        } catch (error: any) {
            this.debugLogger.log(`⚠️ Could not update JSON file path: ${error.message}`);
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
        
        this.debugLogger.log(`🔄 Folder removed (potential rename): ${folderName}`);
        
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
                    this.debugLogger.log(`🗑️ Folder delete confirmed (no rename): ${folderName}`);
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
            this.debugLogger.log(`🔄 Folder moved but slug unchanged: ${folderName}`);
            return;
        }
        
        this.debugLogger.log(`📝 Folder renamed: ${pending.oldSlug}_${postId} → ${newSlug}_${postId}`);
        this.statusBar.showSyncing('Updating slug...');
        
        try {
            const response = await this.restClient.updatePostSlug(postId, newSlug);
            
            if (response.success) {
                this.statusBar.showSuccess('Slug updated');
                this.debugLogger.log(`✅ WordPress slug updated: ${pending.oldSlug} → ${newSlug}`);
                
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
                this.debugLogger.log(`⚠️ Could not update slug: ${response.error}`);
            }
        } catch (error: any) {
            this.debugLogger.log(`❌ Failed to update slug: ${error.message}`);
            vscode.window.showErrorMessage(`Failed to update slug: ${error.message}`);
        }
    }
    
    /**
     * Update JSON metadata file to stay in sync with folder structure
     * Uses VS Code's workspace.fs API for SSH compatibility
     */
    private async updateJsonMetadata(postId: number, updates: { slug?: string; title?: string; status?: string; file?: string }) {
        const metadataPath = posixJoin(this.devFolder, '.skylit', 'metadata', `${postId}.json`);
        
        if (!await vsExists(metadataPath)) {
            this.debugLogger.log(`⚠️ Metadata file not found: ${postId}.json`);
            return;
        }
        
        try {
            // Set cooldown to prevent the change from triggering another sync
            this.metadataSyncCooldown.set(postId, Date.now());
            
            const content = await vsReadFile(metadataPath);
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
            
            // Write back (using VS Code FS API)
            await vsWriteFile(metadataPath, JSON.stringify(metadata, null, 4));
            this.debugLogger.log(`📦 JSON metadata updated: ${postId}.json`);
            
        } catch (error: any) {
            this.debugLogger.log(`❌ Failed to update JSON metadata: ${error.message}`);
        }
    }
    
    /**
     * Handle potential new folder that might need a WordPress post created
     */
    private handlePotentialNewFolder(dirPath: string) {
        const normalizedPath = dirPath.replace(/\\/g, '/');
        // Remove trailing slash from devFolder for consistent matching
        const devFolderNormalized = this.devFolder.replace(/\\/g, '/').replace(/\/$/, '');
        
        this.debugLogger.log(`🔍 [New Folder] Checking: ${normalizedPath}`);
        this.debugLogger.log(`🔍 [New Folder] Dev folder: ${devFolderNormalized}`);
        
        // Get relative path from dev folder
        let relativePath = normalizedPath;
        if (normalizedPath.startsWith(devFolderNormalized + '/')) {
            relativePath = normalizedPath.substring(devFolderNormalized.length + 1);
        } else if (normalizedPath.startsWith(devFolderNormalized)) {
            relativePath = normalizedPath.substring(devFolderNormalized.length);
            if (relativePath.startsWith('/')) {
                relativePath = relativePath.substring(1);
            }
        }
        
        this.debugLogger.log(`🔍 [New Folder] Relative path: ${relativePath}`);
        
        // Must be in post-types/[type]/[folder] format
        const parts = relativePath.split('/');
        this.debugLogger.log(`🔍 [New Folder] Parts: ${JSON.stringify(parts)} (length: ${parts.length})`);
        
        if (parts.length !== 3 || parts[0] !== 'post-types') {
            this.debugLogger.log(`🔍 [New Folder] Skipping - not a content folder (need parts.length=3, parts[0]=post-types)`);
            return; // Not a content folder
        }
        
        const postTypeFolder = parts[1]; // e.g., "pages", "posts"
        const folderName = parts[2];     // e.g., "about-us" or "about-us_123"
        
        // Skip if already has _ID suffix (already linked to a post)
        if (/_\d+$/.test(folderName)) {
            this.debugLogger.log(`🔍 [New Folder] Skipping - already has post ID: ${folderName}`);
            return;
        }
        
        // Skip if in _trash
        if (folderName === '_trash' || relativePath.includes('/_trash/')) {
            this.debugLogger.log(`🔍 [New Folder] Skipping - in trash: ${folderName}`);
            return;
        }
        
        // IMPORTANT: Check for duplicates FIRST, before "already processed" check
        // This handles the case where WordPress recreates the old folder after we renamed it
        const recentRename = this.recentlyRenamedFolders.get(folderName);
        if (recentRename) {
            const ageMs = Date.now() - recentRename.timestamp;
            // If renamed within last 30 seconds, this is likely WordPress re-exporting
            // After 30 seconds, treat as intentional new page creation
            if (ageMs < 30 * 1000) {
                this.debugLogger.log(`🔄 [Duplicate Prevention] "${folderName}" was recently renamed to "${recentRename.newFolder}" (${Math.round(ageMs / 1000)}s ago)`);
                this.debugLogger.log(`   Redirecting to existing post (ID: ${recentRename.postId})`);
                
                // Auto-redirect: delete this duplicate folder and merge contents
                // Don't await - let it run in background (function is already async)
                this.redirectDuplicateFolder(normalizedPath, recentRename, postTypeFolder);
                return;
            } else {
                // Old entry, remove it - allow new page creation with same name
                this.debugLogger.log(`🔍 [New Folder] Clearing old rename tracking for "${folderName}" (${Math.round(ageMs / 1000)}s ago)`);
                this.recentlyRenamedFolders.delete(folderName);
            }
        }
        
        // Skip if already processed (but not if it's a duplicate - handled above)
        if (this.processedNewFolders.has(normalizedPath)) {
            this.debugLogger.log(`🔍 [New Folder] Skipping - already processed: ${folderName}`);
            return;
        }
        
        this.debugLogger.log(`📁 New folder detected: ${relativePath}`);
        
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
        this.debugLogger.log(`🔍 [Create Post] Starting for: ${folderPath}`);
        
        // Check if folder still exists and has HTML file (using VS Code FS API)
        const folderExists = await vsExists(folderPath);
        this.debugLogger.log(`🔍 [Create Post] Folder exists: ${folderExists}`);
        
        if (!folderExists) {
            this.debugLogger.log(`⚠️ Folder no longer exists: ${relativePath}`);
            return;
        }
        
        // Look for HTML file (using VS Code FS API)
        const dirContents = await vsReadDir(folderPath);
        this.debugLogger.log(`🔍 [Create Post] Dir contents: ${JSON.stringify(dirContents.map(([n, t]) => `${n}(${t})`))}`);
        
        const htmlFiles = dirContents
            .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.html'))
            .map(([name]) => name);
        
        this.debugLogger.log(`🔍 [Create Post] HTML files found: ${JSON.stringify(htmlFiles)}`);
        
        if (htmlFiles.length === 0) {
            this.debugLogger.log(`⏳ No HTML file yet in ${relativePath}, will retry when HTML is added...`);
            // Don't add to processedNewFolders - the HTML 'add' event will trigger another attempt
            return;
        }
        
        // Mark as processed to prevent duplicate calls
        this.processedNewFolders.add(folderPath);
        this.debugLogger.log(`✓ HTML file found: ${htmlFiles[0]}`);
        
        // Map folder name to post type
        const postType = this.mapFolderToPostType(postTypeFolder);
        
        this.debugLogger.log(`📄 Creating ${postType} from: ${relativePath}`);
        this.statusBar.showSyncing(`Creating ${postType}...`);
        
        try {
            // Pass skip_rename=true so IDE does the rename via VS Code API
            // This ensures open editors (including AI's) are automatically updated
            const response = await this.restClient.createPostFromFolder(relativePath, postType, true);
            
            if (response.success && response.post_id) {
                this.statusBar.showSuccess(`Created: ${response.title}`);
                this.debugLogger.log(
                    `✅ Created ${postType} "${response.title}" (ID: ${response.post_id})`
                );
                
                // Do the rename via VS Code API - this updates all open editors automatically!
                const newFolderName = `${response.slug}_${response.post_id}`;
                const newFolderPath = posixJoin(this.devFolder, `post-types/${postTypeFolder}/${newFolderName}`);
                
                // IMPORTANT: Track the rename BEFORE we start, so trash handler knows to skip it
                this.recentlyRenamedFolders.set(folderName, {
                    newFolder: newFolderName,
                    postId: response.post_id,
                    timestamp: Date.now()
                });
                this.debugLogger.log(`   📝 Pre-tracking rename: "${folderName}" → "${newFolderName}"`);
                
                // Mark the new folder as processed too (so we don't try to create again)
                this.processedNewFolders.add(newFolderPath);
                
                await this.renameViaVSCode(folderPath, newFolderPath, folderName, newFolderName);
                
                this.debugLogger.log(`   Folder renamed: ${folderName} → ${newFolderName}`);
                
                // Update response with actual new folder path for notification
                response.new_folder = `post-types/${postTypeFolder}/${newFolderName}`;
                
                // Write notification for AI - same format as AI request flow
                // This allows AI to know the new folder path after auto-rename
                await this.writePostCreationNotification(response, postType);
                
                // Show notification
                const config = vscode.workspace.getConfiguration('skylit');
                if (config.get<boolean>('showNotifications', true)) {
                    vscode.window.showInformationMessage(
                        `✅ Created ${postType}: ${response.title} (ID: ${response.post_id})`
                    );
                }
            } else {
                this.debugLogger.log(`⚠️ Could not create post: ${response.error}`);
                this.statusBar.showError(response.error || 'Failed to create post');
                // Remove from processed so it can be retried
                this.processedNewFolders.delete(folderPath);
            }
        } catch (error: any) {
            this.debugLogger.log(`❌ Failed to create post: ${error.message}`);
            this.processedNewFolders.delete(folderPath);
            this.statusBar.showError(`Failed: ${error.message}`);
            vscode.window.showErrorMessage(`Failed to create ${postType}: ${error.message}`);
        }
    }
    
    /**
     * Rename folder and files using VS Code's WorkspaceEdit API
     * This ensures all open editors (including AI's) are automatically updated
     */
    private async renameViaVSCode(
        oldFolderPath: string,
        newFolderPath: string,
        oldFolderName: string,
        newFolderName: string
    ) {
        this.debugLogger.log(`🔄 [VS Code Rename] ${oldFolderName} → ${newFolderName}`);
        
        try {
            // Check if target folder already exists (server already renamed)
            const targetExists = await vsExists(newFolderPath);
            const sourceExists = await vsExists(oldFolderPath);
            
            if (targetExists && !sourceExists) {
                // Server already renamed the folder - just rename files inside
                this.debugLogger.log(`   ℹ️ Target folder already exists (server renamed). Renaming files inside...`);
                await this.renameFilesInFolder(newFolderPath, oldFolderName, newFolderName);
                return;
            }
            
            if (targetExists && sourceExists) {
                // Both exist - merge source into target, then delete source
                this.debugLogger.log(`   ℹ️ Both folders exist. Merging...`);
                await this.mergeAndRenameFolders(oldFolderPath, newFolderPath, oldFolderName, newFolderName);
                return;
            }
            
            if (!sourceExists) {
                // Source doesn't exist - nothing to rename
                this.debugLogger.log(`   ⚠️ Source folder doesn't exist. Skipping rename.`);
                return;
            }
            
            // Normal case: rename folder using VS Code API
            // First, rename the folder itself
            const edit = new vscode.WorkspaceEdit();
            edit.renameFile(
                pathToUri(oldFolderPath),
                pathToUri(newFolderPath),
                { overwrite: false }
            );
            
            const folderSuccess = await vscode.workspace.applyEdit(edit);
            
            if (folderSuccess) {
                this.debugLogger.log(`   ✅ Folder renamed via VS Code API`);
                // Now rename files inside the new folder
                await this.renameFilesInFolder(newFolderPath, oldFolderName, newFolderName);
            } else {
                this.debugLogger.log(`   ⚠️ VS Code folder rename failed, trying fs.rename...`);
                
                // Fallback to filesystem rename
                await vscode.workspace.fs.rename(
                    pathToUri(oldFolderPath),
                    pathToUri(newFolderPath),
                    { overwrite: false }
                );
                
                await this.renameFilesInFolder(newFolderPath, oldFolderName, newFolderName);
            }
            
            this.debugLogger.log(`✅ [VS Code Rename] Complete`);
            
        } catch (error: any) {
            this.debugLogger.log(`❌ [VS Code Rename] Error: ${error.message}`);
            // Don't throw - the post was created successfully, rename is secondary
            // The folder might already be renamed by the server (old plugin version)
        }
    }
    
    /**
     * Rename files inside a folder to match the new folder name
     */
    private async renameFilesInFolder(
        folderPath: string,
        oldPrefix: string,
        newPrefix: string
    ) {
        try {
            const files = await vsReadDir(folderPath);
            const edit = new vscode.WorkspaceEdit();
            let hasRenames = false;
            
            for (const [fileName, fileType] of files) {
                if (fileType === vscode.FileType.File && fileName.startsWith(oldPrefix)) {
                    const newFileName = fileName.replace(oldPrefix, newPrefix);
                    if (newFileName !== fileName) {
                        const oldFilePath = posixJoin(folderPath, fileName);
                        const newFilePath = posixJoin(folderPath, newFileName);
                        
                        edit.renameFile(
                            pathToUri(oldFilePath),
                            pathToUri(newFilePath),
                            { overwrite: true }
                        );
                        
                        this.debugLogger.log(`   📄 ${fileName} → ${newFileName}`);
                        hasRenames = true;
                    }
                }
            }
            
            if (hasRenames) {
                const success = await vscode.workspace.applyEdit(edit);
                if (!success) {
                    // Fallback to individual renames
                    for (const [fileName, fileType] of files) {
                        if (fileType === vscode.FileType.File && fileName.startsWith(oldPrefix)) {
                            const newFileName = fileName.replace(oldPrefix, newPrefix);
                            if (newFileName !== fileName) {
                                const oldFilePath = posixJoin(folderPath, fileName);
                                const newFilePath = posixJoin(folderPath, newFileName);
                                await vscode.workspace.fs.rename(
                                    pathToUri(oldFilePath),
                                    pathToUri(newFilePath),
                                    { overwrite: true }
                                );
                            }
                        }
                    }
                }
            }
        } catch (error: any) {
            this.debugLogger.log(`   ⚠️ File rename error: ${error.message}`);
        }
    }
    
    /**
     * Merge source folder into target folder, renaming files as needed
     */
    private async mergeAndRenameFolders(
        sourcePath: string,
        targetPath: string,
        oldPrefix: string,
        newPrefix: string
    ) {
        try {
            const sourceFiles = await vsReadDir(sourcePath);
            
            for (const [fileName, fileType] of sourceFiles) {
                if (fileType === vscode.FileType.File) {
                    const sourceFilePath = posixJoin(sourcePath, fileName);
                    const newFileName = fileName.startsWith(oldPrefix) 
                        ? fileName.replace(oldPrefix, newPrefix)
                        : fileName;
                    const targetFilePath = posixJoin(targetPath, newFileName);
                    
                    // Move file from source to target
                    try {
                        await vscode.workspace.fs.rename(
                            pathToUri(sourceFilePath),
                            pathToUri(targetFilePath),
                            { overwrite: true }
                        );
                        this.debugLogger.log(`   📄 Merged: ${fileName} → ${newFileName}`);
                    } catch (e) {
                        // File might already exist in target
                    }
                }
            }
            
            // Delete empty source folder
            try {
                await vscode.workspace.fs.delete(pathToUri(sourcePath), { recursive: true });
                this.debugLogger.log(`   🗑️ Deleted source folder: ${path.basename(sourcePath)}`);
            } catch (e) {
                // Non-critical
            }
            
            // Rename any remaining files in target with old prefix
            await this.renameFilesInFolder(targetPath, oldPrefix, newPrefix);
            
        } catch (error: any) {
            this.debugLogger.log(`   ⚠️ Merge error: ${error.message}`);
        }
    }
    
    /**
     * Write a notification file for AI agents when a post is created
     * This allows AI to know the new folder path after auto-rename
     * Same format as processAICreatePostRequest for consistency
     */
    private async writePostCreationNotification(
        response: { post_id?: number; title?: string; new_folder?: string; slug?: string },
        postType: string
    ) {
        if (!response.post_id) {
            return; // No post ID, nothing to write
        }
        const skylitPath = posixJoin(this.devFolder, '.skylit');
        const resultFile = posixJoin(skylitPath, 'last-created-post.json');
        
        try {
            // Ensure .skylit folder exists
            const skylitUri = pathToUri(skylitPath);
            try {
                await vscode.workspace.fs.stat(skylitUri);
            } catch {
                await vscode.workspace.fs.createDirectory(skylitUri);
            }
            
            // Extract slug from new folder name (e.g., "my-page_550" -> "my-page")
            const slug = response.slug || (response.new_folder ? response.new_folder.replace(/_\d+$/, '') : '');
            const folderName = response.new_folder || '';
            const fullPath = `${this.devFolder.replace(/\\/g, '/')}/${response.new_folder || ''}`;
            
            const resultData = {
                success: true,
                post_id: response.post_id,
                post_type: postType,
                title: response.title || '',
                slug: slug,
                folder_name: folderName,
                folder_path: response.new_folder || '',
                full_path: fullPath,
                html_file: `${fullPath}/${folderName}.html`,
                css_file: `${fullPath}/${folderName}.css`,
                created_at: new Date().toISOString(),
                auto_created: true // Flag to indicate this was auto-created (not via AI request)
            };
            
            // Write result
            await vsWriteFile(resultFile, JSON.stringify(resultData, null, 2));
            
            this.debugLogger.log(`📝 [Folder Auto-Create] Notification written to: ${resultFile}`);
            this.debugLogger.log(`   AI can now read this to know the new path: ${folderName}`);
            
        } catch (error: any) {
            this.debugLogger.log(`⚠️ Could not write notification file: ${error.message}`);
            // Non-critical - don't throw
        }
    }
    
    /**
     * Redirect a duplicate folder (AI recreated old folder after rename)
     * Moves content to existing folder and deletes duplicate
     */
    private async redirectDuplicateFolder(
        duplicateFolderPath: string,
        renameInfo: { newFolder: string; postId: number; timestamp: number },
        postTypeFolder: string
    ) {
        try {
            const oldFolderName = path.basename(duplicateFolderPath);
            const targetFolderPath = duplicateFolderPath.replace(
                `/${oldFolderName}`,
                `/${renameInfo.newFolder}`
            );
            
            this.debugLogger.log(`🔄 [Redirect] Moving duplicate "${oldFolderName}" content to "${renameInfo.newFolder}"`);
            
            // Check if target folder exists
            const targetExists = await vsExists(targetFolderPath);
            if (!targetExists) {
                this.debugLogger.log(`⚠️ [Redirect] Target folder doesn't exist: ${renameInfo.newFolder}`);
                return;
            }
            
            // Read contents of duplicate folder
            const duplicateContents = await vsReadDir(duplicateFolderPath);
            
            // Copy each file from duplicate to target (overwriting)
            for (const [fileName, fileType] of duplicateContents) {
                if (fileType === vscode.FileType.File) {
                    const srcPath = posixJoin(duplicateFolderPath, fileName);
                    // Rename files to match target folder name
                    const newFileName = fileName.replace(
                        new RegExp(`^${oldFolderName}`),
                        renameInfo.newFolder
                    );
                    const destPath = posixJoin(targetFolderPath, newFileName);
                    
                    try {
                        const content = await vsReadFile(srcPath);
                        await vsWriteFile(destPath, content);
                        this.debugLogger.log(`   ✅ Merged: ${fileName} → ${newFileName}`);
                    } catch (err: any) {
                        this.debugLogger.log(`   ⚠️ Could not merge ${fileName}: ${err.message}`);
                    }
                }
            }
            
            // Delete the duplicate folder
            try {
                await vscode.workspace.fs.delete(pathToUri(duplicateFolderPath), { recursive: true });
                this.debugLogger.log(`🗑️ [Redirect] Deleted duplicate folder: ${oldFolderName}`);
            } catch (deleteErr: any) {
                this.debugLogger.log(`⚠️ [Redirect] Could not delete duplicate folder: ${deleteErr.message}`);
            }
            
            // Write notification so AI knows where the files went
            await this.writePostCreationNotification({
                post_id: renameInfo.postId,
                new_folder: `post-types/${postTypeFolder}/${renameInfo.newFolder}`,
                slug: renameInfo.newFolder.replace(/_\d+$/, '')
            }, postTypeFolder === 'pages' ? 'page' : 'post');
            
            // IMPORTANT: Clear the tracking after successful merge
            // This allows future folders with the same name to create NEW posts
            this.recentlyRenamedFolders.delete(oldFolderName);
            this.debugLogger.log(`🧹 [Redirect] Cleared rename tracking for "${oldFolderName}"`);
            
            vscode.window.showInformationMessage(
                `🔄 Merged duplicate folder "${oldFolderName}" into existing "${renameInfo.newFolder}"`
            );
            
        } catch (error: any) {
            this.debugLogger.log(`❌ [Redirect] Failed to redirect duplicate folder: ${error.message}`);
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
            const newFolderPath = posixJoin(this.devFolder, newRelativePath);
            const newFolderName = path.basename(newFolderPath);
            const newHtmlPath = posixJoin(newFolderPath, `${newFolderName}.html`);
            
            // Find any open editors with files from the old folder
            const oldFolderPathNormalized = oldFolderPath.replace(/\\/g, '/');
            
            for (const tabGroup of vscode.window.tabGroups.all) {
                for (const tab of tabGroup.tabs) {
                    if (tab.input instanceof vscode.TabInputText) {
                        const uri = tab.input.uri;
                        const uriPath = uri.fsPath.replace(/\\/g, '/');
                        
                        // Check if this file was from the old folder
                        if (uriPath.startsWith(oldFolderPathNormalized)) {
                            this.debugLogger.log(`📂 Closing old file: ${path.basename(uriPath)}`);
                            
                            // Close the old tab
                            await vscode.window.tabGroups.close(tab);
                        }
                    }
                }
            }
            
            // Open the new file (using VS Code FS API for SSH compatibility)
            if (await vsExists(newHtmlPath)) {
                this.debugLogger.log(`📂 Opening new file: ${newFolderName}.html`);
                const newUri = vscode.Uri.file(newHtmlPath);
                await vscode.window.showTextDocument(newUri);
            }
        } catch (error: any) {
            this.debugLogger.log(`⚠️ Could not update open editors: ${error.message}`);
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
     * Uses VS Code's workspace.fs API for SSH compatibility
     */
    private async scanForNewFolders(postTypesPath: string) {
        this.debugLogger.log('🔍 Scanning for folders without post IDs...');
        
        try {
            // Get all post type subdirectories (pages, posts, etc.) using VS Code FS API
            const postTypeDirEntries = await vsReadDir(postTypesPath);
            const postTypeDirs = postTypeDirEntries
                .filter(([name, type]) => 
                    type === vscode.FileType.Directory && 
                    !name.startsWith('.') && 
                    name !== '_trash'
                );
            
            if (postTypeDirs.length === 0) {
                this.debugLogger.log('   ℹ️ No post-type folders found (pages, posts, etc.)');
                return;
            }
            
            let foundCount = 0;
            let createdCount = 0;
            
            for (const [postTypeDirName] of postTypeDirs) {
                const postTypePath = posixJoin(postTypesPath, postTypeDirName);
                const postType = this.mapFolderToPostType(postTypeDirName);
                
                // Get content folders within this post type (using VS Code FS API)
                const contentFolderEntries = await vsReadDir(postTypePath);
                const contentFolders = contentFolderEntries
                    .filter(([name, type]) => 
                        type === vscode.FileType.Directory && 
                        !name.startsWith('.') && 
                        name !== '_trash' &&
                        name !== 'block-styles'
                    );
                
                for (const [folderName] of contentFolders) {
                    const folderPath = posixJoin(postTypePath, folderName);
                    
                    // Skip if already has _ID suffix
                    if (/_\d+$/.test(folderName)) {
                        continue;
                    }
                    
                    // Check if has HTML file (using VS Code FS API)
                    const files = await vsReadDir(folderPath);
                    const hasHtml = files.some(([name, type]) => 
                        type === vscode.FileType.File && name.endsWith('.html')
                    );
                    
                    if (!hasHtml) {
                        this.debugLogger.log(`   ⏭️ Skipping ${folderName} (no HTML file)`);
                        continue;
                    }
                    
                    foundCount++;
                    this.debugLogger.log(`   📁 Found new folder: ${postTypeDirName}/${folderName}`);
                    
                    // Build relative path for API call
                    const relativePath = `post-types/${postTypeDirName}/${folderName}`;
                    
                    // Create the post
                    try {
                        const response = await this.restClient.createPostFromFolder(relativePath, postType);
                        
                        if (response.success && response.post_id) {
                            createdCount++;
                            this.debugLogger.log(
                                `   ✅ Created ${postType} "${response.title}" (ID: ${response.post_id})`
                            );
                            
                            // Mark as processed
                            this.processedNewFolders.add(folderPath);
                        } else {
                            this.debugLogger.log(`   ⚠️ Could not create: ${response.error}`);
                        }
                    } catch (error: any) {
                        this.debugLogger.log(`   ❌ Error creating post: ${error.message}`);
                    }
                }
            }
            
            if (foundCount === 0) {
                this.debugLogger.log('   ✅ No new folders found (all have post IDs)');
            } else {
                this.debugLogger.log(`🔍 Scan complete: ${createdCount}/${foundCount} posts created`);
                
                // Log to output only, no popup
                if (createdCount > 0) {
                    this.debugLogger.log(`✅ Created ${createdCount} new WordPress post(s) from dev folder`);
                }
            }
        } catch (error: any) {
            this.debugLogger.log(`❌ Scan error: ${error.message}`);
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
                this.debugLogger.log('⚠️ Could not get theme path, bi-directional sync disabled');
                return;
            }

            this.debugLogger.log(`👀 Starting theme watcher for bi-directional sync: ${this.themePath}`);

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
                this.debugLogger.log(`❌ Theme watcher error: ${error.message}`);
            });

            this.debugLogger.log('✅ Theme watcher started (bi-directional sync enabled)');

        } catch (error: any) {
            this.debugLogger.log(`⚠️ Could not start theme watcher: ${error.message}`);
            this.debugLogger.log('   Bi-directional sync will be disabled');
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
            this.debugLogger.log(
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
        
        this.debugLogger.log(`🔄 Theme ${fileType} changed: ${relativePath}, syncing to dev folder...`);

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
                this.debugLogger.log(`✅ ${fileName} synced from theme to dev folder`);
                
                // Show notification if enabled
                // No popup notification - status bar shows connection
            }
        } catch (error: any) {
            this.debugLogger.log(`❌ Theme→dev sync error: ${error.message}`);
        }
    }

    /**
     * Handle potential trash/restore action from folder movement
     * This is called when a folder is added or removed from the filesystem
     * 
     * Key insight: When WordPress renames a folder, VS Code may fire events in either order:
     * - CREATE then DELETE, OR
     * - DELETE then CREATE
     * We need to handle both cases to avoid sending spurious restore API calls.
     */
    private handlePotentialTrashAction(dirPath: string, eventType: 'add' | 'unlink') {
        // Normalize path separators for cross-platform compatibility
        const normalizedPath = dirPath.replace(/\\/g, '/');
        
        this.debugLogger.log(`🔍 [Handle Trash] Processing ${eventType} for: ${normalizedPath}`);
        
        // Check if this is a post type folder (contains _ID suffix pattern)
        const folderName = path.basename(normalizedPath);
        const postIdMatch = folderName.match(/_(\d+)$/);
        
        if (!postIdMatch) {
            // Not a post folder (doesn't have _ID suffix), skip
            this.debugLogger.log(`🔍 [Handle Trash] Skipping - no _ID suffix in: ${folderName}`);
            return;
        }

        const postId = parseInt(postIdMatch[1], 10);
        this.debugLogger.log(`🔍 [Handle Trash] Found Post ID: ${postId}`);

        // Check if this folder is inside a _trash directory
        const isInTrash = normalizedPath.includes('/_trash/');
        this.debugLogger.log(`🔍 [Handle Trash] Is in trash: ${isInTrash}, Event type: ${eventType}`);
        
        // Handle DELETE events - track for rename detection
        if (eventType === 'unlink' && !isInTrash) {
            // Folder deleted outside trash
            // This could be: (1) start of rename, (2) completion of rename (DELETE after CREATE)
            
            // Check if there's a pending restore for this post - if so, it was a rename!
            const pendingRestore = this.pendingRestoreTimers.get(postId);
            if (pendingRestore) {
                clearTimeout(pendingRestore);
                this.pendingRestoreTimers.delete(postId);
                this.debugLogger.log(`🔄 [Handle Trash] RENAME detected (CREATE→DELETE): cancelled pending restore for post ${postId}`);
                this.debugLogger.log(`🔄 [Handle Trash] Skipping API call - WordPress initiated this rename`);
                return;
            }
            
            // Track this delete in case CREATE comes later
            this.recentFolderDeletes.set(postId, {
                path: normalizedPath,
                timestamp: Date.now()
            });
            this.debugLogger.log(`🔍 [Handle Trash] Tracking potential rename (DELETE first) for post ${postId}`);
            
            // Clear after 3 seconds
            setTimeout(() => {
                const tracked = this.recentFolderDeletes.get(postId);
                if (tracked && Date.now() - tracked.timestamp >= 3000) {
                    this.recentFolderDeletes.delete(postId);
                }
            }, 3100);
            return; // Don't process DELETE outside trash as any action
        }
        
        // Determine the action based on event type and location
        let action: 'trash' | 'restore' | null = null;

        if (eventType === 'add' && isInTrash) {
            // Folder appeared IN _trash → it was TRASHED
            action = 'trash';
            this.debugLogger.log(`🗑️ Detected folder moved TO trash: ${folderName} (Post ID: ${postId})`);
        } else if (eventType === 'unlink' && isInTrash) {
            // Folder disappeared FROM _trash → it was RESTORED
            action = 'restore';
            this.debugLogger.log(`♻️ Detected folder moved FROM trash: ${folderName} (Post ID: ${postId})`);
        } else if (eventType === 'add' && !isInTrash && normalizedPath.includes('/post-types/')) {
            // Folder appeared OUTSIDE _trash in post-types
            // Check if this is a rename (DELETE came first)
            const recentDelete = this.recentFolderDeletes.get(postId);
            if (recentDelete && (Date.now() - recentDelete.timestamp) < 3000) {
                // DELETE came first → this is a rename (DELETE→CREATE)
                this.debugLogger.log(`🔄 [Handle Trash] RENAME detected (DELETE→CREATE): ${path.basename(recentDelete.path)} → ${folderName}`);
                this.debugLogger.log(`🔄 [Handle Trash] Skipping API call - WordPress initiated this rename`);
                this.recentFolderDeletes.delete(postId);
                return;
            }
            
            // Check if this folder was just created by OUR rename operation (not a restore)
            // Look through recentlyRenamedFolders to see if this is the NEW folder we just created
            for (const [oldName, renameInfo] of this.recentlyRenamedFolders.entries()) {
                if (renameInfo.newFolder === folderName && renameInfo.postId === postId) {
                    const ageMs = Date.now() - renameInfo.timestamp;
                    if (ageMs < 30000) { // Within last 30 seconds
                        this.debugLogger.log(`🔄 [Handle Trash] Skipping - this is our own rename: ${oldName} → ${folderName}`);
                        return;
                    }
                }
            }
            
            // No recent delete - might be restore, but wait to see if DELETE follows
            this.debugLogger.log(`🔍 [Handle Trash] Folder appeared outside trash - waiting to detect rename pattern...`);
            
            // Schedule a delayed restore (can be cancelled if DELETE arrives)
            const existingTimer = this.pendingRestoreTimers.get(postId);
            if (existingTimer) {
                clearTimeout(existingTimer);
            }
            
            const timer = setTimeout(() => {
                this.pendingRestoreTimers.delete(postId);
                
                // Double-check if this was our rename before triggering restore
                for (const [oldName, renameInfo] of this.recentlyRenamedFolders.entries()) {
                    if (renameInfo.newFolder === folderName && renameInfo.postId === postId) {
                        const ageMs = Date.now() - renameInfo.timestamp;
                        if (ageMs < 30000) {
                            this.debugLogger.log(`🔄 [Handle Trash] Skipping restore - this was our rename: ${oldName} → ${folderName}`);
                            return;
                        }
                    }
                }
                
                this.debugLogger.log(`♻️ Detected restore (no DELETE followed): ${folderName} (Post ID: ${postId})`);
                this.debounceFolderAction(postId, 'restore');
            }, 1000); // Wait 1 second for potential DELETE event
            
            this.pendingRestoreTimers.set(postId, timer);
            return; // Don't process immediately - wait for potential rename detection
        } else {
            this.debugLogger.log(`🔍 [Handle Trash] No action determined (eventType=${eventType}, isInTrash=${isInTrash})`);
        }

        if (!action) {
            // Not a trash-related action, skip
            this.debugLogger.log(`🔍 [Handle Trash] Skipping - no action determined`);
            return;
        }

        // Debounce to prevent double-fires (moving a folder can trigger multiple events)
        this.debounceFolderAction(postId, action);
    }

    /**
     * Debounce folder action to prevent duplicate API calls
     * Moving a folder can trigger multiple filesystem events
     * Also checks for mass actions and prompts for confirmation
     */
    private async debounceFolderAction(postId: number, action: 'trash' | 'restore') {
        const key = `${postId}-${action}`;

        // Check cooldown - don't process if we just processed this post
        const now = Date.now();
        const lastActionTime = this.lastFolderActionTime.get(postId) || 0;
        const timeSinceLastAction = now - lastActionTime;

        if (timeSinceLastAction < this.folderActionCooldownMs) {
            this.debugLogger.log(
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
            
            // Check for mass operations (safety feature)
            const pendingActions = this.folderActionTimers.size;
            if (pendingActions > 5) {
                // Multiple folder actions queued - confirm with user
                const actionVerb = action === 'trash' ? 'trash' : 'restore';
                const choice = await vscode.window.showWarningMessage(
                    `⚠️ Bulk Operation Detected\n\n${pendingActions} folders will be ${actionVerb}ed in WordPress.\n\nContinue?`,
                    { modal: true },
                    'Yes, Continue',
                    'Cancel All'
                );

                if (choice !== 'Yes, Continue') {
                    // Cancel all pending actions
                    this.debugLogger.log(`❌ User cancelled bulk ${action} operation (${pendingActions} pending)`);
                    this.folderActionTimers.forEach((t) => clearTimeout(t));
                    this.folderActionTimers.clear();
                    return;
                }
                
                this.debugLogger.log(`✅ User confirmed bulk ${action} operation (${pendingActions} folders)`);
            }
            
            await this.executeFolderAction(postId, action);
        }, this.folderActionDebounceMs);

        this.folderActionTimers.set(key, timer);
    }

    /**
     * Execute folder action (trash/restore) after debounce
     */
    private async executeFolderAction(postId: number, action: 'trash' | 'restore') {
        try {
            this.debugLogger.log(`📤 Sending ${action} action for post ${postId}...`);

            // Send folder action to WordPress
            const response = await this.restClient.sendFolderAction(postId, action);

            // Record action time AFTER successful action
            this.lastFolderActionTime.set(postId, Date.now());

            if (response.success) {
                const actionVerb = action === 'trash' ? 'trashed' : 'restored';
                this.debugLogger.log(`✅ Post ${postId} ${actionVerb} successfully`);
                
                // Show notification
                const config = vscode.workspace.getConfiguration('skylit');
                if (config.get<boolean>('showNotifications', true)) {
                    vscode.window.showInformationMessage(
                        `✅ Post ${postId} ${actionVerb} in WordPress`
                    );
                }
            }

        } catch (error: any) {
            this.debugLogger.log(`❌ Folder action error: ${error.message}`);
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
            this.debugLogger.log(
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
        
        this.debugLogger.log(`📦 ${fileType} changed: ${relativePath}, syncing to theme...`);
        
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
                this.debugLogger.log(`✅ ${relativePath} synced to theme`);
                
                const config = vscode.workspace.getConfiguration('skylit');
                if (config.get<boolean>('showNotifications', true)) {
                    vscode.window.showInformationMessage(`✅ ${fileName} synced to theme`);
                }
            }
        } catch (error: any) {
            this.debugLogger.log(`❌ Theme sync error: ${error.message}`);
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
            this.debugLogger.log(
                `⏸️ Skipping dev→theme sync (cooldown: ${Math.round((this.syncCooldownMs - timeSinceLastSync) / 1000)}s remaining)`
            );
            return;
        }
        
        const assetType = isCss ? 'CSS' : isJs ? 'JS' : 'asset';
        this.debugLogger.log(`📦 ${assetType} asset changed: ${fileName}, syncing to theme...`);
        
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
                this.debugLogger.log(`✅ ${fileName} synced to active theme`);
                
                // No popup notification - status bar is enough
            }
        } catch (error: any) {
            this.debugLogger.log(`❌ Asset sync error: ${error.message}`);
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
            this.debugLogger.log(
                `⏸️ Skipping dev→theme PHP sync (cooldown: ${Math.round((this.syncCooldownMs - timeSinceLastSync) / 1000)}s remaining)`
            );
            return;
        }
        
        this.debugLogger.log(`📄 PHP include changed: ${fileName}, syncing to theme...`);
        
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
                this.debugLogger.log(`✅ ${fileName} synced to active theme`);
                
                // No popup notification - status bar is enough
            }
        } catch (error: any) {
            this.debugLogger.log(`❌ PHP sync error: ${error.message}`);
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
            this.debugLogger.log(
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
        
        this.debugLogger.log(`🎨 ${fileType} changed: ${fileName}, syncing to theme...`);
        
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
                this.debugLogger.log(`✅ ${fileName} synced to active theme`);
                
                const config = vscode.workspace.getConfiguration('skylit');
                if (config.get<boolean>('showNotifications', true)) {
                    vscode.window.showInformationMessage(`✅ ${fileName} synced to theme`);
                }
            }
        } catch (error: any) {
            this.debugLogger.log(`❌ Theme structure sync error: ${error.message}`);
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
                this.debugLogger.log(
                    `⏸️ Skipping sync (cooldown: ${Math.round((this.syncCooldownMs - timeSinceLastSync) / 1000)}s remaining)`
                );
                return;
            }

            // Extract post info from file path
            const postInfo = this.extractPostInfo(filePath);
            if (!postInfo) {
                this.debugLogger.log(`⚠️ Cannot extract post info from: ${filePath}`);
                return;
            }

            const { postId, postFolder } = postInfo;
            const fileName = path.basename(filePath);

            // CRITICAL: Check if this change was caused by a recent WordPress export
            // This prevents circular sync: IDE → WP → Export → IDE detects change → loop
            try {
                const checkResult = await this.restClient.checkForChanges(postId);
                if (checkResult.skip_import) {
                    this.debugLogger.log(
                        `⏭️ Skipping sync (recent export - circular sync prevention)`
                    );
                    
                    // WordPress just exported - try to restore folding for unchanged blocks
                    await this.restoreFoldingForUnchangedBlocks(filePath, postId);
                    
                    return;
                }
            } catch (error) {
                // If check fails, continue with sync (better to sync than skip)
                this.debugLogger.log(`⚠️ Could not check export status, proceeding with sync`);
            }
            
            // Save folding state BEFORE syncing (in case WordPress exports back)
            await this.foldingManager.saveFoldingState(filePath);

            // Show syncing status
            this.statusBar.showSyncing(fileName);

            // Read HTML and CSS files
            const htmlPath = posixJoin(postFolder, `${path.basename(postFolder)}.html`);
            const cssPath = posixJoin(postFolder, `${path.basename(postFolder)}.css`);

            let html = '';
            let css = '';

            // Use VS Code FS API for SSH compatibility
            if (await vsExists(htmlPath)) {
                html = await vsReadFile(htmlPath);
            }

            if (await vsExists(cssPath)) {
                css = await vsReadFile(cssPath);
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
            this.debugLogger.log(`❌ Sync error: ${error.message}`);
            vscode.window.showErrorMessage(`Sync failed: ${error.message}`);
        }
    }

    /**
     * Restore folding state for unchanged blocks after WordPress export
     * Fetches block change info from API and restores folds for unchanged blocks
     */
    private async restoreFoldingForUnchangedBlocks(filePath: string, postId: number): Promise<void> {
        try {
            // Give VS Code a moment to reload the file
            await new Promise(resolve => setTimeout(resolve, 300));
            
            // Fetch block changes from WordPress
            const blockChanges = await this.restClient.getBlockChanges(postId);
            
            if (!blockChanges.success || !blockChanges.has_data) {
                this.debugLogger.log('📂 No block change data available for folding restoration');
                return;
            }
            
            const unchangedBlocks = blockChanges.unchanged_blocks || [];
            
            if (unchangedBlocks.length === 0) {
                this.debugLogger.log('📂 No unchanged blocks to restore folds for');
                return;
            }
            
            this.debugLogger.log(
                `📂 Block changes: ${blockChanges.blocks_changed} changed, ${blockChanges.blocks_unchanged} unchanged`
            );
            
            // If file was unchanged, all blocks keep their folding
            if (blockChanges.file_unchanged) {
                this.debugLogger.log('📂 File unchanged - all folding preserved');
                return;
            }
            
            // Restore folding for unchanged blocks
            await this.foldingManager.restoreFoldingState(filePath, unchangedBlocks);
            
        } catch (error: any) {
            // Don't fail silently but also don't spam errors
            this.debugLogger.log(`⚠️ Could not restore folding: ${error.message}`);
        }
    }

    /**
     * Extract post ID and folder from file path
     * Format: /post-types/pages/about-us_123/about-us_123.html
     */
    private extractPostInfo(filePath: string): { postId: number; postFolder: string } | null {
        // Normalize path
        const normalizedPath = filePath.replace(/\\/g, '/');
        
        // Determine if this is a file or folder based on extension
        // Files have extensions like .html, .css, .json
        const hasExtension = /\.[a-zA-Z0-9]+$/.test(path.basename(normalizedPath));
        const folder = hasExtension ? path.dirname(normalizedPath) : normalizedPath;
        const folderName = path.basename(folder);

        // Extract post ID from folder name (format: slug_ID)
        const match = folderName.match(/_(\d+)$/);
        if (!match) {
            return null;
        }

        const postId = parseInt(match[1], 10);
        
        return {
            postId,
            postFolder: folder.replace(/\\/g, '/')
        };
    }

    /**
     * Start cursor tracking for Gutenberg block selection sync
     * When cursor moves in IDE, updates .skylit/active-block.txt
     * GT polls this to keep block selection in sync
     */
    private startCursorTracking() {
        if (!this.cursorTrackingEnabled) {
            this.debugLogger.log('⏭️ Cursor tracking disabled via settings');
            return;
        }
        
        this.debugLogger.log('🎯 Starting cursor tracking for Gutenberg sync');
        this.debugLogger.log(`   Dev folder: ${this.devFolder}`);
        
        this.cursorSelectionListener = vscode.window.onDidChangeTextEditorSelection((e) => {
            this.handleCursorChange(e);
        });
    }
    
    /**
     * Handle cursor position change with debouncing
     */
    private handleCursorChange(e: vscode.TextEditorSelectionChangeEvent) {
        const filePath = e.textEditor.document.uri.fsPath.replace(/\\/g, '/');
        
        // Only track HTML files in post-types folder
        if (!filePath.includes('/post-types/') || !filePath.endsWith('.html')) {
            return;
        }
        
        // Clear existing debounce timer
        if (this.cursorDebounceTimer) {
            clearTimeout(this.cursorDebounceTimer);
        }
        
        // Debounce: wait 200ms after cursor stops moving
        this.cursorDebounceTimer = setTimeout(() => {
            this.processCursorPosition(e.textEditor);
        }, 200);
    }
    
    /**
     * Process cursor position and update active block file
     */
    private async processCursorPosition(editor: vscode.TextEditor) {
        try {
            const filePath = editor.document.uri.fsPath.replace(/\\/g, '/');
            const cursorLine = editor.selection.active.line + 1; // 1-based
            
            this.debugLogger.log(`🎯 [Cursor] Processing: line ${cursorLine} in ${filePath.split('/').pop()}`);
            
            // Extract post ID from parent directory (e.g., "homepage_65/homepage_65.html" → 65)
            // The folder name contains the _ID suffix, not the file name
            const parentDir = path.dirname(filePath);
            const postId = this.extractPostIdFromPath(parentDir);
            if (!postId) {
                this.debugLogger.log(`🎯 [Cursor] ❌ Could not extract post ID from folder: ${path.basename(parentDir)}`);
                return;
            }
            
            this.debugLogger.log(`🎯 [Cursor] Post ID: ${postId}`);
            
            // Read metadata JSON for this post
            const metadataPath = posixJoin(this.devFolder, '.skylit', 'metadata', `${postId}.json`);
            
            this.debugLogger.log(`🎯 [Cursor] Metadata path: ${metadataPath}`);
            
            if (!await vsExists(metadataPath)) {
                this.debugLogger.log(`🎯 [Cursor] ❌ Metadata file does not exist`);
                return;
            }
            
            const metadataContent = await vsReadFile(metadataPath);
            const metadata = JSON.parse(metadataContent);
            
            if (!metadata.blocks || metadata.blocks.length === 0) {
                this.debugLogger.log(`🎯 [Cursor] ❌ No blocks in metadata`);
                return;
            }
            
            this.debugLogger.log(`🎯 [Cursor] Found ${metadata.blocks.length} blocks in metadata`);
            
            // Find block for current cursor line
            const block = this.findBlockForLine(metadata.blocks, cursorLine);
            
            if (!block) {
                this.debugLogger.log(`🎯 [Cursor] ❌ No block found for line ${cursorLine}`);
                return;
            }
            
            this.debugLogger.log(`🎯 [Cursor] Found block: ${block.layoutBlockId} (${block.blockName}) at line ${block.line}`);
            
            // Only write if block changed (avoid redundant writes)
            if (block.layoutBlockId === this.lastCursorBlockId) {
                this.debugLogger.log(`🎯 [Cursor] Same block, skipping write`);
                return;
            }
            
            this.lastCursorBlockId = block.layoutBlockId;
            
            // Write active block file
            const activeBlockPath = posixJoin(this.devFolder, '.skylit', 'active-block.txt');
            const content = `${postId}:${block.layoutBlockId}`;
            
            this.debugLogger.log(`🎯 [Cursor] Writing to: ${activeBlockPath}`);
            this.debugLogger.log(`🎯 [Cursor] Content: ${content}`);
            
            await vsWriteFile(activeBlockPath, content);
            
            this.debugLogger.log(`🎯 [Cursor] ✅ Active block file written!`);
            
        } catch (error: any) {
            this.debugLogger.log(`🎯 [Cursor] ❌ Error: ${error.message}`);
        }
    }
    
    /**
     * Find which block contains the given line number
     * Uses the metadata blocks array which has line numbers for each block
     */
    private findBlockForLine(
        blocks: Array<{ layoutBlockId: string; blockName: string; line: number }>,
        targetLine: number
    ): { layoutBlockId: string; blockName: string; line: number } | null {
        if (!blocks || blocks.length === 0) {
            return null;
        }
        
        // Sort blocks by line number
        const sortedBlocks = [...blocks].sort((a, b) => a.line - b.line);
        
        // Find the block whose line is closest to (but not after) the target line
        let bestMatch: typeof blocks[0] | null = null;
        
        for (const block of sortedBlocks) {
            if (block.line <= targetLine) {
                bestMatch = block;
            } else {
                // We've passed the target line, stop
                break;
            }
        }
        
        return bestMatch;
    }

    /**
     * Stop watching files
     */
    dispose() {
        // Stop main file watcher
        if (this.watcher) {
            this.watcher.close();
            this.debugLogger.log('👋 File watcher stopped');
        }

        // Stop trash folder watcher (chokidar)
        if (this.trashWatcher) {
            this.trashWatcher.close();
            this.debugLogger.log('👋 Trash folder watcher stopped');
        }
        
        // Stop VS Code native trash watcher
        if (this.vscodeTrashWatcher) {
            this.vscodeTrashWatcher.dispose();
            this.debugLogger.log('👋 VS Code trash watcher stopped');
        }

        // Stop theme folder watcher (bi-directional sync)
        if (this.themeWatcher) {
            this.themeWatcher.close();
            this.debugLogger.log('👋 Theme watcher stopped');
        }
        
        // Stop new folder watcher (chokidar - legacy)
        if (this.newFolderWatcher) {
            this.newFolderWatcher.close();
            this.debugLogger.log('👋 New folder watcher stopped');
        }
        
        // Stop VS Code native new folder watcher
        if (this.vscodeNewFolderWatcher) {
            this.vscodeNewFolderWatcher.dispose();
            this.debugLogger.log('👋 VS Code new folder watcher stopped');
        }
        
        // Stop metadata watcher
        if (this.metadataWatcher) {
            this.metadataWatcher.close();
            this.debugLogger.log('👋 Metadata watcher stopped');
        }
        
        // Clear metadata cache
        this.metadataCache.clear();
        this.metadataSyncCooldown.clear();
        
        // Clear folding state manager
        this.foldingManager.clear();

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
        
        // Clear recent folder deletes
        this.recentFolderDeletes.clear();
        
        // Clear pending restore timers
        for (const timer of this.pendingRestoreTimers.values()) {
            clearTimeout(timer);
        }
        this.pendingRestoreTimers.clear();
        
        // Stop cursor tracking
        if (this.cursorSelectionListener) {
            this.cursorSelectionListener.dispose();
            this.cursorSelectionListener = null;
            this.debugLogger.log('👋 Cursor tracking stopped');
        }
        if (this.cursorDebounceTimer) {
            clearTimeout(this.cursorDebounceTimer);
            this.cursorDebounceTimer = null;
        }
        
        // Clear all polling intervals
        this.pollingIntervals.forEach(interval => clearInterval(interval));
        this.pollingIntervals = [];
    }
}
