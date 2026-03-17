/**
 * File Watcher
 * Monitors dev folder for file changes and triggers sync
 * Also watches for folder movements to/from _trash/ directories
 */

import * as vscode from "vscode";
import * as chokidar from "chokidar";
import * as fs from "fs";
import * as path from "path";
import { RestClient } from "./restClient";
import { StatusBar } from "./statusBar";
import { DebugLogger } from "./debugLogger";

/**
 * Join paths using forward slashes (POSIX-style)
 * This is needed for SSH/remote paths on Windows hosts
 */
function posixJoin(...parts: string[]): string {
	return parts.join("/").replace(/\/+/g, "/");
}

/**
 * Convert a file path to a proper VS Code URI
 * This handles SSH/remote paths by using the workspace folder's URI scheme
 */
function pathToUri(filePath: string): vscode.Uri {
	const normalizedPath = filePath.replace(/\\/g, "/");

	// Get workspace folders to determine the correct URI scheme
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders && workspaceFolders.length > 0) {
		const wsFolder = workspaceFolders[0];
		const wsUri = wsFolder.uri;

		// If workspace is remote (SSH, WSL, etc.), use its scheme
		if (wsUri.scheme !== "file") {
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

async function vsReadDir(
	dirPath: string
): Promise<[string, vscode.FileType][]> {
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
	return Buffer.from(content).toString("utf8");
}

async function vsWriteFile(filePath: string, content: string): Promise<void> {
	const uri = pathToUri(filePath);
	await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
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
		const normalizedPath = filePath.replace(/\\/g, "/");
		const uri = pathToUri(normalizedPath);

		// Find editor for this file
		const editor = vscode.window.visibleTextEditors.find(
			(e) => e.document.uri.toString() === uri.toString()
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
		this.debugLogger.log(
			`📁 Saved folding state: ${foldedLines.length} folded regions`
		);
	}

	/**
	 * Restore folding state for unchanged blocks
	 * Uses block change info from the API to determine which folds to restore
	 */
	async restoreFoldingState(
		filePath: string,
		unchangedBlocks: Array<{
			startLine: number;
			endLine: number;
			layoutBlockId: string;
		}>
	): Promise<void> {
		const normalizedPath = filePath.replace(/\\/g, "/");
		const savedFolds = this.foldingStates.get(normalizedPath);

		if (!savedFolds || savedFolds.length === 0) {
			return;
		}

		const uri = pathToUri(normalizedPath);

		// Find editor for this file
		const editor = vscode.window.visibleTextEditors.find(
			(e) => e.document.uri.toString() === uri.toString()
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
		if (
			!activeEditor ||
			activeEditor.document.uri.toString() !== uri.toString()
		) {
			return;
		}

		// Filter saved folds to only restore those within unchanged blocks
		const foldsToRestore: number[] = [];

		for (const foldLine of savedFolds) {
			// Check if this fold line is within an unchanged block
			const isInUnchangedBlock = unchangedBlocks.some((block) => {
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

		this.debugLogger.log(
			`📂 Restoring ${foldsToRestore.length} folds for unchanged blocks`
		);

		// Restore folds using VS Code fold command
		for (const line of foldsToRestore) {
			try {
				// Move cursor to the line and fold
				const position = new vscode.Position(line, 0);
				activeEditor.selection = new vscode.Selection(position, position);
				await vscode.commands.executeCommand("editor.fold", {
					selectionLines: [line],
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
	private acfJsonBatchTimer: NodeJS.Timeout | null = null; // Shared debounce for ACF JSON batch writes
	private taxonomyJsonBatchTimer: NodeJS.Timeout | null = null; // Shared debounce for taxonomy JSON batch writes
	private acfJsonBatchDebounceMs: number = 2000; // Wait 2s after last ACF file change before syncing
	// ── import-instant serialization queue ──────────────────────────────────
	// Shared hosting (Hostinger etc.) 500s when multiple PHP requests run in
	// parallel. All import-instant calls are funnelled through this queue so
	// only one is in-flight at a time, with a gap between each request so
	// the PHP-FPM worker has time to release memory before the next one lands.
	private importQueue: Array<() => Promise<void>> = [];
	private importQueueRunning: boolean = false;
	private importQueueIntervalMs: number = 1500; // Gap between sequential import-instant calls
	private lastSyncTime: Map<string, number> = new Map();
	private lastFolderActionTime: Map<number, number> = new Map();
	private lastThemeSyncTime: Map<string, number> = new Map(); // Track theme file syncs
	private processedNewFolders: Set<string> = new Set(); // Track folders we've already processed
	private pendingRenames: Map<
		number,
		{ oldPath: string; oldSlug: string; timestamp: number }
	> = new Map(); // Track folder renames
	private recentFolderDeletes: Map<
		number,
		{ path: string; timestamp: number }
	> = new Map(); // Track recent deletes to detect server-side renames
	private pendingRestoreTimers: Map<number, NodeJS.Timeout> = new Map(); // Pending restore timers that can be cancelled
	private skipDeletePromptForPosts: Set<number> = new Set(); // Track posts being deleted via command to skip FileWatcher prompt
	private metadataCache: Map<
		number,
		{
			slug: string;
			title: string;
			status: string;
			syncHash?: string;
			lastSyncTime?: string;
			lastSyncDirection?: string;
		}
	> = new Map();
	private metadataSyncCooldown: Map<number, number> = new Map(); // Cooldown for metadata syncs
	private devFolder: string;
	private themePath: string | null = null; // Theme folder path (fetched from WordPress)
	private restClient: RestClient;
	private statusBar: StatusBar;
	private debugLogger: DebugLogger;
	private debounceMs: number = 800;
	private folderActionDebounceMs: number = 1000; // Debounce folder actions
	private folderActionCooldownMs: number = 5000; // Don't re-process same post within 5 seconds
	private syncCooldownMs: number = 1500; // Don't re-sync same file within 1.5 seconds
	private themeSyncCooldownMs: number = 3000; // Cooldown for theme → dev sync
	private acfSyncCooldownMs: number = 10000; // Cooldown after ACF batch sync (ACF save hooks can fire for several seconds)
	private newFolderDebounceMs: number = 2000; // Wait for HTML file to be created
	/** Paths we wrote during startup sync — skip syncing these back to WP to avoid redundant import-instant */
	private pathsWrittenDuringStartup: Set<string> = new Set();
	/** True while syncOnConnection is running — ignore content file watcher events to avoid duplicate "Content file changed" cycles */
	private startupSyncInProgress: boolean = false;
	private renameCooldownMs: number = 2000; // Time window to match unlink+add as rename
	private pathToPostIdIndex: Map<string, number> = new Map(); // Reverse index: relative folder path -> post ID
	private foldingManager: FoldingStateManager; // Manages folding state for unchanged blocks
	private cursorSelectionListener: vscode.Disposable | null = null; // Cursor tracking for GT sync
	private cursorDebounceTimer: NodeJS.Timeout | null = null; // Debounce cursor position updates
	private lastCursorBlockId: string | null = null; // Avoid writing same block repeatedly
	private cursorTrackingEnabled: boolean = true; // Can be disabled via settings
	private jumpCooldownUntil: number = 0; // Suppress cursor tracking after a GT→IDE jump
	/** Paths the extension itself wrote (canonical HTML writeback, startup sync, etc.)
	 *  Value = timestamp. syncFile checks this to skip only our own writes. */
	private selfWrittenPaths: Map<string, number> = new Map();
	private liveBlockLines: Map<number, Array<{ layoutBlockId: string; line: number; blockName: string }>> = new Map();
	private lineTrackingListener: vscode.Disposable | null = null; // Real-time line shift listener
	private localDevFolder: string; // Local (IDE-resolved) dev folder path for VS Code watchers
	private vscodeThemeWatcher: vscode.FileSystemWatcher | null = null; // VS Code native watcher for theme file sync
	private remoteMode: boolean = false; // When true, push files to server instead of telling plugin to copy
	private assetSourceModes: { js: "theme" | "database"; css: "theme" | "database"; php: "theme" | "database" } = { js: "theme", css: "theme", php: "theme" };
	public pendingMetadataRepairs: Array<{ entry: any; activeHtml: string; activePath: string }> = [];

	// ---- Media Library Sync ----
	/** In-memory index of .skylit/media/*.json — keyed by local_path */
	private mediaMetaIndex: Map<string, import("./types").MediaMetadata> = new Map();
	/** Pending deletes waiting for a matching add (rename detection). hash → { attachmentId, timer } */
	private pendingMediaDeletes: Map<string, { attachmentId: number; timer: NodeJS.Timeout }> = new Map();
	/** Cached media sync direction from WP settings */
	private mediaSyncDirection: import("./types").MediaSyncDirection = "bidirectional";
	/** Whether media sync is enabled (fetched from WP on connect) */
	private mediaSyncEnabled: boolean = false;
	/** VS Code native watcher for media-library/ — SSH-compatible */
	private vscodeMediaWatcher: vscode.FileSystemWatcher | null = null;

	constructor(
		devFolder: string,
		restClient: RestClient,
		statusBar: StatusBar,
		debugLogger: DebugLogger,
		localDevFolder?: string,
		remoteMode?: boolean
	) {
		this.devFolder = devFolder;
		this.localDevFolder = localDevFolder || devFolder;
		this.remoteMode = remoteMode || false;
		this.restClient = restClient;
		this.statusBar = statusBar;
		this.debugLogger = debugLogger;
		this.foldingManager = new FoldingStateManager(debugLogger);

		// Get debounce setting
		const config = vscode.workspace.getConfiguration("skylit");
		this.debounceMs = config.get<number>("debounceMs", 500);
		this.cursorTrackingEnabled = config.get<boolean>("cursorTracking", true);
	}

	private aiSkillsetGenerator: import("./aiSkillsetGenerator").AiSkillsetGenerator | null = null;

	/**
	 * Set the AI Skillset Generator so we can trigger regeneration after ACF JSON changes
	 */
	setAiSkillsetGenerator(generator: import("./aiSkillsetGenerator").AiSkillsetGenerator) {
		this.aiSkillsetGenerator = generator;
	}

	/**
	 * Update the cached asset source modes (js/css/php: 'theme' | 'database').
	 * Called after connection so notifications can say the right thing.
	 */
	setAssetSourceModes(modes: Partial<{ js: "theme" | "database"; css: "theme" | "database"; php: "theme" | "database" }>) {
		this.assetSourceModes = { ...this.assetSourceModes, ...modes };
	}

	/**
	 * Start watching files
	 */
	async start() {
		this.debugLogger.info(`👀 Starting file watcher for: ${this.devFolder}`);

		// Main watcher for ALL file content changes (dynamic - watches everything except excluded)
		this.watcher = chokidar.watch(`${this.devFolder}`, {
			ignored: [
				/(^|[\/\\])\../, // Ignore dotfiles
				"**/node_modules/**",
				"**/.git/**",
				"**/.vscode/**",
				"**/.cursor/**",
				"**/post-types/**", // All content folders handled by VS Code native watcher
				"**/templates/**",
				"**/parts/**",
				"**/patterns/**",
			],
			ignoreInitial: true,
			persistent: true,
			depth: 10, // Watch deeply nested folders
			awaitWriteFinish: {
				stabilityThreshold: 300,
				pollInterval: 100,
			},
		});

		// Handler for both file changes and new file additions
		const handleFileEvent = (filePath: string, eventType: string) => {
			this.debugLogger.info(`📝 File ${eventType}: ${filePath}`);

			// Normalize path for cross-platform
			const normalizedPath = filePath.replace(/\\/g, "/");
			const devFolderNormalized = this.devFolder.replace(/\\/g, "/");

			// Media library files — route to media sync handler
			if (normalizedPath.includes("/media-library/")) {
				const chokidarEvent =
					eventType === "changed" ? "change" :
					eventType === "added" ? "add" : "unlink";
				this.handleMediaFileChange(filePath, chokidarEvent);
				return;
			}

			// Content folders are handled by VS Code native watcher (SSH-compatible)
			// If chokidar somehow fires for them, route correctly
			const isContentFolder =
				normalizedPath.includes("/post-types/") ||
				normalizedPath.includes("/templates/") ||
				normalizedPath.includes("/parts/") ||
				normalizedPath.includes("/patterns/");
			if (isContentFolder) {
				if (eventType === "changed") {
					this.handleFileChange(filePath);
				}
				return;
			}

			// Everything else is a theme/global file - sync to theme folder
			// This includes: style.css, functions.php, theme.json,
			// patterns/, assets/, includes/, acf-json/, and any custom folders
			this.handleThemeFileChange(filePath);
		};

		// Listen for file changes (edits to existing files)
		this.watcher.on("change", (filePath) => {
			handleFileEvent(filePath, "changed");
		});

		// Listen for new files (created/pasted/moved into watched folders)
		this.watcher.on("add", (filePath) => {
			handleFileEvent(filePath, "added");
		});

		this.watcher.on("error", (error) => {
			this.debugLogger.log(`❌ File watcher error: ${error.message}`);
		});

		// ── VS Code native FileSystemWatcher for theme files ──
		// Skip all VS Code native watchers when the dev path is a local Windows
		// path but the workspace is a remote SSH session — the server can't
		// access the local filesystem.
		const devNormalized = this.devFolder.replace(/\\/g, "/");
		const isLocalPathOnRemote =
			/^[A-Za-z]:\//.test(devNormalized) &&
			vscode.workspace.workspaceFolders?.[0]?.uri.scheme !== "file";

		if (isLocalPathOnRemote) {
			this.debugLogger.info(
				`⏭️ Skipping VS Code native watchers — dev path is on local machine, extension runs on remote server.`
			);
			this.debugLogger.info(
				`ℹ️ To enable live file watching, open a local Cursor window with this dev folder and connect to the remote WordPress site.`
			);
			return;
		}

		this.setupVscodeThemeWatcher();

		const postTypesPath = posixJoin(this.devFolder, "post-types");

		this.debugLogger.log(
			`🔍 [Trash Watcher] Setting up VS Code native watcher for: ${postTypesPath}`
		);

		const trashPattern = new vscode.RelativePattern(
			pathToUri(postTypesPath),
			"**/*"
		);

		this.vscodeTrashWatcher = vscode.workspace.createFileSystemWatcher(
			trashPattern,
			false,
			true,
			false
		);

		// Listen for files/folders being created (could be trash or restore)
		this.vscodeTrashWatcher.onDidCreate((uri) => {
			const filePath = uri.fsPath;
			this.debugLogger.log(`🔍 [VS Code Watcher] Created: ${filePath}`);

			const norm = filePath.replace(/\\/g, "/");
			const isContentArea =
				norm.includes("/post-types/") ||
				norm.includes("/templates/") ||
				norm.includes("/parts/") ||
				norm.includes("/patterns/");

			if (
				isContentArea &&
				(norm.includes("/_trash/") || /_\d+$/.test(path.basename(filePath)))
			) {
				this.handlePotentialTrashAction(filePath, "add");
			}
		});

		// Listen for files/folders being deleted (could be trash or restore)
		this.vscodeTrashWatcher.onDidDelete((uri) => {
			const filePath = uri.fsPath;
			this.debugLogger.log(`🔍 [VS Code Watcher] Deleted: ${filePath}`);

			const norm = filePath.replace(/\\/g, "/");
			const isContentArea =
				norm.includes("/post-types/") ||
				norm.includes("/templates/") ||
				norm.includes("/parts/") ||
				norm.includes("/patterns/");

			if (
				isContentArea &&
				(norm.includes("/_trash/") || /_\d+$/.test(path.basename(filePath)))
			) {
				this.handlePotentialTrashAction(filePath, "unlink");
			}
		});

		this.debugLogger.log(
			"✅ File watcher started (including VS Code native _trash folder monitoring)"
		);

		// Start bi-directional theme watcher
		await this.startThemeWatcher();

		// Start new folder watcher for creating posts from IDE
		await this.startNewFolderWatcher();

		// Start metadata watcher for JSON → WordPress sync
		await this.startMetadataWatcher();

		// Media library watcher is started by refreshMediaSyncSettings() after
		// fetching the sync-enabled flag from WP — not here.

		// Start cursor tracking for Gutenberg block selection sync
		this.startCursorTracking();

		// Bidirectional startup sync runs in the background — doesn't block the editor
		this.runBackgroundSync();
	}

	/**
	 * Run the startup sync in the background without blocking the editor.
	 * Shows a subtle status indicator while syncing.
	 */
	private runBackgroundSync() {
		this.statusBar.showBackgroundSync("Syncing files and folders...");
		this.syncOnConnection()
			.then(() => {
				this.statusBar.clearBackgroundSync();
			})
			.catch((err) => {
				this.debugLogger.log(`⚠️ Background sync error: ${err.message}`);
				this.statusBar.clearBackgroundSync();
			});
	}

	/**
	 * Full bidirectional reconciliation on connection.
	 * Guarantees WP and dev folder are perfectly in sync:
	 *   - Active WP posts have folders in the correct content directory
	 *   - Trashed WP posts have folders in _trash/
	 *   - Dev folders without WP posts get posts created (handled by scanForNewFolders)
	 *   - Stray dev folders (no matching WP post at all) are flagged
	 */
	private async syncOnConnection() {
		const profileEnd = this.debugLogger.profileStart("syncOnConnection");
		this.startupSyncInProgress = true;
		try {
			this.pathsWrittenDuringStartup.clear();
			this.debugLogger.info("🔄 Startup sync: full WP ↔ Dev reconciliation...");

			const manifest = await this.restClient.getExportAll();
			if (!manifest || !manifest.posts) {
				this.debugLogger.log("   ℹ️ No posts returned from WordPress");
				return;
			}

			this.debugLogger.log(`   📋 WP manifest: ${manifest.count} posts`);

			const stats = {
				exported: 0,
				movedToTrash: 0,
				restoredFromTrash: 0,
				alreadySynced: 0,
				cleanedTrash: 0,
				metadataRepaired: 0,
			};

			// Build a set of WP-managed slugs for stray detection later
			const wpSlugs = new Set<string>();
			const pendingRepairs: Array<{
				entry: any;
				activeHtml: string;
				activePath: string;
			}> = [];

			for (const entry of manifest.posts) {
				wpSlugs.add(`${entry.type_folder}/${entry.folder_name}`);

				const activePath = posixJoin(
					this.devFolder,
					entry.type_folder,
					entry.folder_name
				);
				const activeHtml = posixJoin(activePath, `${entry.folder_name}.html`);
				const trashPath = posixJoin(
					this.devFolder,
					entry.type_folder,
					"_trash",
					entry.folder_name
				);
				const trashHtml = posixJoin(trashPath, `${entry.folder_name}.html`);

				const existsActive = await vsExists(activeHtml);
				const existsTrash = await vsExists(trashHtml);
				const isTrashed = entry.post_status === "trash";

				if (isTrashed) {
					// WP post is trashed — folder should be in _trash/
					if (existsTrash) {
						stats.alreadySynced++;
						continue;
					}
					if (existsActive) {
						// Move from active to _trash
						try {
							const trashDir = posixJoin(
								this.devFolder,
								entry.type_folder,
								"_trash"
							);
							try {
								await vscode.workspace.fs.createDirectory(pathToUri(trashDir));
							} catch {}
							await vscode.workspace.fs.rename(
								pathToUri(activePath),
								pathToUri(trashPath),
								{ overwrite: false }
							);
							stats.movedToTrash++;
							this.debugLogger.log(
								`   🗑️ Moved to _trash: ${entry.type_folder}/${entry.folder_name}`
							);
						} catch (err: any) {
							this.debugLogger.log(
								`   ⚠️ Failed to move to trash: ${err.message}`
							);
						}
						continue;
					}
					// Trashed and no folder anywhere — nothing to do
					stats.alreadySynced++;
					continue;
				}

				// WP post is active — folder should be in the content directory (NOT _trash)
				if (existsActive) {
					let needsReExport = false;

					try {
						const localHtml = await vsReadFile(activeHtml);

						// If missing metadata header, sync local→WP to get the header added
						// (import-instant returns canonical HTML with the header)
						if (!localHtml.startsWith("<!--\nWordPress Sync Metadata")) {
							const localStripped = localHtml
								.replace(/<!--[\s\S]*?-->/g, "")
								.trim();
							if (localStripped.length > 50) {
								this.debugLogger.log(
									`   📝 Adding metadata header via sync: ${entry.type_folder}/${entry.folder_name}`
								);
								const cssPath = posixJoin(
									activePath,
									`${entry.folder_name}.css`
								);
								let localCss = "";
								try {
									localCss = await vsReadFile(cssPath);
								} catch {}
							try {
								await new Promise<void>((resolve) => {
									this.enqueueImport(async () => {
										try {
											const resp = await this.restClient.syncFile(
												entry.post_id,
												localHtml,
												localCss
											);
											const canonical = (resp as any).canonical_html;
											if (canonical && typeof canonical === "string") {
												this.lastSyncTime.set(activeHtml, Date.now());
												this.pathsWrittenDuringStartup.add(activeHtml.replace(/\\/g, "/"));
												await vsWriteFile(activeHtml, canonical);
											}
										} catch (syncErr: any) {
											this.debugLogger.log(
												`   ⚠️ Failed to sync for header: ${syncErr.message}`
											);
										}
										resolve();
									});
								});
							} catch (syncErr: any) {
								this.debugLogger.log(
									`   ⚠️ Failed to sync for header: ${syncErr.message}`
								);
							}
								stats.exported++;
								continue;
							}
							needsReExport = true;
						}

						// Check for content drift using syncHash (only when WP has a stored hash)
						if (
							!needsReExport &&
							entry.sync_hash &&
							entry.sync_hash.length > 0
						) {
							const crypto = await import("crypto");
							const localHash = crypto
								.createHash("md5")
								.update(localHtml)
								.digest("hex");
							if (localHash !== entry.sync_hash) {
								needsReExport = true;
							}
						}
					} catch {}

					if (needsReExport) {
						try {
							const payload = await this.restClient.getExportContent(
								entry.post_id
							);
							// Guard: don't overwrite a non-empty local file with empty WP content.
							// WP may have default empty paragraph for patterns that were never opened in GT.
							const wpHtml = payload.html || "";
							const stripped = wpHtml
								.replace(/<!--[\s\S]*?-->/g, "")
								.replace(/<p[^>]*>\s*<\/p>/gi, "")
								.trim();
							if (stripped.length < 20) {
								// WP content is essentially empty — import local file to WP instead
								const localContent = await vsReadFile(activeHtml);
								const localStripped = localContent
									.replace(/<!--[\s\S]*?-->/g, "")
									.trim();
								if (localStripped.length > 50) {
									this.debugLogger.log(
										`   ⬆️ WP empty, importing local to WP: ${entry.type_folder}/${entry.folder_name}`
									);
									const cssPath = posixJoin(
										activePath,
										`${entry.folder_name}.css`
									);
									let localCss = "";
									try {
										localCss = await vsReadFile(cssPath);
									} catch {}
								try {
									await new Promise<void>((resolve) => {
										this.enqueueImport(async () => {
											try {
												await this.restClient.syncFile(
													entry.post_id,
													localContent,
													localCss
												);
											} catch (syncErr: any) {
												this.debugLogger.log(
													`   ⚠️ Failed to push local to WP: ${syncErr.message}`
												);
											}
											resolve();
										});
									});
								} catch (syncErr: any) {
									this.debugLogger.log(
										`   ⚠️ Failed to push local to WP: ${syncErr.message}`
									);
								}
									stats.exported++;
									continue;
								}
							}
							if (payload.html) {
								this.lastSyncTime.set(activeHtml, Date.now());
								this.pathsWrittenDuringStartup.add(activeHtml.replace(/\\/g, "/"));
								await vsWriteFile(activeHtml, payload.html);
							}
							if (payload.css) {
								const cssPath = posixJoin(
									activePath,
									`${entry.folder_name}.css`
								);
								this.lastSyncTime.set(cssPath, Date.now());
								this.pathsWrittenDuringStartup.add(cssPath.replace(/\\/g, "/"));
								await vsWriteFile(cssPath, payload.css);
							}
							stats.exported++;
							this.debugLogger.log(
								`   🔄 Re-synced: ${entry.type_folder}/${entry.folder_name}`
							);
							continue;
						} catch {}
					}

					// Collect posts needing metadata repair (blocks[] empty) — batched later
					if ((entry as any).blocks_count === 0 && !needsReExport) {
						pendingRepairs.push({ entry, activeHtml, activePath });
					}

					stats.alreadySynced++;
					continue;
				}

				if (existsTrash) {
					// Restore from _trash to active location
					try {
						await vscode.workspace.fs.rename(
							pathToUri(trashPath),
							pathToUri(activePath),
							{ overwrite: false }
						);
						stats.restoredFromTrash++;
						this.debugLogger.log(
							`   ♻️ Restored from _trash: ${entry.type_folder}/${entry.folder_name}`
						);
					} catch (err: any) {
						this.debugLogger.log(
							`   ⚠️ Failed to restore from trash: ${err.message}`
						);
					}
					continue;
				}

				// Missing entirely — export from WP
				try {
					const payload = await this.restClient.getExportContent(entry.post_id);
					try {
						await vscode.workspace.fs.createDirectory(pathToUri(activePath));
					} catch {}
					if (payload.html) {
						this.pathsWrittenDuringStartup.add(activeHtml.replace(/\\/g, "/"));
						await vsWriteFile(activeHtml, payload.html);
					}
					if (payload.css) {
						const cssPath = posixJoin(activePath, `${entry.folder_name}.css`);
						this.pathsWrittenDuringStartup.add(cssPath.replace(/\\/g, "/"));
						await vsWriteFile(cssPath, payload.css);
					}
					stats.exported++;
					this.debugLogger.log(
						`   📥 Exported: ${entry.type_folder}/${entry.folder_name} (ID: ${entry.post_id})`
					);
				} catch (err: any) {
					this.debugLogger.log(
						`   ⚠️ Failed to export ${entry.folder_name}: ${err.message}`
					);
				}
			}

			stats.cleanedTrash = await this.cleanupTrashFolders(wpSlugs);

			// Metadata repair: only log a notice during startup sync (opt-in via command)
			if (pendingRepairs.length > 0) {
				this.debugLogger.info(
					`   ℹ️ ${pendingRepairs.length} posts have empty blocks metadata. Run "Skylit: Repair Metadata" to fix them.`
				);
				this.pendingMetadataRepairs = pendingRepairs;
			} else {
				this.pendingMetadataRepairs = [];
			}

			const summary = [
				stats.alreadySynced > 0 ? `${stats.alreadySynced} in sync` : "",
				stats.exported > 0 ? `${stats.exported} exported to dev` : "",
				stats.metadataRepaired > 0
					? `${stats.metadataRepaired} metadata repaired`
					: "",
				stats.movedToTrash > 0 ? `${stats.movedToTrash} moved to _trash` : "",
				stats.restoredFromTrash > 0
					? `${stats.restoredFromTrash} restored from _trash`
					: "",
				stats.cleanedTrash > 0
					? `${stats.cleanedTrash} removed from _trash (permanently deleted)`
					: "",
			]
				.filter(Boolean)
				.join(", ");

			this.debugLogger.info(`✅ Startup sync complete: ${summary}`);
			// Stop ignoring file changes we caused after 20s (avoid syncing them back to WP)
			setTimeout(() => this.pathsWrittenDuringStartup.clear(), 20000);
		} catch (error: any) {
			this.debugLogger.log(`⚠️ Startup sync failed: ${error.message}`);
			this.pathsWrittenDuringStartup.clear();
		} finally {
			this.startupSyncInProgress = false;
			profileEnd();
		}
	}

	/**
	 * Remove folders from _trash/ that belong to permanently deleted WP posts.
	 * wpSlugs contains all type_folder/slug combos that still exist in WP (including trashed).
	 * Any _trash folder whose slug is NOT in the WP manifest was permanently deleted.
	 */
	private async cleanupTrashFolders(wpSlugs: Set<string>): Promise<number> {
		let cleaned = 0;
		const trashRoots = [
			{
				root: posixJoin(this.devFolder, "post-types"),
				label: "post-types",
				nested: true,
			},
			{
				root: posixJoin(this.devFolder, "templates"),
				label: "templates",
				nested: false,
			},
			{
				root: posixJoin(this.devFolder, "parts"),
				label: "parts",
				nested: false,
			},
			{
				root: posixJoin(this.devFolder, "patterns", "synced"),
				label: "patterns/synced",
				nested: false,
			},
			{
				root: posixJoin(this.devFolder, "patterns", "unsynced"),
				label: "patterns/unsynced",
				nested: false,
			},
		];

		for (const { root, label, nested } of trashRoots) {
			try {
				if (nested) {
					if (!(await vsExists(root))) continue;
					const typeDirs = await vsReadDir(root);
					for (const [typeName, tType] of typeDirs) {
						if (tType !== vscode.FileType.Directory) continue;
						const trashDir = posixJoin(root, typeName, "_trash");
						cleaned += await this.cleanSingleTrashDir(
							trashDir,
							`post-types/${typeName}`,
							wpSlugs
						);
					}
				} else {
					const trashDir = posixJoin(root, "_trash");
					cleaned += await this.cleanSingleTrashDir(trashDir, label, wpSlugs);
				}
			} catch {
				/* root doesn't exist */
			}
		}
		return cleaned;
	}

	private async cleanSingleTrashDir(
		trashDir: string,
		typeFolder: string,
		wpSlugs: Set<string>
	): Promise<number> {
		let cleaned = 0;
		try {
			if (!(await vsExists(trashDir))) return 0;
			const entries = await vsReadDir(trashDir);
			for (const [slug, fType] of entries) {
				if (fType !== vscode.FileType.Directory || slug.startsWith("."))
					continue;
				const key = `${typeFolder}/${slug}`;
				if (!wpSlugs.has(key)) {
					try {
						await vscode.workspace.fs.delete(
							pathToUri(posixJoin(trashDir, slug)),
							{ recursive: true }
						);
						cleaned++;
						this.debugLogger.log(
							`   🧹 Cleaned from _trash: ${key} (permanently deleted in WP)`
						);
					} catch (err: any) {
						this.debugLogger.log(
							`   ⚠️ Failed to clean ${key}: ${err.message}`
						);
					}
				}
			}
		} catch {
			/* trash dir doesn't exist or not readable */
		}
		return cleaned;
	}

	/**
	 * Manually repair metadata for posts with empty blocks.
	 * Fetches export content from WP in batches with pauses to avoid overloading PHP.
	 */
	async repairMetadata(): Promise<{ repaired: number; failed: number }> {
		const repairs = this.pendingMetadataRepairs;
		if (repairs.length === 0) {
			this.debugLogger.info("ℹ️ No pending metadata repairs.");
			return { repaired: 0, failed: 0 };
		}

		this.debugLogger.info(
			`🔧 Repairing metadata for ${repairs.length} posts (batches of 3)...`
		);

		let repaired = 0;
		let failed = 0;
		const BATCH_SIZE = 3;

		for (let i = 0; i < repairs.length; i += BATCH_SIZE) {
			const batch = repairs.slice(i, i + BATCH_SIZE);
			for (const { entry, activeHtml, activePath } of batch) {
				try {
					const payload = await this.restClient.getExportContent(
						entry.post_id
					);
					if (payload.html) {
						this.lastSyncTime.set(activeHtml, Date.now());
						this.pathsWrittenDuringStartup.add(activeHtml.replace(/\\/g, "/"));
						await vsWriteFile(activeHtml, payload.html);
					}
					if (payload.css) {
						const cssPath = posixJoin(
							activePath,
							`${entry.folder_name}.css`
						);
						this.lastSyncTime.set(cssPath, Date.now());
						this.pathsWrittenDuringStartup.add(cssPath.replace(/\\/g, "/"));
						await vsWriteFile(cssPath, payload.css);
					}
					repaired++;
					this.debugLogger.log(
						`   🔧 Repaired: ${entry.type_folder}/${entry.folder_name}`
					);
				} catch (err: any) {
					failed++;
					this.debugLogger.log(
						`   ⚠️ Repair failed: ${entry.folder_name}: ${err.message}`
					);
				}
			}
			if (i + BATCH_SIZE < repairs.length) {
				this.debugLogger.log(
					`   ⏳ Batch ${Math.floor(i / BATCH_SIZE) + 1} done, pausing 5s...`
				);
				await new Promise((r) => setTimeout(r, 5000));
			}
		}

		this.pendingMetadataRepairs = [];
		setTimeout(() => this.pathsWrittenDuringStartup.clear(), 20000);

		this.debugLogger.info(
			`✅ Metadata repair complete: ${repaired} repaired, ${failed} failed`
		);
		return { repaired, failed };
	}

	/**
	 * Start watching for new folders in content directories
	 * When a new folder is created without a linked WP post, create one
	 * Uses VS Code's native FileSystemWatcher for SSH compatibility
	 */
	private async startNewFolderWatcher() {
		// Watch all content folders: post-types, templates, parts, and patterns
		const foldersToWatch = [
			{
				path: posixJoin(this.devFolder, "post-types"),
				label: "post-types",
			},
			{
				path: posixJoin(this.devFolder, "templates"),
				label: "templates",
			},
			{
				path: posixJoin(this.devFolder, "parts"),
				label: "parts",
			},
			{
				path: posixJoin(this.devFolder, "patterns"),
				label: "patterns",
			},
		];

		for (const folder of foldersToWatch) {
			this.debugLogger.log(
				`🔍 [New Folder Watcher] Setting up VS Code native watcher for: ${folder.path}`
			);

			// First, scan for existing folders without IDs (created before extension started)
			// This uses VS Code FS API for SSH compatibility
			try {
				await this.scanForNewFolders(folder.path);
			} catch (err: any) {
				this.debugLogger.log(
					`⚠️ Could not scan for existing folders in ${folder.label}: ${err.message}`
				);
				this.debugLogger.log(
					`ℹ️ Watcher will still monitor for new folders created after connection`
				);
			}

			// Create VS Code native FileSystemWatcher — use pathToUri for SSH compatibility
			const newFolderPattern = new vscode.RelativePattern(
				pathToUri(folder.path),
				"**/*"
			);

			const watcher = vscode.workspace.createFileSystemWatcher(
				newFolderPattern,
				false,
				true,
				false
			);

			// Listen for files/folders being created (new folder or HTML file added)
			watcher.onDidCreate((uri) => {
				const filePath = uri.fsPath.replace(/\\/g, "/");

				// Skip trash folders
				if (filePath.includes("/_trash/") || filePath.includes("\\_trash\\")) {
					return;
				}

				// Check if this is an HTML file
				if (filePath.endsWith(".html")) {
					this.debugLogger.log(
						`🔔 [VS Code Watcher] HTML file created: ${path.basename(filePath)}`
					);
					const folderPath = path.dirname(filePath).replace(/\\/g, "/");
					const postId = this.extractPostIdFromPath(folderPath);
					// Rename: first event is often the file inside the renamed folder
					if (postId && this.pendingRenames.has(postId)) {
						this.handleRenameComplete(folderPath, postId);
					} else {
						this.handlePotentialNewFolder(folderPath);
					}
					return;
				}

				// Check if this is a folder (has no extension or is a known folder pattern)
				const baseName = path.basename(filePath);
				if (!baseName.includes(".") || /_\d+$/.test(baseName)) {
					this.debugLogger.log(
						`🔔 [VS Code Watcher] Folder created: ${baseName}`
					);

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
			watcher.onDidDelete((uri) => {
				const filePath = uri.fsPath.replace(/\\/g, "/");

				// Skip trash folders
				if (filePath.includes("/_trash/") || filePath.includes("\\_trash\\")) {
					return;
				}

				// Check if this is a post folder (has _ID suffix)
				const baseName = path.basename(filePath);
				if (/_\d+$/.test(baseName)) {
					this.debugLogger.log(
						`🔔 [VS Code Watcher] Folder deleted: ${baseName}`
					);
					this.handlePotentialRenameStart(filePath);
				}
			});

			// Store watcher (reuse the same property for all watchers)
			if (!this.vscodeNewFolderWatcher) {
				this.vscodeNewFolderWatcher = watcher;
			}

			this.debugLogger.log(
				`✅ New folder watcher started for ${folder.label} (VS Code native)`
			);
		}
	}

	/**
	 * Set up VS Code native FileSystemWatcher for theme files.
	 *
	 * This watcher uses the LOCAL dev folder (resolved by the IDE workspace manager)
	 * so it works regardless of the server-side dev_path WordPress returns.
	 * It watches for all file changes/creates outside post-types/ and triggers
	 * the same handleThemeFileChange() flow (which routes acf-json/ to the
	 * dedicated sync endpoint and everything else to the generic asset sync).
	 */
	private setupVscodeThemeWatcher() {
		// Clean up previous watcher
		if (this.vscodeThemeWatcher) {
			this.vscodeThemeWatcher.dispose();
			this.vscodeThemeWatcher = null;
		}

		const localFolder = this.localDevFolder.replace(/\\/g, "/");
		this.debugLogger.info(
			`👀 [Theme Watcher] Setting up VS Code native watcher for: ${localFolder}`
		);

		// In remote mode with a local dev path (e.g. C:/Users/...),
		// we can't watch from the server. Skip the watcher gracefully.
		const isLocalWindowsPath = /^[A-Za-z]:\//.test(localFolder);
		const wf = vscode.workspace.workspaceFolders?.[0];
		const isRemoteWorkspace = wf && wf.uri.scheme !== "file";

		if (isLocalWindowsPath && isRemoteWorkspace) {
			this.debugLogger.info(
				`⏭️ [Theme Watcher] Skipping — local dev path (${localFolder}) is not accessible from the remote server. File pushing happens via REST API.`
			);
			return;
		}

		const baseUri =
			wf && (wf.uri.scheme === "vscode-remote" || wf.uri.scheme === "file")
				? wf.uri.with({ path: localFolder })
				: vscode.Uri.file(localFolder);

		// Watch all files inside the dev folder (e.g. .../sirc-dev-root/acf-json/**)
		const pattern = new vscode.RelativePattern(baseUri, "**/*");

		this.vscodeThemeWatcher = vscode.workspace.createFileSystemWatcher(
			pattern,
			false, // onDidCreate
			false, // onDidChange
			true // onDidDelete (ignore)
		);

		const handleVscodeEvent = (uri: vscode.Uri, eventType: string) => {
			const filePath = uri.fsPath;
			const normalizedPath = filePath.replace(/\\/g, "/");

			// Skip dotfiles and build artifacts
			const fileName = path.basename(normalizedPath);
			if (fileName.startsWith(".")) {
				return;
			}
			if (
				normalizedPath.includes("/node_modules/") ||
				normalizedPath.includes("/.git/") ||
				normalizedPath.includes("/.vscode/") ||
				normalizedPath.includes("/.cursor/") ||
				normalizedPath.includes("/.skylit/")
			) {
				return;
			}

			// Skip directories (VS Code watcher fires for dirs too)
			// We only want files - check by extension presence
			const ext = path.extname(fileName);
			if (!ext) {
				return;
			}

			// Content files (HTML/CSS) in any content folder need to sync to WordPress
			// Media library files — route to media sync handler
			if (normalizedPath.includes("/media-library/")) {
				const chokidarEvent =
					eventType === "changed" ? "change" :
					eventType === "created" ? "add" : "unlink";
				this.handleMediaFileChange(filePath, chokidarEvent);
				return;
			}

			const isContentFolder =
				normalizedPath.includes("/post-types/") ||
				normalizedPath.includes("/templates/") ||
				normalizedPath.includes("/parts/") ||
				normalizedPath.includes("/patterns/");

			if (isContentFolder) {
				if (this.startupSyncInProgress) {
					this.debugLogger.log(
						`📝 [VS Code Watcher] Content file ${eventType} (during startup, ignoring): ${normalizedPath}`
					);
					return;
				}
				this.debugLogger.info(
					`📝 [VS Code Watcher] Content file ${eventType}: ${normalizedPath}`
				);
				if (eventType === "changed") {
					this.handleFileChange(filePath);
				}
				return;
			}

			this.debugLogger.info(
				`📝 [VS Code Watcher] File ${eventType}: ${normalizedPath}`
			);

			this.handleThemeFileChange(filePath);
		};

		this.vscodeThemeWatcher.onDidChange((uri) => {
			handleVscodeEvent(uri, "changed");
		});

		this.vscodeThemeWatcher.onDidCreate((uri) => {
			handleVscodeEvent(uri, "created");
		});

		this.debugLogger.info(
			`✅ [Theme Watcher] VS Code native watcher active for: ${localFolder}`
		);
	}

	/**
	 * Start watching for changes in JSON metadata files
	 * When slug/title/status changes in JSON, sync to WordPress and rename files if needed
	 */
	private async startMetadataWatcher() {
		const metadataPath = posixJoin(this.devFolder, ".skylit", "metadata");

		this.debugLogger.log(
			`🔍 [Metadata Watcher] Checking for .skylit/metadata at: ${metadataPath}`
		);

		// Check if folder exists (may fail on SSH, that's OK - chokidar can still watch it)
		let folderExists = false;
		try {
			folderExists = fs.existsSync(metadataPath);
		} catch (err: any) {
			this.debugLogger.log(
				`🔍 [Metadata Watcher] Could not check folder existence (SSH?): ${err.message}`
			);
			this.debugLogger.log(
				`🔍 [Metadata Watcher] Will try to watch anyway (chokidar handles SSH paths)`
			);
		}

		if (!folderExists) {
			this.debugLogger.log(
				`⚠️ .skylit/metadata folder not found via fs.existsSync() at: ${metadataPath}`
			);

			// Try to list what's in .skylit folder if it exists (diagnostic)
			const skylitPath = posixJoin(this.devFolder, ".skylit");
			try {
				if (fs.existsSync(skylitPath)) {
					const contents = fs.readdirSync(skylitPath);
					this.debugLogger.log(
						`🔍 [Metadata Watcher] .skylit folder contents: ${contents.join(
							", "
						)}`
					);
				} else {
					this.debugLogger.log(
						`🔍 [Metadata Watcher] .skylit folder does not exist via fs at: ${skylitPath}`
					);
				}
			} catch (err: any) {
				this.debugLogger.log(
					`🔍 [Metadata Watcher] Could not read .skylit folder with fs (SSH expected): ${err.message}`
				);
			}

			// On SSH, fs operations fail but chokidar can still watch the path
			// Try to start the watcher anyway
			this.debugLogger.log(
				`🔄 [Metadata Watcher] Attempting to start watcher anyway (SSH compatibility)`
			);
		}

		this.debugLogger.log(`👀 Starting metadata watcher for: ${metadataPath}`);

		// Load initial metadata cache
		// This uses fs operations which may fail on SSH - that's OK
		try {
			await this.loadMetadataCache(metadataPath);
			await this.buildReverseIndex(metadataPath);
		} catch (err: any) {
			this.debugLogger.log(
				`⚠️ Could not load metadata cache (SSH expected): ${err.message}`
			);
			this.debugLogger.log(
				`ℹ️ Watcher will still monitor for metadata changes after connection`
			);
		}

		this.metadataWatcher = chokidar.watch(`${metadataPath}/*.json`, {
			ignoreInitial: true,
			persistent: true,
			awaitWriteFinish: {
				stabilityThreshold: 500,
				pollInterval: 100,
			},
		});

		this.metadataWatcher.on("change", (filePath) => {
			this.handleMetadataChange(filePath);
		});

		this.metadataWatcher.on("error", (error) => {
			this.debugLogger.log(`❌ Metadata watcher error: ${error.message}`);
		});

		this.debugLogger.log(
			"✅ Metadata watcher started (JSON → WordPress sync enabled)"
		);
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
				.filter(
					([name, type]) =>
						type === vscode.FileType.File && name.endsWith(".json")
				)
				.map(([name]) => name);

			for (const file of jsonFiles) {
				const filePath = posixJoin(metadataPath, file);
				const postId = parseInt(path.basename(file, ".json"), 10);

				if (isNaN(postId)) continue;

				try {
					const content = await vsReadFile(filePath);
					const data = JSON.parse(content);

					this.metadataCache.set(postId, {
						slug: data.slug || "",
						title: data.title || "",
						status: data.status || "",
						syncHash: data.syncHash || undefined,
						lastSyncTime: data.lastSyncTime || undefined,
						lastSyncDirection: data.lastSyncDirection || undefined,
					});
				} catch (e) {
					// Skip invalid JSON files
				}
			}

			this.debugLogger.log(
				`📦 Loaded ${this.metadataCache.size} metadata files into cache`
			);
		} catch (error: any) {
			this.debugLogger.log(
				`⚠️ Could not load metadata cache: ${error.message}`
			);
		}
	}

	/**
	 * Build reverse index mapping relative folder paths to post IDs
	 * from all .skylit/metadata/*.json files.
	 */
	private async buildReverseIndex(metadataPath: string) {
		this.pathToPostIdIndex.clear();
		try {
			if (!(await vsExists(metadataPath))) return;

			const dirEntries = await vsReadDir(metadataPath);
			const jsonFiles = dirEntries
				.filter(
					([name, type]) =>
						type === vscode.FileType.File && name.endsWith(".json")
				)
				.map(([name]) => name);

			for (const file of jsonFiles) {
				try {
					const filePath = posixJoin(metadataPath, file);
					const content = await vsReadFile(filePath);
					const data = JSON.parse(content);
					if (data.postId && data.file) {
						const folderRelative = path.dirname(data.file).replace(/\\/g, "/");
						this.pathToPostIdIndex.set(folderRelative, data.postId);
					}
				} catch {
					// Skip invalid files
				}
			}
			this.debugLogger.log(
				`📇 Built reverse index: ${this.pathToPostIdIndex.size} entries`
			);
		} catch (err: any) {
			this.debugLogger.log(`⚠️ Could not build reverse index: ${err.message}`);
		}
	}

	/**
	 * Handle changes to a metadata JSON file
	 * Uses VS Code's workspace.fs API for SSH compatibility
	 */
	private async handleMetadataChange(filePath: string) {
		const normalizedPath = filePath.replace(/\\/g, "/");
		const fileName = path.basename(normalizedPath);
		const postId = parseInt(path.basename(fileName, ".json"), 10);

		if (isNaN(postId)) {
			return;
		}

		// Check cooldown
		const lastSync = this.metadataSyncCooldown.get(postId) || 0;
		if (Date.now() - lastSync < 2000) {
			return; // Skip if recently synced (prevent loops)
		}

		this.debugLogger.log(`🔔 [Metadata] Change detected: ${fileName}`);

		// Invalidate live block line cache so next cursor move re-reads fresh lines
		this.liveBlockLines.delete(postId);

		try {
			const content = await vsReadFile(normalizedPath);
			const newData = JSON.parse(content);

			// Update reverse index
			if (newData.postId && newData.file) {
				const folderRelative = path.dirname(newData.file).replace(/\\/g, "/");
				this.pathToPostIdIndex.set(folderRelative, newData.postId);
			}

			const oldData = this.metadataCache.get(postId);

			// Check what changed
			const changes: {
				slug?: string;
				title?: string;
				status?: string;
			} = {};
			let hasChanges = false;

			if (oldData) {
				if (newData.slug && newData.slug !== oldData.slug) {
					changes.slug = newData.slug;
					hasChanges = true;
					this.debugLogger.log(
						`   📝 Slug changed: ${oldData.slug} → ${newData.slug}`
					);
				}
				if (newData.title && newData.title !== oldData.title) {
					changes.title = newData.title;
					hasChanges = true;
					this.debugLogger.log(
						`   📝 Title changed: ${oldData.title} → ${newData.title}`
					);
				}
				if (newData.status && newData.status !== oldData.status) {
					changes.status = newData.status;
					hasChanges = true;
					this.debugLogger.log(
						`   📝 Status changed: ${oldData.status} → ${newData.status}`
					);
					this.debugLogger.log(
						`   ℹ️  This change came from WordPress (not IDE)`
					);
				}
			} else {
				// First time seeing this file, just cache it
				this.metadataCache.set(postId, {
					slug: newData.slug || "",
					title: newData.title || "",
					status: newData.status || "",
				});
				return;
			}

			if (!hasChanges) {
				// Update cache even if no tracked changes (other fields may have changed)
				this.metadataCache.set(postId, {
					slug: newData.slug || oldData.slug,
					title: newData.title || oldData.title,
					status: newData.status || oldData.status,
				});
				return;
			}

			// Set cooldown
			this.metadataSyncCooldown.set(postId, Date.now());

			// If slug changed, rename folder and files first
			if (changes.slug) {
				await this.renamePostFiles(
					postId,
					oldData.slug,
					changes.slug,
					newData.postType || "page"
				);
			}

			// Sync changes to WordPress
			this.statusBar.showSyncing("Syncing metadata...");

			try {
				const response = await this.restClient.updateFromMetadata(
					postId,
					changes
				);

				if (response.success) {
					this.statusBar.showSuccess("Metadata synced");

					// Update cache with new values
					this.metadataCache.set(postId, {
						slug: changes.slug || oldData.slug,
						title: changes.title || oldData.title,
						status: changes.status || oldData.status,
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
	 * Parse WordPress Sync Metadata comment from HTML content
	 * Format:
	 * <!--
	 * WordPress Sync Metadata
	 * ID: 123
	 * Slug: page-name
	 * Title: Page Title
	 * Type: page
	 * Status: publish
	 * Modified: 2026-01-15 12:00:00
	 * -->
	 */
	private parseHtmlMetadataComment(html: string): {
		id?: number;
		slug?: string;
		title?: string;
		type?: string;
		status?: string;
		modified?: string;
	} | null {
		// Match the metadata comment block
		const match = html.match(
			/<!--\s*\n?\s*WordPress Sync Metadata\s*\n([\s\S]*?)-->/
		);
		if (!match) {
			return null;
		}

		const metadataBlock = match[1];
		const result: {
			id?: number;
			slug?: string;
			title?: string;
			type?: string;
			status?: string;
			modified?: string;
		} = {};

		// Parse each line
		const lines = metadataBlock.split("\n");
		for (const line of lines) {
			const colonIndex = line.indexOf(":");
			if (colonIndex === -1) continue;

			const key = line.substring(0, colonIndex).trim().toLowerCase();
			const value = line.substring(colonIndex + 1).trim();

			switch (key) {
				case "id":
					result.id = parseInt(value, 10);
					break;
				case "slug":
					result.slug = value;
					break;
				case "title":
					result.title = value;
					break;
				case "type":
					result.type = value;
					break;
				case "status":
					result.status = value;
					break;
				case "modified":
					result.modified = value;
					break;
			}
		}

		return Object.keys(result).length > 0 ? result : null;
	}

	/**
	 * Check and sync HTML metadata changes to WordPress
	 * Called during syncFile to detect if user edited the metadata comment
	 */
	private async checkAndSyncHtmlMetadata(
		postId: number,
		html: string,
		postFolder: string
	): Promise<boolean> {
		const htmlMetadata = this.parseHtmlMetadataComment(html);
		if (!htmlMetadata) {
			return false; // No metadata comment found
		}

		// Check if ID matches (safety check)
		if (htmlMetadata.id && htmlMetadata.id !== postId) {
			this.debugLogger.log(
				`⚠️ HTML metadata ID (${htmlMetadata.id}) doesn't match folder ID (${postId})`
			);
			return false;
		}

		// Get cached metadata for this post
		const cached = this.metadataCache.get(postId);
		if (!cached) {
			// First time seeing this post - cache current values
			this.metadataCache.set(postId, {
				slug: htmlMetadata.slug || "",
				title: htmlMetadata.title || "",
				status: htmlMetadata.status || "publish",
			});
			return false;
		}

		// Detect changes
		const changes: {
			slug?: string;
			title?: string;
			status?: string;
		} = {};
		let hasChanges = false;

		if (htmlMetadata.slug && htmlMetadata.slug !== cached.slug) {
			changes.slug = htmlMetadata.slug;
			hasChanges = true;
			this.debugLogger.log(
				`📝 [HTML Metadata] Slug changed: ${cached.slug} → ${htmlMetadata.slug}`
			);
		}

		if (htmlMetadata.title && htmlMetadata.title !== cached.title) {
			changes.title = htmlMetadata.title;
			hasChanges = true;
			this.debugLogger.log(
				`📝 [HTML Metadata] Title changed: ${cached.title} → ${htmlMetadata.title}`
			);
		}

		if (htmlMetadata.status && htmlMetadata.status !== cached.status) {
			// Validate status
			const validStatuses = [
				"publish",
				"draft",
				"pending",
				"private",
				"future",
			];
			if (validStatuses.includes(htmlMetadata.status)) {
				changes.status = htmlMetadata.status;
				hasChanges = true;
				this.debugLogger.log(
					`📝 [HTML Metadata] Status changed: ${cached.status} → ${htmlMetadata.status}`
				);
			}
		}

		if (!hasChanges) {
			return false;
		}

		// Set cooldown to prevent loops
		this.metadataSyncCooldown.set(postId, Date.now());

		// If slug changed, rename folder and files first
		if (changes.slug && cached.slug) {
			const postType = htmlMetadata.type || "page";
			await this.renamePostFilesUniversal(
				postId,
				cached.slug,
				changes.slug,
				postType,
				postFolder
			);
		}

		// Sync changes to WordPress
		this.statusBar.showSyncing("Syncing metadata...");

		try {
			const response = await this.restClient.updateFromMetadata(
				postId,
				changes
			);

			if (response.success) {
				this.statusBar.showSuccess("Metadata synced");

				// Update cache with new values
				this.metadataCache.set(postId, {
					slug: changes.slug || cached.slug,
					title: changes.title || cached.title,
					status: changes.status || cached.status,
				});

				// Also update JSON metadata to keep in sync
				await this.updateJsonMetadata(postId, changes);

				this.debugLogger.log(`✅ [HTML Metadata] Synced to WordPress`);
				return true;
			} else {
				this.debugLogger.log(
					`⚠️ [HTML Metadata] Sync failed: ${response.error}`
				);
				return false;
			}
		} catch (error: any) {
			this.debugLogger.log(`❌ [HTML Metadata] Sync error: ${error.message}`);
			return false;
		}
	}

	/**
	 * Rename post folder and files - universal version that handles all post types
	 * Uses VS Code's workspace.fs API for SSH compatibility
	 */
	private async renamePostFilesUniversal(
		postId: number,
		oldSlug: string,
		newSlug: string,
		postType: string,
		currentFolderPath: string
	) {
		this.debugLogger.log(
			`📂 Renaming files for ${postType} ${postId}: ${oldSlug} → ${newSlug}`
		);

		try {
			// Determine folder structure based on post type
			let parentPath: string;
			let usesIdSuffix: boolean;

			switch (postType) {
				case "page":
					parentPath = posixJoin(this.devFolder, "post-types", "pages");
					usesIdSuffix = true;
					break;
				case "post":
					parentPath = posixJoin(this.devFolder, "post-types", "posts");
					usesIdSuffix = true;
					break;
				case "wp_template":
					parentPath = posixJoin(this.devFolder, "templates");
					usesIdSuffix = true; // Templates also use _ID suffix
					break;
				case "wp_template_part":
					parentPath = posixJoin(this.devFolder, "parts");
					usesIdSuffix = true;
					break;
				case "wp_block":
					parentPath = posixJoin(this.devFolder, "patterns");
					usesIdSuffix = true;
					break;
				default:
					// Custom post type
					parentPath = posixJoin(this.devFolder, "post-types", postType + "s");
					usesIdSuffix = true;
					break;
			}

			const oldFolderName = usesIdSuffix ? `${oldSlug}_${postId}` : oldSlug;
			const newFolderName = usesIdSuffix ? `${newSlug}_${postId}` : newSlug;

			const oldFolderPath = posixJoin(parentPath, oldFolderName);
			const newFolderPath = posixJoin(parentPath, newFolderName);

			// Check if old folder exists
			if (!(await vsExists(oldFolderPath))) {
				this.debugLogger.log(`⚠️ Old folder not found: ${oldFolderName}`);
				return;
			}

			// Check if new folder already exists
			if (await vsExists(newFolderPath)) {
				this.debugLogger.log(`⚠️ New folder already exists: ${newFolderName}`);
				return;
			}

			// Rename files inside the folder first
			const oldHtmlPath = posixJoin(oldFolderPath, `${oldFolderName}.html`);
			const newHtmlPath = posixJoin(oldFolderPath, `${newFolderName}.html`);
			const oldCssPath = posixJoin(oldFolderPath, `${oldFolderName}.css`);
			const newCssPath = posixJoin(oldFolderPath, `${newFolderName}.css`);

			if (await vsExists(oldHtmlPath)) {
				// Update the HTML metadata comment with new slug before renaming
				await this.updateHtmlMetadataSlug(oldHtmlPath, newSlug);
				await vsRename(oldHtmlPath, newHtmlPath);
				this.debugLogger.log(
					`   ✓ HTML: ${oldFolderName}.html → ${newFolderName}.html`
				);
			}

			if (await vsExists(oldCssPath)) {
				await vsRename(oldCssPath, newCssPath);
				this.debugLogger.log(
					`   ✓ CSS: ${oldFolderName}.css → ${newFolderName}.css`
				);
			}

			// Rename the folder
			await vsRename(oldFolderPath, newFolderPath);
			this.debugLogger.log(`   ✓ Folder: ${oldFolderName} → ${newFolderName}`);

			// Handle open editors
			const relativePath = newFolderPath.replace(this.devFolder + "/", "");
			await this.handleFileRename(oldFolderPath, relativePath, postId);
		} catch (error: any) {
			this.debugLogger.log(`❌ Failed to rename files: ${error.message}`);
		}
	}

	/**
	 * Update the slug in HTML metadata comment
	 */
	private async updateHtmlMetadataSlug(htmlPath: string, newSlug: string) {
		try {
			let content = await vsReadFile(htmlPath);

			// Replace the Slug line in the metadata comment
			content = content.replace(
				/(<!--\s*\n?\s*WordPress Sync Metadata[\s\S]*?Slug:\s*)([^\n]+)/,
				`$1${newSlug}`
			);

			// Also update Modified timestamp
			const now = new Date().toISOString().replace("T", " ").substring(0, 19);
			content = content.replace(
				/(<!--\s*\n?\s*WordPress Sync Metadata[\s\S]*?Modified:\s*)([^\n]+)/,
				`$1${now}`
			);

			await vsWriteFile(htmlPath, content);
		} catch (error: any) {
			this.debugLogger.log(
				`⚠️ Could not update HTML metadata: ${error.message}`
			);
		}
	}

	/**
	 * Rename post folder and files when slug changes in metadata
	 * Uses VS Code's workspace.fs API for SSH compatibility
	 */
	private async renamePostFiles(
		postId: number,
		oldSlug: string,
		newSlug: string,
		postType: string
	) {
		this.debugLogger.log(
			`📂 Renaming files for post ${postId}: ${oldSlug} → ${newSlug}`
		);

		try {
			// Build paths
			const postTypeFolderName = postType + "s"; // e.g., 'page' → 'pages'
			const postTypePath = posixJoin(
				this.devFolder,
				"post-types",
				postTypeFolderName
			);

			const oldFolderName = `${oldSlug}_${postId}`;
			const newFolderName = `${newSlug}_${postId}`;

			const oldFolderPath = posixJoin(postTypePath, oldFolderName);
			const newFolderPath = posixJoin(postTypePath, newFolderName);

			// Check if old folder exists (using VS Code FS API)
			if (!(await vsExists(oldFolderPath))) {
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
				this.debugLogger.log(
					`   ✓ HTML: ${oldFolderName}.html → ${newFolderName}.html`
				);
			}

			if (await vsExists(oldCssPath)) {
				await vsRename(oldCssPath, newCssPath);
				this.debugLogger.log(
					`   ✓ CSS: ${oldFolderName}.css → ${newFolderName}.css`
				);
			}

			// Rename the folder (using VS Code FS API)
			await vsRename(oldFolderPath, newFolderPath);
			this.debugLogger.log(`   ✓ Folder: ${oldFolderName} → ${newFolderName}`);

			// Update JSON's file path to stay in sync
			const newFilePath = `post-types/${postTypeFolderName}/${newFolderName}/${newFolderName}.html`;
			await this.updateJsonMetadataFilePath(postId, newFilePath);

			// Handle open editors - close old file and open new file
			await this.handleFileRename(
				oldFolderPath,
				`post-types/${postTypeFolderName}/${newFolderName}`,
				postId
			);
		} catch (error: any) {
			this.debugLogger.log(`❌ Failed to rename files: ${error.message}`);
		}
	}

	/**
	 * Update only the file path in JSON metadata (for internal updates that shouldn't trigger full sync)
	 * Uses VS Code's workspace.fs API for SSH compatibility
	 */
	private async updateJsonMetadataFilePath(
		postId: number,
		newFilePath: string
	) {
		const metadataPath = posixJoin(
			this.devFolder,
			".skylit",
			"metadata",
			`${postId}.json`
		);

		if (!(await vsExists(metadataPath))) {
			return;
		}

		try {
			// Set cooldown to prevent triggering another sync
			this.metadataSyncCooldown.set(postId, Date.now());

			const content = await vsReadFile(metadataPath);
			const metadata = JSON.parse(content);

			const now = new Date().toISOString();
			metadata.file = newFilePath;
			metadata.lastExported = now.replace("T", " ").substring(0, 19);
			metadata.lastSyncTime = now;

			await vsWriteFile(metadataPath, JSON.stringify(metadata, null, 4));
			this.debugLogger.log(`   ✓ JSON file path updated`);
		} catch (error: any) {
			this.debugLogger.log(
				`⚠️ Could not update JSON file path: ${error.message}`
			);
		}
	}

	/**
	 * Extract post ID from folder path using the reverse index (metadata-first),
	 * falling back to .post-id marker and legacy _ID suffix.
	 */
	private extractPostIdFromPath(dirPath: string): number | null {
		const normalizedDir = dirPath.replace(/\\/g, "/");
		const devFolderNormalized = this.devFolder.replace(/\\/g, "/");
		const relativePath = normalizedDir
			.replace(devFolderNormalized, "")
			.replace(/^\//, "");

		// 1. Metadata-driven reverse index (folder relative path → postId)
		const postId = this.pathToPostIdIndex.get(relativePath);
		if (postId) return postId;

		// 2. Legacy fallback: _ID suffix in folder name
		const folderName = path.basename(dirPath);
		const match = folderName.match(/_(\d+)$/);
		if (match) return parseInt(match[1], 10);

		// 3. Slug-based: reverse lookup in metadata cache
		for (const [pid, meta] of this.metadataCache.entries()) {
			if (meta.slug === folderName) {
				return pid;
			}
		}

		return null;
	}

	/**
	 * Public helper: resolve post ID from an absolute file path.
	 */
	public getPostIdForFile(filePath: string): number | null {
		const dir = path.dirname(filePath);
		return this.extractPostIdFromPath(dir);
	}

	/**
	 * Handle potential rename start (folder with _ID removed)
	 */
	private handlePotentialRenameStart(dirPath: string) {
		const normalizedPath = dirPath.replace(/\\/g, "/");
		const folderName = path.basename(normalizedPath);
		const postId = this.extractPostIdFromPath(dirPath);

		// Only track folders with _ID suffix (existing posts)
		if (!postId) {
			return;
		}

		// Don't track trash operations
		if (normalizedPath.includes("/_trash/")) {
			return;
		}

		const oldSlug = folderName;

		this.debugLogger.log(`🔄 Folder removed (potential rename): ${folderName}`);

		// Store for matching with subsequent addDir
		this.pendingRenames.set(postId, {
			oldPath: normalizedPath,
			oldSlug: oldSlug,
			timestamp: Date.now(),
		});

		// Clean up after timeout (if no addDir follows, it was a delete, not rename)
		setTimeout(() => {
			if (this.pendingRenames.has(postId)) {
				const pending = this.pendingRenames.get(postId)!;
				if (Date.now() - pending.timestamp >= this.renameCooldownMs) {
					this.pendingRenames.delete(postId);
					this.debugLogger.log(
						`🗑️ Folder delete confirmed (no rename): ${folderName}`
					);

					// Ask user what to do with the WordPress post
					this.promptDeleteAction(postId, folderName);
				}
			}
		}, this.renameCooldownMs + 100);
	}

	/**
	 * Prompt user for what to do when a post folder is deleted from IDE
	 */
	private async promptDeleteAction(postId: number, folderName: string) {
		// Skip prompt if this post is being deleted via command (already confirmed)
		if (this.skipDeletePromptForPosts.has(postId)) {
			this.skipDeletePromptForPosts.delete(postId);
			this.debugLogger.log(
				`⏭️ Skipping delete prompt for post ${postId} (already handled via command)`
			);
			return;
		}

		const trashOption = "Move to Trash";
		const deleteOption = "Delete Permanently";
		const keepOption = "Keep in WordPress";

		const choice = await vscode.window.showWarningMessage(
			`Folder "${folderName}" was deleted`,
			{
				modal: true,
				detail: `What would you like to do with the WordPress post (ID: ${postId})?\n\n• Move to Trash: Post goes to WordPress trash (recoverable)\n• Delete Permanently: Post removed from database and metadata cleaned up\n• Keep in WordPress: Do nothing (post stays in database)`,
			},
			trashOption,
			deleteOption,
			keepOption
		);

		if (!choice || choice === keepOption) {
			this.debugLogger.log(`📁 User chose to keep post ${postId} in WordPress`);
			return;
		}

		const action = choice === trashOption ? "trash" : "delete";

		try {
			this.debugLogger.log(`📤 Sending ${action} action for post ${postId}...`);
			this.statusBar.showSyncing(
				`${action === "trash" ? "Trashing" : "Deleting"} post...`
			);

			const response = await this.restClient.sendFolderAction(postId, action);

		if (response.success) {
			const actionVerb =
				action === "trash" ? "moved to trash" : "permanently deleted";
			this.debugLogger.log(`✅ Post ${postId} ${actionVerb}`);
			this.statusBar.showSuccess(`Post ${actionVerb}`, 3000);
			vscode.window.showInformationMessage(
				`✅ Post ${postId} ${actionVerb} in WordPress`
			);

				// Clean up local metadata file for permanent deletes
				if (action === "delete") {
					this.deleteMetadataFile(postId);
				}
			} else {
				this.statusBar.showError("Action failed");
			}
		} catch (error: any) {
			this.debugLogger.log(`❌ ${action} failed: ${error.message}`);
			this.statusBar.showError(`Failed: ${error.message}`);
			vscode.window.showErrorMessage(
				`Failed to ${action} post ${postId}: ${error.message}`
			);
		}
	}

	/**
	 * Delete local metadata file for a post
	 */
	private deleteMetadataFile(postId: number) {
		try {
			const metadataPath = posixJoin(
				this.devFolder,
				".skylit",
				"metadata",
				`${postId}.json`
			);
			if (fs.existsSync(metadataPath)) {
				fs.unlinkSync(metadataPath);
				this.debugLogger.log(`🗑️ Deleted metadata file: ${postId}.json`);
			}
		} catch (error: any) {
			this.debugLogger.log(
				`⚠️ Could not delete metadata file: ${error.message}`
			);
		}
	}

	/**
	 * Handle rename completion (folder with same _ID reappeared with new name)
	 */
	private async handleRenameComplete(dirPath: string, postId: number) {
		const normalizedPath = dirPath.replace(/\\/g, "/");
		const folderName = path.basename(normalizedPath);
		const newSlug = folderName;

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

		this.debugLogger.log(
			`📝 Folder renamed: ${pending.oldSlug} → ${newSlug} (post ${postId})`
		);
		this.statusBar.showSyncing("Updating slug...");

		try {
			const response = await this.restClient.updatePostSlug(postId, newSlug);

			if (response.success) {
				this.statusBar.showSuccess("Slug updated");
				this.debugLogger.log(
					`✅ WordPress slug updated: ${pending.oldSlug} → ${newSlug}`
				);

				// Update JSON metadata to stay in sync with folder
				await this.updateJsonMetadata(postId, {
					slug: newSlug,
				});

				// Update local cache
				const cached = this.metadataCache.get(postId);
				if (cached) {
					cached.slug = newSlug;
					this.metadataCache.set(postId, cached);
				}

				// Show notification
				const config = vscode.workspace.getConfiguration("skylit");
				if (config.get<boolean>("showNotifications", true)) {
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
	private async updateJsonMetadata(
		postId: number,
		updates: {
			slug?: string;
			title?: string;
			status?: string;
			file?: string;
		}
	) {
		const metadataPath = posixJoin(
			this.devFolder,
			".skylit",
			"metadata",
			`${postId}.json`
		);

		if (!(await vsExists(metadataPath))) {
			this.debugLogger.log(`⚠️ Metadata file not found: ${postId}.json`);
			return;
		}

		try {
			this.metadataSyncCooldown.set(postId, Date.now());

			const content = await vsReadFile(metadataPath);
			const metadata = JSON.parse(content);

			if (updates.slug !== undefined) {
				const oldSlug = metadata.slug;
				metadata.slug = updates.slug;

				// Update the file path: replace old slug with new slug
				if (metadata.file && oldSlug) {
					metadata.file = metadata.file
						.replace(
							new RegExp(`/${oldSlug}/${oldSlug}\\.`, "g"),
							`/${updates.slug}/${updates.slug}.`
						)
						.replace(
							new RegExp(`/${oldSlug}_\\d+/${oldSlug}_\\d+\\.`, "g"),
							`/${updates.slug}/${updates.slug}.`
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

			const now = new Date().toISOString();
			metadata.lastExported = now.replace("T", " ").substring(0, 19);
			metadata.lastEditTime = now;
			metadata.lastSyncTime = now;
			metadata.lastSyncDirection = "dev-to-wp";

			await vsWriteFile(metadataPath, JSON.stringify(metadata, null, 4));
			this.debugLogger.log(`📦 JSON metadata updated: ${postId}.json`);
		} catch (error: any) {
			this.debugLogger.log(
				`❌ Failed to update JSON metadata: ${error.message}`
			);
		}
	}

	/**
	 * Handle potential new folder that might need a WordPress post created
	 */
	private handlePotentialNewFolder(dirPath: string) {
		const normalizedPath = dirPath.replace(/\\/g, "/");
		// Remove trailing slash from devFolder for consistent matching
		const devFolderNormalized = this.devFolder
			.replace(/\\/g, "/")
			.replace(/\/$/, "");

		this.debugLogger.log(`🔍 [New Folder] Checking: ${normalizedPath}`);
		this.debugLogger.log(`🔍 [New Folder] Dev folder: ${devFolderNormalized}`);

		// Get relative path from dev folder
		let relativePath = normalizedPath;
		if (normalizedPath.startsWith(devFolderNormalized + "/")) {
			relativePath = normalizedPath.substring(devFolderNormalized.length + 1);
		} else if (normalizedPath.startsWith(devFolderNormalized)) {
			relativePath = normalizedPath.substring(devFolderNormalized.length);
			if (relativePath.startsWith("/")) {
				relativePath = relativePath.substring(1);
			}
		}

		this.debugLogger.log(`🔍 [New Folder] Relative path: ${relativePath}`);

		// Handle different folder structures:
		// - post-types/[type]/[folder] (pages, posts)
		// - templates/[folder] (FSE templates)
		// - parts/[folder] (FSE template parts)
		const parts = relativePath.split("/");
		this.debugLogger.log(
			`🔍 [New Folder] Parts: ${JSON.stringify(parts)} (length: ${
				parts.length
			})`
		);

		let postTypeFolder: string;
		let folderName: string;

		if (parts.length === 3 && parts[0] === "post-types") {
			// Regular post types: post-types/pages/about-us
			postTypeFolder = parts[1]; // e.g., "pages", "posts"
			folderName = parts[2]; // e.g., "about-us" or "about-us_123"
		} else if (parts.length === 2 && parts[0] === "templates") {
			// FSE templates: templates/page
			postTypeFolder = "wp_template";
			folderName = parts[1];
		} else if (parts.length === 2 && parts[0] === "parts") {
			// FSE template parts: parts/header
			postTypeFolder = "wp_template_part";
			folderName = parts[1];
		} else if (
			parts.length === 3 &&
			parts[0] === "patterns" &&
			(parts[1] === "synced" || parts[1] === "unsynced")
		) {
			// Patterns: patterns/synced/my-pattern or patterns/unsynced/my-pattern
			postTypeFolder = "wp_block";
			folderName = parts[2];
		} else {
			this.debugLogger.log(`🔍 [New Folder] Skipping - not a content folder`);
			return; // Not a content folder
		}

		// Skip if already has _ID suffix (already linked to a post)
		if (/_\d+$/.test(folderName)) {
			this.debugLogger.log(
				`🔍 [New Folder] Skipping - already has post ID: ${folderName}`
			);
			return;
		}

		// Skip if in _trash
		if (folderName === "_trash" || relativePath.includes("/_trash/")) {
			this.debugLogger.log(
				`🔍 [New Folder] Skipping - in trash: ${folderName}`
			);
			return;
		}

		// Skip if already processed
		if (this.processedNewFolders.has(normalizedPath)) {
			this.debugLogger.log(
				`🔍 [New Folder] Skipping - already processed: ${folderName}`
			);
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
			await this.createPostFromNewFolder(
				normalizedPath,
				postTypeFolder,
				folderName,
				relativePath
			);
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
		this.debugLogger.log(
			`🔍 [Create Post] Dir contents: ${JSON.stringify(
				dirContents.map(([n, t]) => `${n}(${t})`)
			)}`
		);

		const htmlFiles = dirContents
			.filter(
				([name, type]) =>
					type === vscode.FileType.File && name.endsWith(".html")
			)
			.map(([name]) => name);

		this.debugLogger.log(
			`🔍 [Create Post] HTML files found: ${JSON.stringify(htmlFiles)}`
		);

		if (htmlFiles.length === 0) {
			this.debugLogger.log(
				`⏳ No HTML file yet in ${relativePath}, will retry when HTML is added...`
			);
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
			const response = await this.restClient.createPostFromFolder(
				relativePath,
				postType
			);

			if (response.success && response.post_id) {
				this.statusBar.showSuccess(`Created: ${response.title}`);
				this.debugLogger.log(
					`✅ Created ${postType} "${response.title}" (ID: ${response.post_id})`
				);

				// Determine correct path based on post type
				let basePath: string;
				if (postTypeFolder === "wp_template") {
					basePath = "templates";
				} else if (postTypeFolder === "wp_template_part") {
					basePath = "parts";
				} else if (postTypeFolder === "wp_block") {
					const patternParts = relativePath.split("/");
					basePath = `${patternParts[0]}/${patternParts[1]}`;
				} else {
					basePath = `post-types/${postTypeFolder}`;
				}

				// Update reverse index for path-to-postID lookups
				const slug = response.slug || folderName;
				this.pathToPostIdIndex.set(`${basePath}/${slug}`, response.post_id);

				// Write canonical HTML (with metadata header) back to disk
				const canonicalHtml = (response as any).canonical_html;
				if (canonicalHtml && typeof canonicalHtml === "string") {
					const htmlPath = posixJoin(
						this.devFolder,
						basePath,
						slug,
						`${slug}.html`
					);
					try {
						this.lastSyncTime.set(htmlPath, Date.now());
						this.selfWrittenPaths.set(htmlPath, Date.now());
						await vsWriteFile(htmlPath, canonicalHtml);
						this.debugLogger.log(
							`📝 Wrote canonical HTML with metadata header: ${slug}.html`
						);
					} catch (e: any) {
						this.debugLogger.log(
							`⚠️ Could not write canonical HTML: ${e.message}`
						);
					}
				}
				const canonicalCss = (response as any).canonical_css;
				if (canonicalCss && typeof canonicalCss === "string") {
					const cssPath = posixJoin(
						this.devFolder,
						basePath,
						slug,
						`${slug}.css`
					);
					try {
						this.lastSyncTime.set(cssPath, Date.now());
						this.selfWrittenPaths.set(cssPath, Date.now());
						await vsWriteFile(cssPath, canonicalCss);
					} catch {}
				}

				// Write notification JSON for AI
				response.new_folder = `${basePath}/${slug}`;
				await this.writePostCreationNotification(response, postType);

				const config = vscode.workspace.getConfiguration("skylit");
				if (config.get<boolean>("showNotifications", true)) {
					vscode.window.showInformationMessage(
						`✅ Created ${postType}: ${response.title} (ID: ${response.post_id})`
					);
				}
			} else {
				this.debugLogger.log(`⚠️ Could not create post: ${response.error}`);
				this.statusBar.showError(response.error || "Failed to create post");
				// Remove from processed so it can be retried
				this.processedNewFolders.delete(folderPath);
			}
		} catch (error: any) {
			this.debugLogger.log(`❌ Failed to create post: ${error.message}`);
			this.processedNewFolders.delete(folderPath);
			this.statusBar.showError(`Failed: ${error.message}`);
			vscode.window.showErrorMessage(
				`Failed to create ${postType}: ${error.message}`
			);
		}
	}

	/**
	 * Write a notification file for AI agents when a post is created
	 * This allows AI to know the new folder path after auto-rename
	 * Same format as processAICreatePostRequest for consistency
	 */
	private async writePostCreationNotification(
		response: {
			post_id?: number;
			title?: string;
			new_folder?: string;
			slug?: string;
		},
		postType: string
	) {
		if (!response.post_id) {
			return; // No post ID, nothing to write
		}
		const skylitPath = posixJoin(this.devFolder, ".skylit");
		const resultFile = posixJoin(skylitPath, "last-created-post.json");

		try {
			// Ensure .skylit folder exists
			const skylitUri = pathToUri(skylitPath);
			try {
				await vscode.workspace.fs.stat(skylitUri);
			} catch {
				await vscode.workspace.fs.createDirectory(skylitUri);
			}

			const slug =
				response.slug ||
				(response.new_folder ? path.basename(response.new_folder) : "");
			const folderName = response.new_folder || "";
			const fullPath = `${this.devFolder.replace(/\\/g, "/")}/${
				response.new_folder || ""
			}`;

			const resultData = {
				success: true,
				post_id: response.post_id,
				post_type: postType,
				title: response.title || "",
				slug: slug,
				folder_name: folderName,
				folder_path: response.new_folder || "",
				full_path: fullPath,
				html_file: `${fullPath}/${folderName}.html`,
				css_file: `${fullPath}/${folderName}.css`,
				created_at: new Date().toISOString(),
				auto_created: true, // Flag to indicate this was auto-created (not via AI request)
			};

			// Write result
			await vsWriteFile(resultFile, JSON.stringify(resultData, null, 2));

			this.debugLogger.log(
				`📝 [Folder Auto-Create] Notification written to: ${resultFile}`
			);
			this.debugLogger.log(
				`   AI can now read this to know the new path: ${folderName}`
			);
		} catch (error: any) {
			this.debugLogger.log(
				`⚠️ Could not write notification file: ${error.message}`
			);
			// Non-critical - don't throw
		}
	}

	/**
	 * Handle file rename in open editors
	 * Closes old file if open and opens new file
	 */
	private async handleFileRename(
		oldFolderPath: string,
		newRelativePath: string | undefined,
		postId: number
	) {
		if (!newRelativePath) return;

		try {
			// Build paths
			const newFolderPath = posixJoin(this.devFolder, newRelativePath);
			const newFolderName = path.basename(newFolderPath);
			const newHtmlPath = posixJoin(newFolderPath, `${newFolderName}.html`);

			// Find any open editors with files from the old folder
			const oldFolderPathNormalized = oldFolderPath.replace(/\\/g, "/");

			for (const tabGroup of vscode.window.tabGroups.all) {
				for (const tab of tabGroup.tabs) {
					if (tab.input instanceof vscode.TabInputText) {
						const uri = tab.input.uri;
						const uriPath = uri.fsPath.replace(/\\/g, "/");

						// Check if this file was from the old folder
						if (uriPath.startsWith(oldFolderPathNormalized)) {
							this.debugLogger.log(
								`📂 Closing old file: ${path.basename(uriPath)}`
							);

							// Close the old tab
							await vscode.window.tabGroups.close(tab);
						}
					}
				}
			}

			// Open the new file (using VS Code FS API for SSH compatibility)
			if (await vsExists(newHtmlPath)) {
				this.debugLogger.log(`📂 Opening new file: ${newFolderName}.html`);
				const newUri = pathToUri(newHtmlPath);
				await vscode.window.showTextDocument(newUri);
			}
		} catch (error: any) {
			this.debugLogger.log(
				`⚠️ Could not update open editors: ${error.message}`
			);
		}
	}

	/**
	 * Map post-types folder name to WordPress post type
	 */
	private mapFolderToPostType(folderName: string): string {
		const mappings: Record<string, string> = {
			pages: "page",
			posts: "post",
			products: "product",
			wp_template: "wp_template",
			wp_template_part: "wp_template_part",
			wp_block: "wp_block",
		};

		return mappings[folderName] || folderName;
	}

	/**
	 * Scan a content directory for existing folders without linked WordPress posts.
	 * Handles all structures:
	 *   post-types/[type]/[slug]   → page, post, etc.
	 *   templates/[slug]           → wp_template
	 *   parts/[slug]               → wp_template_part
	 *   patterns/[synced|unsynced]/[slug] → wp_block
	 */
	private async scanForNewFolders(rootPath: string) {
		const devNorm = this.devFolder.replace(/\\/g, "/").replace(/\/$/, "");
		const rootNorm = rootPath.replace(/\\/g, "/").replace(/\/$/, "");
		const rootLabel = rootNorm.replace(devNorm + "/", "");

		this.debugLogger.log(`🔍 Scanning ${rootLabel} for unlinked folders...`);

		try {
			if (!(await vsExists(rootPath))) {
				this.debugLogger.log(
					`   ℹ️ ${rootLabel} folder does not exist, skipping`
				);
				return;
			}

			// Collect content-folder candidates: { absolutePath, relativePath, postType }
			const candidates: Array<{
				absPath: string;
				relPath: string;
				postType: string;
			}> = [];

			const topEntries = await vsReadDir(rootPath);
			const topDirs = topEntries.filter(
				([n, t]) =>
					t === vscode.FileType.Directory &&
					!n.startsWith(".") &&
					n !== "_trash" &&
					n !== "block-styles"
			);

			if (rootLabel === "post-types") {
				// Two levels: post-types/pages/slug
				for (const [typeDirName] of topDirs) {
					const typePath = posixJoin(rootPath, typeDirName);
					const postType = this.mapFolderToPostType(typeDirName);
					const slugEntries = await vsReadDir(typePath);
					for (const [slug, sType] of slugEntries) {
						if (
							sType !== vscode.FileType.Directory ||
							slug.startsWith(".") ||
							slug === "_trash" ||
							slug === "block-styles"
						)
							continue;
						candidates.push({
							absPath: posixJoin(typePath, slug),
							relPath: `post-types/${typeDirName}/${slug}`,
							postType,
						});
					}
				}
			} else if (rootLabel === "templates") {
				for (const [slug] of topDirs) {
					candidates.push({
						absPath: posixJoin(rootPath, slug),
						relPath: `templates/${slug}`,
						postType: "wp_template",
					});
				}
			} else if (rootLabel === "parts") {
				for (const [slug] of topDirs) {
					candidates.push({
						absPath: posixJoin(rootPath, slug),
						relPath: `parts/${slug}`,
						postType: "wp_template_part",
					});
				}
			} else if (rootLabel === "patterns") {
				// Two levels: patterns/synced/slug or patterns/unsynced/slug
				for (const [syncDir] of topDirs) {
					if (syncDir !== "synced" && syncDir !== "unsynced") continue;
					const syncPath = posixJoin(rootPath, syncDir);
					const slugEntries = await vsReadDir(syncPath);
					for (const [slug, sType] of slugEntries) {
						if (
							sType !== vscode.FileType.Directory ||
							slug.startsWith(".") ||
							slug === "_trash"
						)
							continue;
						candidates.push({
							absPath: posixJoin(syncPath, slug),
							relPath: `patterns/${syncDir}/${slug}`,
							postType: "wp_block",
						});
					}
				}
			}

			let foundCount = 0;
			let createdCount = 0;

			for (const { absPath, relPath, postType } of candidates) {
				const folderName = path.basename(absPath);

				// Skip if already has _ID suffix
				if (/_\d+$/.test(folderName)) continue;

				// Skip if already processed
				if (this.processedNewFolders.has(absPath)) continue;

				// Skip if already in metadata (has a linked post)
				let alreadyLinked = false;
				for (const [, meta] of this.metadataCache.entries()) {
					if (meta.slug === folderName) {
						alreadyLinked = true;
						break;
					}
				}
				if (alreadyLinked) continue;

				// Must have an HTML file
				const files = await vsReadDir(absPath);
				const hasHtml = files.some(
					([n, t]) => t === vscode.FileType.File && n.endsWith(".html")
				);
				if (!hasHtml) continue;

				foundCount++;
				this.debugLogger.log(`   📁 Unlinked folder: ${relPath}`);

				try {
					const response = await this.restClient.createPostFromFolder(
						relPath,
						postType
					);
					if (response.success && response.post_id) {
						createdCount++;
						this.processedNewFolders.add(absPath);
						this.debugLogger.log(
							`   ✅ Created ${postType} "${response.title}" (ID: ${response.post_id})`
						);
					} else {
						this.debugLogger.log(`   ⚠️ Could not create: ${response.error}`);
					}
				} catch (error: any) {
					this.debugLogger.log(`   ❌ Error creating post: ${error.message}`);
				}
			}

			if (foundCount === 0) {
				this.debugLogger.log(`   ✅ No unlinked folders in ${rootLabel}`);
			} else {
				this.debugLogger.log(
					`🔍 Scan ${rootLabel}: ${createdCount}/${foundCount} posts created`
				);
			}
		} catch (error: any) {
			this.debugLogger.log(`❌ Scan error in ${rootLabel}: ${error.message}`);
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
				this.debugLogger.log(
					"⚠️ Could not get theme path, bi-directional sync disabled"
				);
				return;
			}

			this.debugLogger.log(
				`👀 Starting theme watcher for bi-directional sync: ${this.themePath}`
			);

			// Watch ALL theme files for bi-directional sync (dynamic)
			this.themeWatcher = chokidar.watch(this.themePath, {
				ignored: [
					/(^|[\/\\])\../, // Ignore dotfiles
					"**/node_modules/**",
					"**/.git/**",
					"**/.vscode/**",
					"**/.cursor/**",
				],
				ignoreInitial: true,
				persistent: true,
				depth: 10, // Watch deeply nested folders
				awaitWriteFinish: {
					stabilityThreshold: 300,
					pollInterval: 100,
				},
			});

			// Listen for theme file changes
			this.themeWatcher.on("change", (filePath) => {
				this.handleThemeAssetChange(filePath);
			});

			// Listen for new theme files
			this.themeWatcher.on("add", (filePath) => {
				this.handleThemeAssetChange(filePath);
			});

			this.themeWatcher.on("error", (error) => {
				this.debugLogger.log(`❌ Theme watcher error: ${error.message}`);
			});

			this.debugLogger.log(
				"✅ Theme watcher started (bi-directional sync enabled)"
			);
		} catch (error: any) {
			this.debugLogger.log(
				`⚠️ Could not start theme watcher: ${error.message}`
			);
			this.debugLogger.log("   Bi-directional sync will be disabled");
		}
	}

	/**
	 * Handle any theme file change - sync back to dev folder (dynamic)
	 */
	private async handleThemeAssetChange(filePath: string) {
		const fileName = path.basename(filePath);
		const normalizedPath = filePath.replace(/\\/g, "/");
		const themePathNormalized = this.themePath?.replace(/\\/g, "/") || "";

		// Get relative path from theme folder
		const relativePath = themePathNormalized
			? normalizedPath.replace(themePathNormalized + "/", "")
			: fileName;

		// Check cooldown - don't sync if we just synced TO theme (prevent circular sync)
		const now = Date.now();
		const lastSync = this.lastThemeSyncTime.get(normalizedPath) || 0;
		const timeSinceLastSync = now - lastSync;

		if (timeSinceLastSync < this.themeSyncCooldownMs) {
			this.debugLogger.log(
				`⏸️ Skipping theme→dev sync (cooldown: ${Math.round(
					(this.themeSyncCooldownMs - timeSinceLastSync) / 1000
				)}s remaining)`
			);
			return;
		}

		// Determine file type for logging
	let fileType = "file";
	if (relativePath.startsWith("acf-json/")) fileType = "ACF JSON";
	else if (relativePath.startsWith("taxonomies/")) fileType = "taxonomy JSON";
	else if (relativePath.startsWith("assets/css/")) fileType = "CSS";
		else if (relativePath.startsWith("assets/js/")) fileType = "JS";
		else if (relativePath.startsWith("assets/")) fileType = "asset";
		else if (relativePath.startsWith("includes/")) fileType = "PHP include";
		else if (relativePath.startsWith("templates/")) fileType = "template";
		else if (relativePath.startsWith("parts/")) fileType = "template part";
		else if (relativePath.startsWith("patterns/")) fileType = "pattern";
		else if (fileName === "theme.json") fileType = "theme config";
		else if (fileName === "style.css") fileType = "theme stylesheet";
		else if (fileName === "functions.php") fileType = "theme functions";

		this.debugLogger.log(
			`🔄 Theme ${fileType} changed: ${relativePath}, syncing to dev folder...`
		);

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
			this.lastThemeSyncTime.set(filePath.replace(/\\/g, "/"), Date.now());

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
	private handlePotentialTrashAction(
		dirPath: string,
		eventType: "add" | "unlink"
	) {
		// Normalize path separators for cross-platform compatibility
		const normalizedPath = dirPath.replace(/\\/g, "/");

		this.debugLogger.log(
			`🔍 [Handle Trash] Processing ${eventType} for: ${normalizedPath}`
		);

		const folderName = path.basename(normalizedPath);

		// Resolve post ID: try _ID suffix first, then metadata cache
		let postId: number | null = null;
		const postIdMatch = folderName.match(/_(\d+)$/);
		if (postIdMatch) {
			postId = parseInt(postIdMatch[1], 10);
		} else {
			for (const [pid, meta] of this.metadataCache.entries()) {
				if (meta.slug === folderName) {
					postId = pid;
					break;
				}
			}
		}

		if (!postId) {
			this.debugLogger.log(
				`🔍 [Handle Trash] Skipping - cannot resolve post ID for: ${folderName}`
			);
			return;
		}

		this.debugLogger.log(`🔍 [Handle Trash] Found Post ID: ${postId}`);

		// Check if this folder is inside a _trash directory
		const isInTrash = normalizedPath.includes("/_trash/");
		this.debugLogger.log(
			`🔍 [Handle Trash] Is in trash: ${isInTrash}, Event type: ${eventType}`
		);

		// Handle DELETE events - track for rename detection
		if (eventType === "unlink" && !isInTrash) {
			// Folder deleted outside trash
			// This could be: (1) start of rename, (2) completion of rename (DELETE after CREATE)

			// Check if there's a pending restore for this post - if so, it was a rename!
			const pendingRestore = this.pendingRestoreTimers.get(postId);
			if (pendingRestore) {
				clearTimeout(pendingRestore);
				this.pendingRestoreTimers.delete(postId);
				this.debugLogger.log(
					`🔄 [Handle Trash] RENAME detected (CREATE→DELETE): cancelled pending restore for post ${postId}`
				);
				this.debugLogger.log(
					`🔄 [Handle Trash] Skipping API call - WordPress initiated this rename`
				);
				return;
			}

			// Track this delete in case CREATE comes later
			this.recentFolderDeletes.set(postId, {
				path: normalizedPath,
				timestamp: Date.now(),
			});
			this.debugLogger.log(
				`🔍 [Handle Trash] Tracking potential rename (DELETE first) for post ${postId}`
			);

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
		let action: "trash" | "restore" | null = null;

		if (eventType === "add" && isInTrash) {
			// Folder appeared IN _trash → it was TRASHED
			action = "trash";
			this.debugLogger.log(
				`🗑️ Detected folder moved TO trash: ${folderName} (Post ID: ${postId})`
			);
		} else if (eventType === "unlink" && isInTrash) {
			// Folder disappeared FROM _trash → it was RESTORED
			action = "restore";
			this.debugLogger.log(
				`♻️ Detected folder moved FROM trash: ${folderName} (Post ID: ${postId})`
			);
		} else if (
			eventType === "add" &&
			!isInTrash &&
			(normalizedPath.includes("/post-types/") ||
				normalizedPath.includes("/templates/") ||
				normalizedPath.includes("/parts/") ||
				normalizedPath.includes("/patterns/"))
		) {
			// Folder appeared OUTSIDE _trash in post-types
			// Check if this is a rename (DELETE came first)
			const recentDelete = this.recentFolderDeletes.get(postId);
			if (recentDelete && Date.now() - recentDelete.timestamp < 3000) {
				// DELETE came first → this is a rename (DELETE→CREATE)
				this.debugLogger.log(
					`🔄 [Handle Trash] RENAME detected (DELETE→CREATE): ${path.basename(
						recentDelete.path
					)} → ${folderName}`
				);
				this.debugLogger.log(
					`🔄 [Handle Trash] Skipping API call - WordPress initiated this rename`
				);
				this.recentFolderDeletes.delete(postId);
				return;
			}

			// No recent delete - might be restore, but wait to see if DELETE follows
			this.debugLogger.log(
				`🔍 [Handle Trash] Folder appeared outside trash - waiting to detect rename pattern...`
			);

			// Schedule a delayed restore (can be cancelled if DELETE arrives)
			const existingTimer = this.pendingRestoreTimers.get(postId);
			if (existingTimer) {
				clearTimeout(existingTimer);
			}

			const timer = setTimeout(() => {
				this.pendingRestoreTimers.delete(postId);

				this.debugLogger.log(
					`♻️ Detected restore (no DELETE followed): ${folderName} (Post ID: ${postId})`
				);
				this.debounceFolderAction(postId, "restore");
			}, 1000); // Wait 1 second for potential DELETE event

			this.pendingRestoreTimers.set(postId, timer);
			return; // Don't process immediately - wait for potential rename detection
		} else {
			this.debugLogger.log(
				`🔍 [Handle Trash] No action determined (eventType=${eventType}, isInTrash=${isInTrash})`
			);
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
	private async debounceFolderAction(
		postId: number,
		action: "trash" | "restore"
	) {
		const key = `${postId}-${action}`;

		// Check cooldown - don't process if we just processed this post
		const now = Date.now();
		const lastActionTime = this.lastFolderActionTime.get(postId) || 0;
		const timeSinceLastAction = now - lastActionTime;

		if (timeSinceLastAction < this.folderActionCooldownMs) {
			this.debugLogger.log(
				`⏸️ Skipping folder action (cooldown: ${Math.round(
					(this.folderActionCooldownMs - timeSinceLastAction) / 1000
				)}s remaining)`
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
				const actionVerb = action === "trash" ? "trash" : "restore";
				const choice = await vscode.window.showWarningMessage(
					`⚠️ Bulk Operation Detected\n\n${pendingActions} folders will be ${actionVerb}ed in WordPress.\n\nContinue?`,
					{ modal: true },
					"Yes, Continue",
					"Cancel All"
				);

				if (choice !== "Yes, Continue") {
					// Cancel all pending actions
					this.debugLogger.log(
						`❌ User cancelled bulk ${action} operation (${pendingActions} pending)`
					);
					this.folderActionTimers.forEach((t) => clearTimeout(t));
					this.folderActionTimers.clear();
					return;
				}

				this.debugLogger.log(
					`✅ User confirmed bulk ${action} operation (${pendingActions} folders)`
				);
			}

			await this.executeFolderAction(postId, action);
		}, this.folderActionDebounceMs);

		this.folderActionTimers.set(key, timer);
	}

	/**
	 * Execute folder action (trash/restore) after debounce
	 */
	private async executeFolderAction(
		postId: number,
		action: "trash" | "restore"
	) {
		try {
			this.debugLogger.log(`📤 Sending ${action} action for post ${postId}...`);

			// Send folder action to WordPress
			const response = await this.restClient.sendFolderAction(postId, action);

			// Record action time AFTER successful action
			this.lastFolderActionTime.set(postId, Date.now());

			if (response.success) {
				const actionVerb = action === "trash" ? "trashed" : "restored";
				this.debugLogger.log(`✅ Post ${postId} ${actionVerb} successfully`);

				// Show notification
				const config = vscode.workspace.getConfiguration("skylit");
				if (config.get<boolean>("showNotifications", true)) {
					vscode.window.showInformationMessage(
						`✅ Post ${postId} ${actionVerb} in WordPress`
					);
				}
			}
		} catch (error: any) {
			this.debugLogger.log(`❌ Folder action error: ${error.message}`);
			vscode.window.showErrorMessage(
				`Failed to ${action} post ${postId}: ${error.message}`
			);
		}
	}

	/**
	 * Handle any theme file change (dynamic - syncs to theme folder)
	 * This handles all files except post-types/ which is handled by Gutenberg sync
	 */
	private async handleThemeFileChange(filePath: string) {
		const fileName = path.basename(filePath);
		// Normalize BOTH paths to forward slashes for comparison
		const normalizedPath = filePath.replace(/\\/g, "/");
		const devFolderNormalized = this.devFolder.replace(/\\/g, "/");

		// Get relative path from dev folder - ensure devFolder ends with /
		const devFolderWithSlash = devFolderNormalized.endsWith("/")
			? devFolderNormalized
			: devFolderNormalized + "/";

		let relativePath = normalizedPath;
		if (normalizedPath.startsWith(devFolderWithSlash)) {
			relativePath = normalizedPath.substring(devFolderWithSlash.length);
		}

	const isAcfJson = relativePath.startsWith("acf-json/");
	const isTaxonomyJson = relativePath.startsWith("taxonomies/") && relativePath.endsWith(".json");
	const isContentPostType =
			relativePath.startsWith("templates/") ||
			relativePath.startsWith("parts/") ||
			relativePath.startsWith("patterns/");
		const isAssetOrInclude =
			relativePath.startsWith("assets/") ||
			relativePath.startsWith("includes/") ||
			relativePath.startsWith("theme/") ||
			relativePath === "theme.json" ||
			relativePath === "style.css" ||
			relativePath === "functions.php" ||
			isContentPostType;

		// Same-machine mode: templates, parts, patterns are WordPress post types.
		// Route their file changes through the normal syncFile() flow so they get
		// imported into WordPress via import-instant — same as pages/posts.
		// (In remote mode these files are pushed to the server via pushFileToServer below.)
		if (!this.remoteMode && isContentPostType) {
			this.handleFileChange(filePath);
			return;
		}

	// Remote mode: push ALL theme-related files to server
	if (this.remoteMode && (isAssetOrInclude || isAcfJson || isTaxonomyJson)) {
		const now = Date.now();
		const lastSync = this.lastSyncTime.get(normalizedPath) || 0;
		if (now - lastSync < this.syncCooldownMs) return;

		this.statusBar.showSyncing(fileName);
		const pushed = await this.pushFileToServer(filePath);
		if (pushed) {
			this.statusBar.showSuccess(`${fileName} pushed to server`);
			this.debugLogger.log(`✅ ${fileName} pushed to server`);
		}
		this.lastSyncTime.set(normalizedPath, Date.now());
		return;
	}

	if (!isAcfJson && !isTaxonomyJson) {
		return;
	}

	// ── Taxonomy JSON path ──────────────────────────────────────────────────
	// Use a shared batch debounce — many taxonomy files may change at once
	if (isTaxonomyJson) {
		// Guard: skip re-fires caused by the plugin writing taxonomy JSON back to disk
		// after we just synced it to WP (same-machine mode feedback loop prevention).
		const taxFileCooldown = this.lastThemeSyncTime.get(normalizedPath) || 0;
		if (Date.now() - taxFileCooldown < this.acfSyncCooldownMs) {
			this.debugLogger.log(
				`⏸️ [Taxonomy] Skipping re-fire (cooldown): ${relativePath}`
			);
			return;
		}

		if (this.taxonomyJsonBatchTimer) {
			clearTimeout(this.taxonomyJsonBatchTimer);
		}
		this.taxonomyJsonBatchTimer = setTimeout(async () => {
			this.taxonomyJsonBatchTimer = null;
			const now = Date.now();
			// Check cooldown against a generic taxonomy key
			const lastSync = this.lastSyncTime.get("__taxonomy_batch__") || 0;
			if (now - lastSync < this.syncCooldownMs) return;

			try {
				this.debugLogger.log(`🗂️ Taxonomy JSON batch sync to WP DB...`);
				this.statusBar.showSyncing("taxonomy");

				const taxResponse = await this.restClient.syncTaxonomyJsonToWp();

				const taxBatchStamp = Date.now();
				this.lastSyncTime.set("__taxonomy_batch__", taxBatchStamp);

				// Stamp every taxonomy JSON file so re-fires from the plugin writing them
				// back (same-machine mode) are suppressed for acfSyncCooldownMs.
				try {
					const taxDir = posixJoin(this.devFolder, "taxonomies");
					const taxEntries = await vscode.workspace.fs.readDirectory(
						vscode.Uri.file(taxDir)
					);
					for (const [name] of taxEntries) {
						if (!name.endsWith(".json")) continue;
						const fullPath = posixJoin(taxDir, name);
						this.lastThemeSyncTime.set(fullPath, taxBatchStamp);
					}
				} catch {
					// taxonomies/ may not exist — safe to ignore
				}

				if (taxResponse.success) {
					this.statusBar.showSuccess(`Taxonomy synced`);
					this.debugLogger.log(`✅ Taxonomy JSON imported to WP DB`);

					const config = vscode.workspace.getConfiguration("skylit");
					if (config.get<boolean>("showNotifications", true)) {
						vscode.window.showInformationMessage(
							`✅ Taxonomy terms synced to WordPress`
						);
					}
				}
			} catch (error: any) {
				this.debugLogger.log(`❌ Taxonomy JSON sync error: ${error.message}`);
				vscode.window.showErrorMessage(`Taxonomy sync failed: ${error.message}`);
			}
		}, this.acfJsonBatchDebounceMs);
		return;
	}

	// ── ACF JSON path ───────────────────────────────────────────────────────
	// Guard: skip if this specific file was just written by our own sync
	// (prevents the loop where ACF's save hooks re-write files we just imported)
	const acfFileCooldown = this.lastThemeSyncTime.get(normalizedPath) || 0;
	if (Date.now() - acfFileCooldown < this.acfSyncCooldownMs) {
		this.debugLogger.log(
			`⏸️ [ACF] Skipping re-fire (cooldown): ${relativePath}`
		);
		return;
	}

	// Use a shared batch debounce — ACF writes many files simultaneously
	if (this.acfJsonBatchTimer) {
		clearTimeout(this.acfJsonBatchTimer);
	}
	this.acfJsonBatchTimer = setTimeout(async () => {
		this.acfJsonBatchTimer = null;
		const now = Date.now();
		const lastSync = this.lastSyncTime.get("__acf_batch__") || 0;
		if (now - lastSync < this.syncCooldownMs) return;

		this.debugLogger.log(`📦 ACF JSON batch sync to theme...`);

	try {
		this.statusBar.showSyncing("acf-json");

		if (this.remoteMode) {
			const pushed = await this.pushFileToServer(filePath);
			if (pushed) {
				this.statusBar.showSuccess(`acf-json pushed to server`);
				this.debugLogger.log(`✅ ACF JSON pushed to server theme & DB`);
			}
			this.lastSyncTime.set("__acf_batch__", Date.now());
			return;
		}

		const acfResponse = await this.restClient.syncAcfJsonToTheme();

		const acfBatchStamp = Date.now();
		this.lastSyncTime.set("__acf_batch__", acfBatchStamp);

		// Stamp every acf-json file in the dev folder so re-fires from ACF's
		// own save hooks (acf/update_field_group etc.) are suppressed for
		// acfSyncCooldownMs (10s) — enough for slow hosts like Hostinger.
		try {
			const acfDir = posixJoin(this.devFolder, "acf-json");
			const acfEntries = await vscode.workspace.fs.readDirectory(
				vscode.Uri.file(acfDir)
			);
			for (const [name] of acfEntries) {
				if (!name.endsWith(".json")) continue;
				const fullPath = posixJoin(acfDir, name);
				this.lastThemeSyncTime.set(fullPath, acfBatchStamp);
			}
		} catch {
			// acf-json/ may not exist yet — safe to ignore
		}

		if (acfResponse.success) {
			this.statusBar.showSuccess(`acf-json synced + imported`);
			this.debugLogger.log(`✅ ACF JSON synced to theme & imported to DB`);

			const config = vscode.workspace.getConfiguration("skylit");
			if (config.get<boolean>("showNotifications", true)) {
				vscode.window.showInformationMessage(
					`✅ ACF JSON synced to theme & imported to ACF`
				);
			}

		if (this.aiSkillsetGenerator) {
				this.aiSkillsetGenerator.generate().catch((err: any) => {
					this.debugLogger.warn(`📚 Skillset regen after ACF sync failed: ${err.message}`);
				});
			}
		}
	} catch (error: any) {
		this.debugLogger.log(`❌ Theme sync error: ${error.message}`);
		vscode.window.showErrorMessage(`Sync failed: ${error.message}`);
	}
	}, this.acfJsonBatchDebounceMs);
}

	/**
	 * Enqueue a sync task so import-instant calls are serialized.
	 * Prevents concurrent PHP requests from crashing on shared hosting.
	 */
	private enqueueImport(task: () => Promise<void>): void {
		this.importQueue.push(task);
		if (!this.importQueueRunning) {
			this.drainImportQueue();
		}
	}

	private async drainImportQueue(): Promise<void> {
		if (this.importQueueRunning) return;
		this.importQueueRunning = true;
		let first = true;
		while (this.importQueue.length > 0) {
			// Wait between requests (except before the very first one) so the
			// PHP-FPM worker on shared hosting has time to free memory.
			if (!first) {
				await new Promise<void>((r) =>
					setTimeout(r, this.importQueueIntervalMs)
				);
			}
			first = false;
			const task = this.importQueue.shift()!;
			try {
				await task();
			} catch {
				// individual task errors are handled inside each task
			}
		}
		this.importQueueRunning = false;
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
		const normalizedPath = filePath.replace(/\\/g, "/");
		const isCss = normalizedPath.includes("/assets/css/");
		const isJs = normalizedPath.includes("/assets/js/");

		const now = Date.now();
		const lastSync = this.lastSyncTime.get(normalizedPath) || 0;
		const timeSinceLastSync = now - lastSync;

		if (timeSinceLastSync < this.syncCooldownMs) {
			this.debugLogger.log(
				`⏸️ Skipping dev→theme sync (cooldown: ${Math.round(
					(this.syncCooldownMs - timeSinceLastSync) / 1000
				)}s remaining)`
			);
			return;
		}

		const assetType = isCss ? "CSS" : isJs ? "JS" : "asset";
		this.debugLogger.log(
			`📦 ${assetType} asset changed: ${fileName}, syncing to theme + DB...`
		);

		try {
			this.statusBar.showSyncing(fileName);

			const types = isCss ? ["css"] : isJs ? ["js"] : ["js", "css"];
			let dbResult: { success: boolean; updated: Record<string, number>; total: number; message: string } | null = null;

			if (this.remoteMode) {
				const pushed = await this.pushFileToServer(filePath);
				if (pushed) {
					this.debugLogger.log(`✅ ${fileName} pushed to server theme`);
				}
				const fs = await import("fs");
				const content = fs.readFileSync(filePath, "utf-8");
				const devFolderNorm = this.devFolder.replace(/\\/g, "/").replace(/\/$/, "/");
				const relPath = normalizedPath.replace(devFolderNorm, "");
				dbResult = await this.restClient.importGlobalAssets(types, { [relPath]: content });
			} else {
				await this.restClient.syncAssetsToTheme();
				dbResult = await this.restClient.importGlobalAssets(types);
			}

			// Build a descriptive notification message based on actual source mode
			const dbUpdated = dbResult?.total ?? 0;
			const sourceMode = isCss ? this.assetSourceModes.css : this.assetSourceModes.js;
			const isDbMode = sourceMode === "database";

			let destinations: string[];
			let toastMsg: string;

			if (isDbMode) {
				destinations = dbUpdated > 0 ? ["theme", "database"] : ["theme"];
				toastMsg = dbUpdated > 0
					? `✅ ${fileName} saved to theme + database`
					: `✅ ${fileName} saved to theme (database already up to date)`;
			} else {
				destinations = ["theme"];
				toastMsg = `✅ ${fileName} saved to theme`;
			}

			const statusMsg = `${fileName} → ${destinations.join(" + ")}`;
			this.statusBar.showSuccess(statusMsg, 3000);
			vscode.window.showInformationMessage(toastMsg);
			this.debugLogger.log(`✅ ${fileName} synced → ${destinations.join(" + ")}`);

			this.lastSyncTime.set(normalizedPath, Date.now());

			if (this.themePath) {
				const themeFilePath = normalizedPath.replace(
					this.devFolder.replace(/\\/g, "/"),
					this.themePath.replace(/\\/g, "/")
				);
				this.lastThemeSyncTime.set(themeFilePath, Date.now());
			}
		} catch (error: any) {
			this.debugLogger.log(`❌ Asset sync error: ${error.message}`);
			vscode.window.showErrorMessage(`❌ Failed to sync ${fileName}: ${error.message}`);
		}
	}

	/**
	 * Handle PHP include file change (in /includes folder)
	 * Syncs PHP files from dev folder to theme
	 */
	private async handleIncludeChange(filePath: string) {
		const fileName = path.basename(filePath);
		const normalizedPath = filePath.replace(/\\/g, "/");

		const now = Date.now();
		const lastSync = this.lastSyncTime.get(normalizedPath) || 0;
		const timeSinceLastSync = now - lastSync;

		if (timeSinceLastSync < this.syncCooldownMs) {
			this.debugLogger.log(
				`⏸️ Skipping dev→theme PHP sync (cooldown: ${Math.round(
					(this.syncCooldownMs - timeSinceLastSync) / 1000
				)}s remaining)`
			);
			return;
		}

		this.debugLogger.log(
			`📄 PHP include changed: ${fileName}, syncing to theme + DB...`
		);

		try {
			this.statusBar.showSyncing(fileName);

			let dbResult: { success: boolean; updated: Record<string, number>; total: number; message: string } | null = null;

			if (this.remoteMode) {
				const pushed = await this.pushFileToServer(filePath);
				if (pushed) {
					this.debugLogger.log(`✅ ${fileName} pushed to server theme`);
				}
				const fs = await import("fs");
				const content = fs.readFileSync(filePath, "utf-8");
				const devFolderNorm = this.devFolder.replace(/\\/g, "/").replace(/\/$/, "/");
				const relPath = normalizedPath.replace(devFolderNorm, "");
				dbResult = await this.restClient.importGlobalAssets(["php"], { [relPath]: content });
			} else {
				await this.restClient.syncAssetsToTheme();
				dbResult = await this.restClient.importGlobalAssets(["php"]);
			}

			const dbUpdated = dbResult?.total ?? 0;
			const isDbMode = this.assetSourceModes.php === "database";

			let destinations: string[];
			let toastMsg: string;

			if (isDbMode) {
				destinations = dbUpdated > 0 ? ["theme", "database"] : ["theme"];
				toastMsg = dbUpdated > 0
					? `✅ ${fileName} saved to theme + database`
					: `✅ ${fileName} saved to theme (database already up to date)`;
			} else {
				destinations = ["theme"];
				toastMsg = `✅ ${fileName} saved to theme`;
			}

			const statusMsg = `${fileName} → ${destinations.join(" + ")}`;
			this.statusBar.showSuccess(statusMsg, 3000);
			vscode.window.showInformationMessage(toastMsg);
			this.debugLogger.log(`✅ ${fileName} synced → ${destinations.join(" + ")}`);

			this.lastSyncTime.set(normalizedPath, Date.now());

			if (this.themePath) {
				const themeFilePath = normalizedPath.replace(
					this.devFolder.replace(/\\/g, "/"),
					this.themePath.replace(/\\/g, "/")
				);
				this.lastThemeSyncTime.set(themeFilePath, Date.now());
			}
		} catch (error: any) {
			this.debugLogger.log(`❌ PHP sync error: ${error.message}`);
			vscode.window.showErrorMessage(`❌ Failed to sync ${fileName}: ${error.message}`);
		}
	}

	/**
	 * Read a local file and push it to the server theme via REST API.
	 * Returns the relative path that was pushed, or null on failure.
	 */
	private async pushFileToServer(filePath: string): Promise<string | null> {
		const normalizedPath = filePath.replace(/\\/g, "/");
		const devFolderNormalized = this.devFolder
			.replace(/\\/g, "/")
			.replace(/\/$/, "");

		const relativePath = normalizedPath.startsWith(devFolderNormalized + "/")
			? normalizedPath.substring(devFolderNormalized.length + 1)
			: path.basename(normalizedPath);

		try {
			const isBinary =
				/\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|eot|otf)$/i.test(filePath);
			let content: string;
			let encoding: string | undefined;

			if (isBinary) {
				content = fs.readFileSync(filePath).toString("base64");
				encoding = "base64";
			} else {
				content = fs.readFileSync(filePath, "utf-8");
			}

			const result = await this.restClient.pushFiles([
				{ path: relativePath, content, encoding },
			]);

			if (!result.success) {
				const failedPaths = (result.errors || [])
					.map((e: { path: string; error: string }) => e.error)
					.join("; ");
				this.debugLogger.log(
					`⚠️ Push wrote ${result.count} file(s) but had errors: ${failedPaths}`
				);
			}

			return relativePath;
		} catch (error: any) {
			this.debugLogger.log(
				`❌ Failed to push ${relativePath}: ${error.message}`
			);
			return null;
		}
	}

	/**
	 * Check if file is a root theme file (style.css, functions.php at dev folder root)
	 */
	private isRootThemeFile(
		normalizedPath: string,
		devFolderNormalized: string
	): boolean {
		const rootFiles = ["style.css", "functions.php"];

		for (const rootFile of rootFiles) {
			const expectedPath = `${devFolderNormalized}/${rootFile}`;
			if (
				normalizedPath === expectedPath ||
				(normalizedPath.endsWith(`/${rootFile}`) &&
					!normalizedPath.includes("/assets/") &&
					!normalizedPath.includes("/post-types/") &&
					!normalizedPath.includes("/templates/") &&
					!normalizedPath.includes("/parts/") &&
					!normalizedPath.includes("/patterns/"))
			) {
				// Make sure it's at the root level (no subdirectories except the dev folder itself)
				const relativePath = normalizedPath.replace(
					devFolderNormalized + "/",
					""
				);
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
		const normalizedPath = filePath.replace(/\\/g, "/");

		// Check cooldown
		const now = Date.now();
		const lastSync = this.lastSyncTime.get(normalizedPath) || 0;
		const timeSinceLastSync = now - lastSync;

		if (timeSinceLastSync < this.syncCooldownMs) {
			this.debugLogger.log(
				`⏸️ Skipping theme structure sync (cooldown: ${Math.round(
					(this.syncCooldownMs - timeSinceLastSync) / 1000
				)}s remaining)`
			);
			return;
		}

		// Determine file type for logging
		let fileType = "theme file";
		if (normalizedPath.includes("/templates/")) {
			fileType = "template";
		} else if (normalizedPath.includes("/parts/")) {
			fileType = "template part";
		} else if (normalizedPath.includes("/patterns/")) {
			fileType = "pattern";
		} else if (fileName === "style.css") {
			fileType = "theme stylesheet";
		} else if (fileName === "functions.php") {
			fileType = "theme functions";
		}

		this.debugLogger.log(
			`🎨 ${fileType} changed: ${fileName}, syncing to theme...`
		);

		try {
			this.statusBar.showSyncing(fileName);

			// Sync all theme structure to theme
			const response = await this.restClient.syncAssetsToTheme();

			// Record sync time
			this.lastSyncTime.set(normalizedPath, Date.now());

			// Mark corresponding theme file
			if (this.themePath) {
				const themeFilePath = normalizedPath.replace(
					this.devFolder.replace(/\\/g, "/"),
					this.themePath.replace(/\\/g, "/")
				);
				this.lastThemeSyncTime.set(themeFilePath, Date.now());
			}

			if (response.success) {
				this.statusBar.showSuccess(`${fileName} → theme`, 3000);
				this.debugLogger.log(`✅ ${fileName} synced to active theme`);
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
		const profileEnd = this.debugLogger.profileStart("syncFile");
		try {
			const normPath = filePath.replace(/\\/g, "/");
			this.debugLogger.info(
				`🔄 [syncFile] Starting sync for: ${path.basename(normPath)}`
			);
			if (this.pathsWrittenDuringStartup.has(normPath)) {
				this.debugLogger.info(
					`⏭️ [syncFile] SKIP: file written during startup (pathsWrittenDuringStartup has ${this.pathsWrittenDuringStartup.size} entries)`
				);
				profileEnd("skip: written during startup");
				return;
			}

			// Check cooldown - don't sync if we just synced this file
			const now = Date.now();
			const lastSync = this.lastSyncTime.get(filePath) || 0;
			const timeSinceLastSync = now - lastSync;

			if (timeSinceLastSync < this.syncCooldownMs) {
				this.debugLogger.info(
					`⏸️ [syncFile] SKIP: cooldown (${Math.round(
						(this.syncCooldownMs - timeSinceLastSync) / 1000
					)}s remaining)`
				);
				profileEnd("skip: cooldown");
				return;
			}

			// Extract post info from file path
			const postInfo = await this.extractPostInfo(filePath);
			if (!postInfo) {
				this.debugLogger.info(`⚠️ [syncFile] SKIP: Cannot extract post info from: ${normPath}`);
				profileEnd("skip: no post info");
				return;
			}

			const { postId, postFolder } = postInfo;
			const fileName = path.basename(filePath);
			this.debugLogger.info(
				`🔄 [syncFile] Resolved post ${postId} from folder: ${path.basename(postFolder)}`
			);

			// Check if this file change was caused by the extension itself
			// (canonical HTML writeback, startup sync, etc.) — skip only those.
			// User-initiated IDE saves always proceed to import-instant.
			const selfWriteTs = this.selfWrittenPaths.get(normPath);
			if (selfWriteTs && Date.now() - selfWriteTs < 2000) {
				this.debugLogger.info(
					`⏭️ [syncFile] SKIP: file was written by extension ${Date.now() - selfWriteTs}ms ago`
				);
				await this.restoreFoldingForUnchangedBlocks(filePath, postId);
				profileEnd("skip: self-written file");
				return;
			}

			// Save folding state BEFORE syncing (in case WordPress exports back)
			await this.foldingManager.saveFoldingState(filePath);

			// Show syncing status
			this.statusBar.showSyncing(fileName);

			// Read HTML and CSS files
			const htmlPath = posixJoin(
				postFolder,
				`${path.basename(postFolder)}.html`
			);
			const cssPath = posixJoin(postFolder, `${path.basename(postFolder)}.css`);

			let html = "";
			let css = "";

			// Use VS Code FS API for SSH compatibility
			if (await vsExists(htmlPath)) {
				html = await vsReadFile(htmlPath);
			}

			if (await vsExists(cssPath)) {
				css = await vsReadFile(cssPath);
			}

			// Check for metadata changes in HTML comment (slug, title, status)
			// This enables bidirectional sync: editing metadata in HTML updates WordPress
			if (html) {
				const metadataChanged = await this.checkAndSyncHtmlMetadata(
					postId,
					html,
					postFolder
				);
				if (metadataChanged) {
					this.debugLogger.info(
						`📝 [syncFile] SKIP: metadata changed — will re-sync after rename`
					);
					profileEnd("skip: metadata changed");
					return;
				}
			}

	this.debugLogger.info(
		`📋 [syncFile] Queued import-instant for post ${postId} (html=${html.length} bytes, css=${css.length} bytes)`
	);

	// Serialize all import-instant calls through the queue so shared hosting
	// (Hostinger, etc.) doesn't 500 from concurrent PHP requests.
	let response!: Awaited<ReturnType<typeof this.restClient.syncFile>>;
	await new Promise<void>((resolve, reject) => {
		this.enqueueImport(async () => {
			// Log at the moment the API call actually fires (after queue wait),
			// not when the file was read — makes the Output panel timestamps accurate.
			this.debugLogger.info(
				`📤 [syncFile] Calling import-instant API for post ${postId} (html=${html.length} bytes, css=${css.length} bytes)...`
			);
			// Retry up to 3 times on server errors (500/502/503) — shared hosting
			// can transiently fail under memory pressure; a short wait usually clears it.
			const maxRetries = 3;
			const retryDelayMs = 5000;
			let lastErr: any;
			for (let attempt = 1; attempt <= maxRetries; attempt++) {
				try {
					response = await this.restClient.syncFile(postId, html, css);
					resolve();
					return;
				} catch (err: any) {
					lastErr = err;
					const status = err?.response?.status ?? 0;
					const isServerError = status >= 500 && status < 600;
					const isNetworkError = !status && (
						err?.code === 'ECONNRESET' ||
						err?.code === 'ETIMEDOUT' ||
						err?.message?.includes('network')
					);
					if ((isServerError || isNetworkError) && attempt < maxRetries) {
						this.debugLogger.info(
							`⚠️ [syncFile] HTTP ${status || 'network'} error — retrying in ${retryDelayMs / 1000}s (attempt ${attempt}/${maxRetries})...`
						);
						await new Promise<void>((r) => setTimeout(r, retryDelayMs));
					} else {
						break;
					}
				}
			}
			reject(lastErr);
		});
	});

			// Record sync time AFTER successful sync
			this.lastSyncTime.set(filePath, Date.now());

			this.debugLogger.info(
				`📥 [syncFile] Response: success=${response.success}, blocks_updated=${
					response.blocks_updated
				}, content_changed=${(response as any).content_changed}`
			);

			profileEnd(`post ${postId} success=${response.success}`);

			if (response.success) {
				const bCount = response.blocks_updated ?? 0;
				this.statusBar.showSuccess(
					bCount > 0 ? `${fileName} — ${bCount} block${bCount !== 1 ? "s" : ""} updated` : `${fileName} synced`,
					3000
				);

				// Write canonical HTML (with metadata header) back to disk
				// This ensures the file has the metadata comment header for post ID resolution
				const canonical = (response as any).canonical_html;
				if (canonical && typeof canonical === "string") {
					const norm = filePath.replace(/\\/g, "/");
					const htmlPath = norm.endsWith(".html")
						? norm
						: norm.replace(/\.css$/, ".html");
					try {
						const existing = await vsReadFile(htmlPath);
						if (existing !== canonical) {
							// Save cursor position before the write so we can restore it
							let savedLine: number | null = null;
							for (const ed of vscode.window.visibleTextEditors) {
								if (ed.document.uri.fsPath.replace(/\\/g, "/") === htmlPath) {
									savedLine = ed.selection.active.line;
									break;
								}
							}

							this.lastSyncTime.set(htmlPath, Date.now());
							this.selfWrittenPaths.set(htmlPath, Date.now());
							await vsWriteFile(htmlPath, canonical);
							this.debugLogger.log(
								`📝 Wrote canonical HTML with metadata header: ${path.basename(
									htmlPath
								)}`
							);

							// Restore cursor after VS Code reloads the changed file
							if (savedLine !== null) {
								const restoreTo = savedLine;
								setTimeout(() => {
									for (const ed of vscode.window.visibleTextEditors) {
										if (ed.document.uri.fsPath.replace(/\\/g, "/") === htmlPath) {
											const maxLine = ed.document.lineCount - 1;
											const line = Math.min(restoreTo, maxLine);
											const pos = new vscode.Position(line, 0);
											ed.selection = new vscode.Selection(pos, pos);
											ed.revealRange(
												new vscode.Range(pos, pos),
												vscode.TextEditorRevealType.InCenterIfOutsideViewport
											);
											this.debugLogger.log(
												`🎯 Restored cursor to line ${line + 1} after canonical write`
											);
											break;
										}
									}
								}, 300);
							}
						}
					} catch {}
				}

				const canonicalCss = (response as any).canonical_css;
				if (canonicalCss && typeof canonicalCss === "string") {
					const cssPath = filePath
						.replace(/\\/g, "/")
						.replace(/\.html$/, ".css");
					try {
						const existing = await vsReadFile(cssPath);
						if (existing !== canonicalCss) {
							this.lastSyncTime.set(cssPath, Date.now());
							this.selfWrittenPaths.set(cssPath, Date.now());
							await vsWriteFile(cssPath, canonicalCss);
						}
					} catch {}
				}

				const config = vscode.workspace.getConfiguration("skylit");
				if (config.get<boolean>("showNotifications", true)) {
					const syncSummary = (response as any).sync_summary as string | undefined;
					const blocksUpdated = response.blocks_updated ?? 0;
					const contentChanged = (response as any).content_changed;
					let syncMsg: string;
					if (syncSummary) {
						syncMsg = `✅ ${fileName} — ${syncSummary}`;
					} else if (blocksUpdated > 0) {
						syncMsg = `✅ ${fileName} synced — ${blocksUpdated} block${blocksUpdated !== 1 ? "s" : ""} updated`;
					} else if (contentChanged === false) {
						syncMsg = `✅ ${fileName} synced — no changes`;
					} else {
						syncMsg = `✅ ${fileName} synced`;
					}
					vscode.window.showInformationMessage(syncMsg);
				}

				// After canonical HTML is written, format-on-save may reformat the
				// file, shifting line numbers. Delay then rescan metadata so cursor
				// sync stays accurate even after formatters run.
				const rescanPostId = postId;
				setTimeout(async () => {
					try {
						const rescan = await this.restClient.rescanLines(rescanPostId);
						if (rescan?.success && rescan.blocks) {
							this.liveBlockLines.set(rescanPostId, rescan.blocks.map(b => ({
								layoutBlockId: b.layoutBlockId,
								line: b.line,
								blockName: b.blockName,
							})));
							this.lastCursorBlockId = null;
							this.debugLogger.info(
								`📐 [Rescan] Updated ${rescan.count} block lines for post ${rescanPostId}`
							);
						}
					} catch (err: any) {
						this.debugLogger.log(
							`📐 [Rescan] Failed for post ${rescanPostId}: ${err.message}`
						);
					}
				}, 800);
			}
		} catch (error: any) {
			profileEnd(`error: ${error.message}`);
			this.debugLogger.info(`❌ [syncFile] ERROR: ${error.message}`);
			vscode.window.showErrorMessage(`Sync failed: ${error.message}`);
		}
	}

	/**
	 * Restore folding state for unchanged blocks after WordPress export
	 * Fetches block change info from API and restores folds for unchanged blocks
	 */
	private async restoreFoldingForUnchangedBlocks(
		filePath: string,
		postId: number
	): Promise<void> {
		try {
			// Give VS Code a moment to reload the file
			await new Promise((resolve) => setTimeout(resolve, 300));

			// Fetch block changes from WordPress
			const blockChanges = await this.restClient.getBlockChanges(postId);

			if (!blockChanges.success || !blockChanges.has_data) {
				this.debugLogger.log(
					"📂 No block change data available for folding restoration"
				);
				return;
			}

			const unchangedBlocks = blockChanges.unchanged_blocks || [];

			if (unchangedBlocks.length === 0) {
				this.debugLogger.log("📂 No unchanged blocks to restore folds for");
				return;
			}

			this.debugLogger.log(
				`📂 Block changes: ${blockChanges.blocks_changed} changed, ${blockChanges.blocks_unchanged} unchanged`
			);

			// If file was unchanged, all blocks keep their folding
			if (blockChanges.file_unchanged) {
				this.debugLogger.log("📂 File unchanged - all folding preserved");
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
	 * Extract post ID and folder path from a file path.
	 * Resolution order:
	 *   1. Legacy slug_ID folder name pattern
	 *   2. Metadata cache reverse lookup (slug → postId)
	 *   3. Parse Post ID from HTML metadata comment
	 */
	private async extractPostInfo(
		filePath: string
	): Promise<{ postId: number; postFolder: string } | null> {
		const normalizedPath = filePath.replace(/\\/g, "/");

		const hasExtension = /\.[a-zA-Z0-9]+$/.test(path.basename(normalizedPath));
		const folder = hasExtension ? path.dirname(normalizedPath) : normalizedPath;
		const folderName = path.basename(folder);

		// 1. Legacy: extract post ID from folder name (format: slug_ID)
		const match = folderName.match(/_(\d+)$/);
		if (match) {
			this.debugLogger.info(
				`🔍 [extractPostInfo] Resolved via legacy folder name: ${folderName} → post ${match[1]}`
			);
			return {
				postId: parseInt(match[1], 10),
				postFolder: folder.replace(/\\/g, "/"),
			};
		}

		// 2. Slug-only: reverse lookup in metadata cache
		for (const [postId, meta] of this.metadataCache.entries()) {
			if (meta.slug === folderName) {
				this.debugLogger.info(
					`🔍 [extractPostInfo] Resolved via metadata cache: slug="${folderName}" → post ${postId}`
				);
				return {
					postId,
					postFolder: folder.replace(/\\/g, "/"),
				};
			}
		}

		this.debugLogger.info(
			`🔍 [extractPostInfo] Metadata cache miss for slug="${folderName}" (cache has ${this.metadataCache.size} entries). Trying HTML header...`
		);

		// 3. Parse Post ID from the HTML metadata comment at top of file
		try {
			const htmlPath = posixJoin(folder, `${folderName}.html`);
			const headContent = await vsReadFile(htmlPath);
			const head = headContent.substring(0, 500);
			// Match both "Post ID:" and "ID:" formats (patterns use short form)
			const idMatch = head.match(/(?:Post\s+)?ID:\s*(\d+)/i);
			if (idMatch) {
				this.debugLogger.info(
					`🔍 [extractPostInfo] Resolved via HTML header: Post ID ${idMatch[1]}`
				);
				return {
					postId: parseInt(idMatch[1], 10),
					postFolder: folder.replace(/\\/g, "/"),
				};
			}
			this.debugLogger.info(
				`🔍 [extractPostInfo] HTML header has no Post ID. First 200 chars: ${head.substring(0, 200)}`
			);
		} catch (err: any) {
			this.debugLogger.info(
				`🔍 [extractPostInfo] Could not read HTML file: ${err.message}`
			);
		}

		this.debugLogger.info(
			`⚠️ [extractPostInfo] FAILED: Could not resolve post ID for folder: ${folderName}`
		);
		return null;
	}

	/**
	 * Start cursor tracking for Gutenberg block selection sync
	 * When cursor moves in IDE, updates .skylit/active-block.txt
	 * GT polls this to keep block selection in sync
	 */
	private startCursorTracking() {
		if (!this.cursorTrackingEnabled) {
			this.debugLogger.log("⏭️ Cursor tracking disabled via settings");
			return;
		}

		this.debugLogger.log("🎯 Starting cursor tracking for Gutenberg sync");
		this.debugLogger.log(`   Dev folder: ${this.devFolder}`);

		this.cursorSelectionListener = vscode.window.onDidChangeTextEditorSelection(
			(e) => {
				this.handleCursorChange(e);
			}
		);

		this.startLineTracking();
	}

	/**
	 * Subscribe to text document changes and shift cached block line numbers
	 * in real time — the same approach IDEs use for breakpoint tracking.
	 * Keeps block lines accurate between saves without re-scanning.
	 */
	private startLineTracking() {
		this.lineTrackingListener = vscode.workspace.onDidChangeTextDocument(
			(event) => {
				const filePath = event.document.uri.fsPath.replace(/\\/g, "/");
				if (!filePath.endsWith(".html")) return;

				const isContent =
					filePath.includes("/post-types/") ||
					filePath.includes("/templates/") ||
					filePath.includes("/parts/") ||
					filePath.includes("/patterns/");
				if (!isContent) return;

				const postId = this.getPostIdForFile(filePath);
				if (!postId) return;

				const blocks = this.liveBlockLines.get(postId);
				if (!blocks || blocks.length === 0) return;

				// Process changes bottom-to-top so earlier shifts don't affect later ones
				const sorted = [...event.contentChanges].sort(
					(a, b) => b.range.start.line - a.range.start.line
				);

				for (const change of sorted) {
					const linesRemoved =
						change.range.end.line - change.range.start.line;
					const linesAdded = change.text.split("\n").length - 1;
					const delta = linesAdded - linesRemoved;

					if (delta === 0) continue;

					// Full-file replacement (formatter, AI agent) — invalidate cache.
					// Next cursor move will re-read from metadata JSON on disk.
					if (
						change.range.start.line === 0 &&
						change.range.end.line >=
							event.document.lineCount - Math.abs(delta) - 1
					) {
						this.liveBlockLines.delete(postId);
						this.lastCursorBlockId = null;
						this.debugLogger.log(
							`📐 [LineTrack] Full-file replacement detected for post ${postId}, cache invalidated`
						);
						return;
					}

					const editLine = change.range.start.line + 1; // 1-based
					for (const block of blocks) {
						if (block.line > editLine) {
							block.line += delta;
						}
					}
				}
			}
		);

		this.debugLogger.log("📐 Real-time line tracking started");
	}

	/**
	 * Handle cursor position change with debouncing
	 */
	private handleCursorChange(e: vscode.TextEditorSelectionChangeEvent) {
		// Skip if we're in the cooldown window after a GT→IDE jump.
		// Without this, the jump moves the cursor, which writes active-block.txt,
		// which makes GT select the (possibly parent) block, causing a second jump.
		if (Date.now() < this.jumpCooldownUntil) return;

		const filePath = e.textEditor.document.uri.fsPath.replace(/\\/g, "/");

		// Only track HTML files in content folders
		if (!filePath.endsWith(".html")) return;
		const isContent =
			filePath.includes("/post-types/") ||
			filePath.includes("/templates/") ||
			filePath.includes("/parts/") ||
			filePath.includes("/patterns/");
		if (!isContent) return;

		// Clear existing debounce timer
		if (this.cursorDebounceTimer) {
			clearTimeout(this.cursorDebounceTimer);
		}

		// Debounce: 120ms after cursor stops moving.
		// Enough to skip continuous arrow-key movement; short enough to feel instant
		// on deliberate cursor placement (click or single keypress).
		this.cursorDebounceTimer = setTimeout(() => {
			this.processCursorPosition(e.textEditor);
		}, 120);
	}

	/**
	 * Process cursor position and update active block file
	 */
	private async processCursorPosition(editor: vscode.TextEditor) {
		try {
			const filePath = editor.document.uri.fsPath.replace(/\\/g, "/");
			const cursorLine = editor.selection.active.line; // 0-based

			const parentDir = path.dirname(filePath);
			const postId = this.extractPostIdFromPath(parentDir);
			if (!postId) {
				return;
			}

			let blocks = this.liveBlockLines.get(postId);
			if (!blocks) {
				const metadataPath = posixJoin(
					this.devFolder,
					".skylit",
					"metadata",
					`${postId}.json`
				);
				try {
					const raw = await vsReadFile(metadataPath);
					const meta = JSON.parse(raw);
					if (meta?.blocks && Array.isArray(meta.blocks)) {
						blocks = meta.blocks.map(
							(b: { layoutBlockId: string; line: number; blockName: string }) => ({
								layoutBlockId: b.layoutBlockId,
								line: b.line,
								blockName: b.blockName,
							})
						);
						this.liveBlockLines.set(postId, blocks);
						this.debugLogger.info(
							`📐 [Cursor] Loaded ${blocks.length} block lines for post ${postId}`
						);
					}
				} catch {
					this.debugLogger.info(
						`🎯 [Cursor] ⚠️ Could not read metadata for post ${postId}`
					);
					return;
				}
			}

			let layoutBlockId: string | null = null;
			if (blocks) {
				const match = this.findBlockForLine(blocks, cursorLine + 1);
				if (match) {
					layoutBlockId = match.layoutBlockId;
				}
			}

			if (!layoutBlockId) {
				return;
			}

			if (layoutBlockId === this.lastCursorBlockId) {
				return;
			}

			this.lastCursorBlockId = layoutBlockId;

			const ts = Date.now();
			this.debugLogger.info(
				`🎯 [Cursor] line ${cursorLine + 1} → ${layoutBlockId.substring(0, 12)}… → REST+file`
			);

			// Primary: push via REST (direct DB write, bypasses all caching)
			this.restClient.pushCursorBlock(postId, layoutBlockId, ts).catch(() => {});

			// Fallback: write file with timestamp so GT dedup can detect changes
			const activeBlockPath = posixJoin(
				this.devFolder,
				".skylit",
				"active-block.txt"
			);
			await vsWriteFile(activeBlockPath, `${postId}:${ts}:${layoutBlockId}`);
		} catch (error: any) {
			this.debugLogger.info(`🎯 [Cursor] ❌ Error: ${error.message}`);
		}
	}

	/**
	 * Find which block contains the given line number (1-based).
	 * Uses the metadata blocks array which has line numbers for each block.
	 * Primary method for cursor → layoutBlockId resolution since
	 * data-layout-block-id is stripped from the exported HTML.
	 */
	private findBlockForLine(
		blocks: Array<{
			layoutBlockId: string;
			blockName: string;
			line: number;
		}>,
		targetLine: number
	): { layoutBlockId: string; blockName: string; line: number } | null {
		if (!blocks || blocks.length === 0) {
			return null;
		}

		// Sort blocks by line number
		const sortedBlocks = [...blocks].sort((a, b) => a.line - b.line);

		// Find the block whose line is closest to (but not after) the target line
		let bestMatch: (typeof blocks)[0] | null = null;

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
	 * Mark a post as being deleted via command to skip FileWatcher's delete prompt
	 * Call this before deleting the folder to prevent double prompts
	 */
	markPostForDeletion(postId: number) {
		this.skipDeletePromptForPosts.add(postId);
		// Auto-remove after 5 seconds in case the deletion fails
		setTimeout(() => {
			this.skipDeletePromptForPosts.delete(postId);
		}, 5000);
	}

	/**
	 * Suppress cursor-to-GT sync for a short window after a GT→IDE jump.
	 * Without this, the jump moves the IDE cursor, which triggers
	 * processCursorPosition → active-block.txt write → GT selects block →
	 * GT may shift focus to parent → different block selected → second jump.
	 */
	suppressCursorSyncBriefly() {
		// Match CURSOR_LOCK_MS_GT on the GT side (3000ms) so both sides
		// yield for the same window after a GT→IDE jump.
		this.jumpCooldownUntil = Date.now() + 3000;
	}

	/**
	 * Stop watching files
	 */
	dispose() {
		// Stop main file watcher
		if (this.watcher) {
			this.watcher.close();
			this.debugLogger.log("👋 File watcher stopped");
		}

		// Stop trash folder watcher (chokidar)
		if (this.trashWatcher) {
			this.trashWatcher.close();
			this.debugLogger.log("👋 Trash folder watcher stopped");
		}

		// Stop VS Code native trash watcher
		if (this.vscodeTrashWatcher) {
			this.vscodeTrashWatcher.dispose();
			this.debugLogger.log("👋 VS Code trash watcher stopped");
		}

		// Stop theme folder watcher (bi-directional sync)
		if (this.themeWatcher) {
			this.themeWatcher.close();
			this.debugLogger.log("👋 Theme watcher stopped");
		}

		// Stop new folder watcher (chokidar - legacy)
		if (this.newFolderWatcher) {
			this.newFolderWatcher.close();
			this.debugLogger.log("👋 New folder watcher stopped");
		}

		// Stop VS Code native new folder watcher
		if (this.vscodeNewFolderWatcher) {
			this.vscodeNewFolderWatcher.dispose();
			this.debugLogger.log("👋 VS Code new folder watcher stopped");
		}

		// Stop VS Code native theme watcher
		if (this.vscodeThemeWatcher) {
			this.vscodeThemeWatcher.dispose();
			this.debugLogger.log("👋 VS Code theme watcher stopped");
		}

		// Stop metadata watcher
		if (this.metadataWatcher) {
			this.metadataWatcher.close();
			this.debugLogger.log("👋 Metadata watcher stopped");
		}

		// Clear metadata cache
		this.metadataCache.clear();
		this.metadataSyncCooldown.clear();

		// Clear folding state manager
		this.foldingManager.clear();

		// Clear all file debounce timers
		this.debounceTimers.forEach((timer) => clearTimeout(timer));
		this.debounceTimers.clear();

		// Clear all folder action timers
		this.folderActionTimers.forEach((timer) => clearTimeout(timer));
		this.folderActionTimers.clear();

		// Clear new folder timers
		this.newFolderTimers.forEach((timer) => clearTimeout(timer));
		this.newFolderTimers.clear();

		// Clear ACF/taxonomy batch debounce timers
		if (this.acfJsonBatchTimer) {
			clearTimeout(this.acfJsonBatchTimer);
			this.acfJsonBatchTimer = null;
		}
		if (this.taxonomyJsonBatchTimer) {
			clearTimeout(this.taxonomyJsonBatchTimer);
			this.taxonomyJsonBatchTimer = null;
		}

		// Clear sync cooldown tracking
		this.lastSyncTime.clear();
		this.selfWrittenPaths.clear();

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
			this.debugLogger.log("👋 Cursor tracking stopped");
		}
		if (this.cursorDebounceTimer) {
			clearTimeout(this.cursorDebounceTimer);
			this.cursorDebounceTimer = null;
		}

		// Stop line tracking
		if (this.lineTrackingListener) {
			this.lineTrackingListener.dispose();
			this.lineTrackingListener = null;
			this.debugLogger.log("👋 Line tracking stopped");
		}
		this.liveBlockLines.clear();

		// Clear all polling intervals
		this.pollingIntervals.forEach((interval) => clearInterval(interval));
		this.pollingIntervals = [];
	}

	// =========================================================================
	// Media Library Sync
	// =========================================================================

	/**
	 * VS Code native watcher for media-library/ — works over SSH/remote just like
	 * the content-folder watchers. Chokidar cannot watch remote SSH paths, so this
	 * is the correct approach for Hostinger and other remote setups.
	 */
	private startMediaLibraryWatcher(): void {
		if (!this.mediaSyncEnabled) {
			this.debugLogger.log("⏭️ Media library watcher skipped — sync disabled");
			return;
		}
		if (this.vscodeMediaWatcher) {
			return; // Already started — idempotent
		}

		const mediaLibPath = posixJoin(this.devFolder, "media-library");
		this.debugLogger.log(`👀 Starting media-library watcher: ${mediaLibPath}`);

		const pattern = new vscode.RelativePattern(pathToUri(mediaLibPath), "**/*");

		this.vscodeMediaWatcher = vscode.workspace.createFileSystemWatcher(
			pattern,
			false, // create
			false, // change
			false  // delete
		);

		const MEDIA_EXTENSIONS = new Set([
			".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg",
			".mp4", ".webm", ".ogg", ".mov",
			".mp3", ".wav", ".aac",
			".pdf",
		]);

		const shouldProcess = (uri: vscode.Uri): boolean => {
			const ext = path.extname(uri.fsPath).toLowerCase();
			return MEDIA_EXTENSIONS.has(ext);
		};

		// Use uri.path (not uri.fsPath) so SSH/remote paths resolve correctly
		const uriToPath = (uri: vscode.Uri) =>
			uri.scheme === "file" ? uri.fsPath : uri.path;

		this.vscodeMediaWatcher.onDidCreate((uri) => {
			if (!shouldProcess(uri)) return;
			const p = uriToPath(uri);
			this.debugLogger.log(`📷 Media created: ${p}`);
			this.handleMediaFileChange(p, "add");
		});

		this.vscodeMediaWatcher.onDidChange((uri) => {
			if (!shouldProcess(uri)) return;
			const p = uriToPath(uri);
			this.debugLogger.log(`📷 Media changed: ${p}`);
			this.handleMediaFileChange(p, "change");
		});

		this.vscodeMediaWatcher.onDidDelete((uri) => {
			if (!shouldProcess(uri)) return;
			const p = uriToPath(uri);
			this.debugLogger.log(`📷 Media deleted: ${p}`);
			this.handleMediaFileChange(p, "unlink");
		});

		this.debugLogger.info("✅ Media library watcher started");
	}

	/**
	 * Load all .skylit/media/*.json files into the in-memory index.
	 * Called once on connection. Uses VS Code FS API for SSH/remote compatibility.
	 * Also prunes stale entries whose actual media file no longer exists on disk.
	 */
	public async loadMediaMetaIndex(): Promise<void> {
		const mediaMetaDir = posixJoin(this.devFolder, ".skylit", "media");
		this.mediaMetaIndex.clear();
		try {
			const dirUri = pathToUri(mediaMetaDir);
			const entries = await vscode.workspace.fs.readDirectory(dirUri);

			/** Stale entries: local file missing, metadata JSON already deleted from disk. */
			const staleEntries: Array<{ attachmentId: number; localPath: string }> = [];

			for (const [name] of entries) {
				if (!name.endsWith(".json")) continue;
				try {
					const fileUri = pathToUri(posixJoin(mediaMetaDir, name));
					const raw = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString("utf-8");
					const meta = JSON.parse(raw) as import("./types").MediaMetadata;
					if (!meta.local_path) continue;

					// Check whether the actual media file still exists
					const mediaFileUri = pathToUri(posixJoin(this.devFolder, meta.local_path));
					let fileExists = false;
					try {
						await vscode.workspace.fs.stat(mediaFileUri);
						fileExists = true;
					} catch {
						fileExists = false;
					}

					if (fileExists) {
						this.mediaMetaIndex.set(meta.local_path, meta);
					} else {
						// Stale — file was deleted while the extension was offline.
						// Remove the metadata JSON now; schedule WP delete below.
						this.debugLogger.log(`🧹 Stale media (file missing): ${meta.local_path} — queuing WP delete`);
						staleEntries.push({ attachmentId: meta.attachment_id, localPath: meta.local_path });
						try {
							await vscode.workspace.fs.delete(fileUri, { useTrash: false });
						} catch { /* ignore */ }
					}
				} catch {
					// Skip malformed metadata files
				}
			}

			this.debugLogger.info(
				`📂 Media metadata index loaded: ${this.mediaMetaIndex.size} entries` +
				(staleEntries.length ? `, ${staleEntries.length} stale (will delete from WP)` : "")
			);

			// Delete stale attachments from WordPress — only when sync direction allows
			// local→WP deletes (same guard as the live watcher unlink path).
			if (
				staleEntries.length > 0 &&
				this.mediaSyncEnabled &&
				this.mediaSyncDirection !== "wp-to-local"
			) {
				this.debugLogger.info(`🗑️ Cleaning up ${staleEntries.length} WP attachment(s) deleted while offline…`);
				for (const { attachmentId, localPath } of staleEntries) {
					try {
						await this.restClient.deleteMediaAttachment(attachmentId);
						this.debugLogger.info(`✅ WP attachment deleted (offline cleanup): ${localPath} (ID ${attachmentId})`);
					} catch (err: any) {
						this.debugLogger.warn(`⚠️ Could not delete WP attachment ${attachmentId} (${localPath}): ${err.message}`);
					}
				}
			} else if (staleEntries.length > 0) {
				this.debugLogger.info(`⏭️ Stale WP attachments NOT deleted — sync disabled or direction is wp-to-local`);
			}

		} catch {
			// Folder may not exist yet — not an error
			this.debugLogger.info(`📂 Media metadata dir not found yet — starting fresh`);
		}
	}

	/**
	 * Write a metadata entry to .skylit/media/{attachment_id}.json and update the index.
	 * Uses VS Code FS API so it works over SSH/remote.
	 */
	private async writeMediaMeta(meta: import("./types").MediaMetadata): Promise<void> {
		const mediaMetaDir = posixJoin(this.devFolder, ".skylit", "media");
		const filePath = posixJoin(mediaMetaDir, `${meta.attachment_id}.json`);
		try {
			const uri = pathToUri(filePath);
			await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(meta, null, "\t"), "utf-8"));
		} catch (err: any) {
			this.debugLogger.log(`⚠️ Media: failed to write metadata: ${err.message}`);
		}
		this.mediaMetaIndex.set(meta.local_path, meta);
	}

	/**
	 * Remove a metadata entry from disk and from the index.
	 * Uses VS Code FS API so it works over SSH/remote.
	 */
	private async removeMediaMeta(attachmentId: number, localPath: string): Promise<void> {
		const mediaMetaDir = posixJoin(this.devFolder, ".skylit", "media");
		const filePath = posixJoin(mediaMetaDir, `${attachmentId}.json`);
		try {
			const uri = pathToUri(filePath);
			await vscode.workspace.fs.delete(uri, { useTrash: false });
		} catch { /* file may not exist — ignore */ }
		this.mediaMetaIndex.delete(localPath);
	}

	/**
	 * Handle a file event inside media-library/.
	 * Routes add/change to push logic (with hash dedup + rename detection)
	 * and unlink to the pending-delete buffer (1s rename window).
	 */
	private async handleMediaFileChange(filePath: string, eventType: "add" | "change" | "unlink"): Promise<"pushed" | "skipped" | "renamed" | "deleted" | "error" | "ignored"> {
		if (!this.mediaSyncEnabled) return "ignored";

		const normalizedPath = filePath.replace(/\\/g, "/");
		// Strip the dev folder prefix to get the relative path — use devFolder (not localDevFolder)
		// because VS Code native watcher URIs are based on devFolder path.
		const devFolderNormalized = this.devFolder.replace(/\\/g, "/").replace(/\/$/, "");
		const localDevFolderNormalized = this.localDevFolder.replace(/\\/g, "/").replace(/\/$/, "");

		// Compute local_path relative to dev root (e.g. "media-library/test/photo.webp")
		// Accept either devFolder or localDevFolder prefix (handles local + SSH cases)
		let localPath: string;
		if (normalizedPath.startsWith(devFolderNormalized + "/")) {
			localPath = normalizedPath.substring(devFolderNormalized.length + 1);
		} else if (normalizedPath.startsWith(localDevFolderNormalized + "/")) {
			localPath = normalizedPath.substring(localDevFolderNormalized.length + 1);
		} else {
			localPath = path.basename(normalizedPath);
		}

		if (eventType === "add" || eventType === "change") {
			// Read file via VS Code filesystem API — works over SSH/remote
			let fileBuffer: Buffer;
		try {
			const uri = pathToUri(filePath);
			const uint8 = await vscode.workspace.fs.readFile(uri);
			fileBuffer = Buffer.from(uint8);
		} catch {
			this.debugLogger.log(`⚠️ Media: cannot read file (may not exist yet): ${filePath}`);
			return "error";
		}

		// Compute hash
		const hash = require("crypto").createHash("md5").update(fileBuffer).digest("hex");

		// Hash dedup: skip if file is already in WP with same content
		const existingMeta = this.mediaMetaIndex.get(localPath);
		if (existingMeta && existingMeta.sync_hash === hash) {
			this.debugLogger.log(`⏭️ Media skip (already in WP, hash matches): ${localPath} (ID: ${existingMeta.attachment_id})`);
			return "skipped";
		}

			// Rename detection: check if any pending delete has this hash
			const pendingEntry = this.pendingMediaDeletes.get(hash);
			if (pendingEntry) {
				// This is a rename/move — cancel delete, call rename endpoint
				clearTimeout(pendingEntry.timer);
				this.pendingMediaDeletes.delete(hash);

				this.debugLogger.log(`🔀 Media rename detected: ${localPath} (attachment ${pendingEntry.attachmentId})`);

			try {
				// WP path is relative to media-library/
				const newWpPath = localPath.replace(/^media-library\//, "");
				await this.restClient.renameMediaFile(pendingEntry.attachmentId, newWpPath);

				// Update metadata
				const oldMeta = [...this.mediaMetaIndex.values()].find(
					(m) => m.attachment_id === pendingEntry.attachmentId
				);
				if (oldMeta) {
					this.mediaMetaIndex.delete(oldMeta.local_path);
				}
				const newMeta: import("./types").MediaMetadata = {
					attachment_id: pendingEntry.attachmentId,
					local_path: localPath,
					wp_path: newWpPath,
					sync_hash: hash,
					modified_local: new Date().toISOString(),
					modified_wp: new Date().toISOString(),
				};
			await this.writeMediaMeta(newMeta);
			this.debugLogger.log(`✅ Media renamed: ${localPath}`);
			} catch (err: any) {
				this.debugLogger.log(`❌ Media rename failed: ${err.message}`);
			}
			return "renamed";
			}

			// New file or content changed — push to WP
			const relPath = localPath.replace(/^media-library\//, "");
			const ext = path.extname(filePath).toLowerCase();
			const mimeMap: Record<string, string> = {
				".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
				".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
				".mp4": "video/mp4", ".webm": "video/webm", ".ogg": "video/ogg",
				".mp3": "audio/mpeg", ".wav": "audio/wav",
				".pdf": "application/pdf",
			};
			const mimeType = mimeMap[ext] || "application/octet-stream";

			this.debugLogger.log(`📤 Pushing media file: ${relPath}`);

			try {
				const response = await this.restClient.pushMediaFile(
					filePath, relPath, fileBuffer, mimeType
				);

			const result = response.results?.[0];
			if (result?.success && result.attachment_id) {
				const meta: import("./types").MediaMetadata = {
					attachment_id: result.attachment_id,
					local_path: localPath,
					wp_path: relPath,
					sync_hash: hash,
					modified_local: new Date().toISOString(),
					modified_wp: new Date().toISOString(),
				};
				await this.writeMediaMeta(meta);
				this.debugLogger.info(`✅ Media pushed: ${relPath} (ID: ${result.attachment_id})`);
				return "pushed";
			} else {
				this.debugLogger.warn(`⚠️ Media push failed: ${result?.error || "unknown error"}`);
				return "error";
			}
		} catch (err: any) {
			this.debugLogger.warn(`❌ Media push error: ${err.message}`);
			return "error";
		}

	} else if (eventType === "unlink") {
		// File deleted — put in pending buffer for 1 second (rename detection window)
		const existingMeta = this.mediaMetaIndex.get(localPath);
		if (!existingMeta) {
			this.debugLogger.log(`⚠️ Media deleted but no metadata found: ${localPath}`);
			return "ignored";
		}

		const { attachment_id: attachmentId, sync_hash: hash } = existingMeta;

		this.debugLogger.log(`🗑️ Media delete queued: ${localPath} (1s rename window)`);

		const timer = setTimeout(async () => {
			this.pendingMediaDeletes.delete(hash);

			// Check sync direction
			if (this.mediaSyncDirection === "wp-to-local") {
				this.debugLogger.log(`⏭️ Media delete skipped (wp-to-local direction): ${localPath}`);
				return;
			}

			this.debugLogger.log(`🗑️ Media deleting from WP: attachment ${attachmentId}`);
			try {
				await this.restClient.deleteMediaAttachment(attachmentId);
				await this.removeMediaMeta(attachmentId, localPath);
				this.debugLogger.log(`✅ Media deleted from WP: attachment ${attachmentId}`);
			} catch (err: any) {
				this.debugLogger.log(`❌ Media delete from WP failed: ${err.message}`);
			}
		}, 1000);

		this.pendingMediaDeletes.set(hash, { attachmentId, timer });
		return "deleted";
	}

	return "ignored";
	}

	/**
	 * Fetch media sync settings from WP and cache them.
	 * Called during connection setup.
	 */
	public async refreshMediaSyncSettings(): Promise<void> {
		try {
			const settings = await this.restClient.getMediaSettings();
			this.mediaSyncEnabled = settings.enabled;
			this.mediaSyncDirection = settings.direction;
			this.debugLogger.info(
				`📷 Media sync: ${settings.enabled ? "enabled" : "disabled"}, direction: ${settings.direction}`
			);
		} catch (err: any) {
			this.debugLogger.warn(`⚠️ Media settings endpoint failed (${err?.message || err}) — assuming enabled/bidirectional`);
			this.mediaSyncEnabled = true;
			this.mediaSyncDirection = "bidirectional";
		}

		if (this.mediaSyncEnabled) {
			try {
				await this.loadMediaMetaIndex();
			} catch (err: any) {
				this.debugLogger.warn(`⚠️ Media meta index load failed: ${err?.message || err}`);
			}
			try {
				this.startMediaLibraryWatcher();
			} catch (err: any) {
				this.debugLogger.warn(`⚠️ Media watcher start failed: ${err?.message || err}`);
			}
			if (this.mediaSyncDirection !== "wp-to-local") {
				this.syncUntrackedMediaFiles().catch((err: any) => {
					this.debugLogger.warn(`⚠️ Media untracked sync failed: ${err?.message || err}`);
				});
			}
		}
	}

	/**
	 * Scan media-library/ recursively and push any file that has no metadata entry.
	 * Runs in the background on connection — does not block the editor.
	 */
	private async syncUntrackedMediaFiles(): Promise<void> {
		const MEDIA_EXTENSIONS = new Set([
			".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg",
			".mp4", ".webm", ".ogg", ".mov",
			".mp3", ".wav", ".aac",
			".pdf",
		]);

		const mediaLibUri = pathToUri(posixJoin(this.devFolder, "media-library"));

		const collectFiles = async (dirUri: vscode.Uri): Promise<vscode.Uri[]> => {
			const results: vscode.Uri[] = [];
			try {
				const entries = await vscode.workspace.fs.readDirectory(dirUri);
				for (const [name, type] of entries) {
					const childUri = vscode.Uri.joinPath(dirUri, name);
					if (type === vscode.FileType.Directory) {
						const nested = await collectFiles(childUri);
						results.push(...nested);
					} else if (type === vscode.FileType.File) {
						if (MEDIA_EXTENSIONS.has(path.extname(name).toLowerCase())) {
							results.push(childUri);
						}
					}
				}
			} catch { /* folder may not exist yet */ }
			return results;
		};

		let files: vscode.Uri[];
		try {
			files = await collectFiles(mediaLibUri);
		} catch {
			return;
		}

		const untracked = files.filter((uri) => {
			const normalizedPath = uri.path.replace(/\\/g, "/");
			const devFolderNormalized = this.devFolder.replace(/\\/g, "/").replace(/\/$/, "");
			const localPath = normalizedPath.startsWith(devFolderNormalized + "/")
				? normalizedPath.substring(devFolderNormalized.length + 1)
				: path.basename(normalizedPath);
			return !this.mediaMetaIndex.has(localPath);
		});

		if (untracked.length === 0) {
			this.debugLogger.info("✅ Media: no untracked files found on connection check");
			return;
		}

		this.debugLogger.info(`📤 Media: found ${untracked.length} untracked file(s) — pushing to WP`);

		for (const uri of untracked) {
			// uri.fsPath may be empty for remote URIs — use uri.path instead
			const filePath = uri.scheme === "file" ? uri.fsPath : uri.path;
			this.debugLogger.log(`📤 Media: pushing untracked: ${filePath}`);
			try {
				await this.handleMediaFileChange(filePath, "add");
			} catch (err: any) {
				this.debugLogger.log(`⚠️ Media untracked push failed for ${filePath}: ${err.message}`);
			}
		}
	}

	/**
	 * Manual import: pull all WP media attachments into media-library/ (paginated).
	 * Calls POST /media/import in a loop until done.
	 */
	public async importMediaFromWP(
		progress?: (message: string, done: number, total: number) => void
	): Promise<{ processed: number; skipped: number; errors: number }> {
		let offset = 0;
		let total = 0;
		let processed = 0;
		let skipped = 0;
		const errors = 0;

		this.debugLogger.info("📥 Manual import: pulling WP media → media-library/");

		// eslint-disable-next-line no-constant-condition
		while (true) {
			let batch: Awaited<ReturnType<typeof this.restClient.importMediaBatch>>;
			try {
				batch = await this.restClient.importMediaBatch(offset);
			} catch (err: any) {
				this.debugLogger.warn(`❌ Import batch failed at offset ${offset}: ${err.message}`);
				break;
			}

			processed += batch.processed;
			skipped += batch.skipped;
			total = batch.total || total;
			offset = batch.offset;

			progress?.(
				`Imported ${processed} / ${total} (${skipped} skipped)`,
				Math.min(offset, total),
				total
			);

			if (batch.done || batch.message) break;
		}

		this.debugLogger.info(`✅ Import complete — processed: ${processed}, skipped: ${skipped}`);

		// Reload the metadata index so the watcher reflects newly imported files
		try {
			await this.loadMediaMetaIndex();
		} catch { /* non-fatal */ }

		return { processed, skipped, errors };
	}

	/**
	 * Full media sync: honours the direction setting (WP→Dev, Dev→WP, or bidirectional).
	 * For WP→Dev / bidirectional: pulls from WP (paginated).
	 * For Dev→WP: pushes all local files.
	 */
	public async fullMediaSync(
		progress?: (message: string, done: number, total: number) => void
	): Promise<{ processed: number; skipped: number; errors: number }> {
		this.debugLogger.info(`🔄 Full media sync (direction: ${this.mediaSyncDirection})`);

		if (this.mediaSyncDirection === "local-to-wp") {
			// Push all local files to WP
			const r = await this.pushAllMediaToWP(progress);
			return { processed: r.pushed, skipped: r.skipped, errors: r.errors };
		}

		// WP→Dev or bidirectional: import from WP, then also push any untracked local files
		const importResult = await this.importMediaFromWP(progress);

		if (this.mediaSyncDirection === "bidirectional") {
			// Also push any local files not yet in WP
			this.debugLogger.info("🔄 Bidirectional: also pushing untracked local files → WP");
			await this.syncUntrackedMediaFiles();
		}

		return importResult;
	}

	/**
	 * Manual push: scan media-library/ and push ALL files (tracked + untracked) to WordPress.
	 * This is the "push all" action triggered from the IDE command palette or status bar menu.
	 * Returns a summary { pushed, skipped, errors }.
	 */
	public async pushAllMediaToWP(
		progress?: (message: string, pushed: number, total: number) => void
	): Promise<{ pushed: number; skipped: number; errors: number }> {
		const MEDIA_EXTENSIONS = new Set([
			".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg",
			".mp4", ".webm", ".ogg", ".mov",
			".mp3", ".wav", ".aac",
			".pdf",
		]);

		const mediaLibUri = pathToUri(posixJoin(this.devFolder, "media-library"));

		const collectFiles = async (dirUri: vscode.Uri): Promise<vscode.Uri[]> => {
			const results: vscode.Uri[] = [];
			try {
				const entries = await vscode.workspace.fs.readDirectory(dirUri);
				for (const [name, type] of entries) {
					const childUri = vscode.Uri.joinPath(dirUri, name);
					if (type === vscode.FileType.Directory) {
						results.push(...await collectFiles(childUri));
					} else if (type === vscode.FileType.File) {
						if (MEDIA_EXTENSIONS.has(path.extname(name).toLowerCase())) {
							results.push(childUri);
						}
					}
				}
			} catch { /* folder may not exist */ }
			return results;
		};

		const files = await collectFiles(mediaLibUri);
		if (files.length === 0) {
			this.debugLogger.info("📷 Manual push: no media files found in media-library/");
			return { pushed: 0, skipped: 0, errors: 0 };
		}

		this.debugLogger.info(`📤 Manual push: scanning ${files.length} media file(s)…`);

		let pushed = 0;
		let skipped = 0;
		let errors = 0;

		for (let i = 0; i < files.length; i++) {
			const uri = files[i];
			const filePath = uri.scheme === "file" ? uri.fsPath : uri.path;
			const relName = path.basename(filePath);

			progress?.(relName, i + 1, files.length);

			// "change" triggers hash-dedup — already-synced files return "skipped"
			const result = await this.handleMediaFileChange(filePath, "change");
			if (result === "pushed") {
				pushed++;
			} else if (result === "skipped") {
				skipped++;
				this.debugLogger.log(`⏭️ Manual push: already in WP, skipping — ${relName}`);
			} else if (result === "error") {
				errors++;
			}
			// "ignored" / "renamed" / "deleted" don't count in either bucket
		}

		this.debugLogger.info(`✅ Manual push complete — pushed: ${pushed}, skipped: ${skipped} (already in WP), errors: ${errors}`);
		return { pushed, skipped, errors };
	}
}
