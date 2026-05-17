/**
 * Export Poller
 *
 * Polls the WordPress REST API for pending exports and writes
 * the compiled HTML/CSS to the local dev folder. This enables
 * remote dev folder mode where WordPress runs on a server and
 * the dev folder lives on the developer's local machine.
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { RestClient } from "./restClient";
import { StatusBar } from "./statusBar";
import { DebugLogger } from "./debugLogger";
import { ExportPayload } from "./types";

export class ExportPoller {
	private restClient: RestClient;
	private localDevPath: string;
	private statusBar: StatusBar;
	private debugLogger: DebugLogger;
	private pollTimer: NodeJS.Timeout | null = null;
	private pollIntervalMs: number = 2500;
	private consecutiveErrors: number = 0;
	private consecutiveIdle: number = 0;
	private isPolling: boolean = false;
	private disposed: boolean = false;

	private static readonly MIN_INTERVAL = 2500;
	private static readonly IDLE_INTERVAL = 5000;
	private static readonly MAX_INTERVAL = 30000;
	private static readonly MAX_ERRORS_BEFORE_BACKOFF = 3;
	private static readonly IDLE_POLLS_BEFORE_BACKOFF = 10;

	/** Optional callback invoked with the normalized path of every file the poller writes.
	 *  Used to tell the FileWatcher to skip re-importing these writes. */
	private onFileWritten: ((filePath: string) => void) | null = null;

	constructor(
		restClient: RestClient,
		localDevPath: string,
		statusBar: StatusBar,
		debugLogger: DebugLogger,
		onFileWritten?: (filePath: string) => void
	) {
		this.restClient = restClient;
		this.localDevPath = localDevPath;
		this.statusBar = statusBar;
		this.debugLogger = debugLogger;
		this.onFileWritten = onFileWritten || null;
	}

	/**
	 * Start polling for pending exports
	 */
	start(): void {
		if (this.pollTimer) {
			this.stop();
		}

		this.disposed = false;
		this.consecutiveErrors = 0;
		this.pollIntervalMs = ExportPoller.MIN_INTERVAL;

		this.ensureLocalFolderStructure();

		this.debugLogger.log("📡 Export poller started (remote dev folder mode)");

		this.schedulePoll();
	}

	/**
	 * Stop polling
	 */
	stop(): void {
		if (this.pollTimer) {
			clearTimeout(this.pollTimer);
			this.pollTimer = null;
		}
		this.debugLogger.log("📡 Export poller stopped");
	}

	/**
	 * Dispose and clean up
	 */
	dispose(): void {
		this.disposed = true;
		this.stop();
	}

	/**
	 * Update the local dev path (if user changes settings)
	 */
	setLocalDevPath(newPath: string): void {
		this.localDevPath = newPath;
	}

	/**
	 * Verify localDevPath is a writable directory.
	 * Returns null on success, a human-readable reason string on failure.
	 */
	private validateLocalDevPath(): string | null {
		if (!this.localDevPath || !this.localDevPath.trim()) {
			return "skylit.localDevPath is not set";
		}
		try {
			const stat = fs.statSync(this.localDevPath);
			if (!stat.isDirectory()) {
				return `'${this.localDevPath}' exists but is not a directory`;
			}
			fs.accessSync(this.localDevPath, fs.constants.W_OK);
			return null;
		} catch (err: any) {
			if (err && err.code === "ENOENT") {
				return `directory does not exist: ${this.localDevPath}`;
			}
			return `${err?.message || err} (${this.localDevPath})`;
		}
	}

	/**
	 * Perform a full sync: download global files, then fetch manifest and download all posts
	 */
	async performFullSync(): Promise<{
		synced: number;
		errors: number;
		failed: boolean;
	}> {
		this.debugLogger.log("📦 Starting full sync from remote...");
		let synced = 0;
		let errors = 0;

		// Validate destination up-front so we fail fast with an actionable error
		// instead of a generic write failure on the first file.
		const pathError = this.validateLocalDevPath();
		if (pathError) {
			this.debugLogger.error(
				`❌ Full sync aborted — local dev path unusable: ${pathError}`
			);
			vscode.window.showErrorMessage(
				`Cannot sync from remote: ${pathError}. Fix skylit.localDevPath, then retry.`
			);
			return { synced, errors, failed: true };
		}

		try {
			// Scaffold the standard directory structure before writing any files
			this.ensureLocalFolderStructure();

			// Download global dev folder files first (assets, includes, acf-json, etc.)
			await this.downloadGlobalFiles();

			const manifest = await this.restClient.getExportAll();
			this.debugLogger.log(`📦 Manifest: ${manifest.count} posts to sync`);

			for (const entry of manifest.posts) {
				try {
					const payload = await this.restClient.getExportContent(entry.post_id);
					await this.writeExportLocally(payload);
					synced++;
				} catch (error: any) {
					this.debugLogger.log(
						`⚠️ Failed to sync post ${entry.post_id} (${entry.slug}): ${error.message}`
					);
					errors++;
				}
			}

			this.debugLogger.log(
				`📦 Full sync complete: ${synced} synced, ${errors} errors`
			);
			return { synced, errors, failed: false };
		} catch (error: any) {
			this.debugLogger.log(`❌ Full sync failed: ${error.message}`);
			return { synced, errors, failed: true };
		}
	}

	/**
	 * Download global files from the remote dev folder
	 * (assets/, includes/, acf-json/, media-library/, .skylit/ config, theme.json, etc.)
	 * Public so the extension can call this on every connect, not only full sync.
	 */
	async downloadGlobalFiles(): Promise<void> {
		try {
			const result = await this.restClient.getGlobalFiles();

			if (result.count === 0) {
				this.debugLogger.log("📦 No global files found on remote server");
				return;
			}

			let written = 0;
			let skipped = 0;
			for (const file of result.files) {
				try {
					const filePath = path.join(this.localDevPath, file.path);
					const dirPath = path.dirname(filePath);

					if (!fs.existsSync(dirPath)) {
						fs.mkdirSync(dirPath, { recursive: true });
					}

					const content =
						file.encoding === "base64"
							? Buffer.from(file.content, "base64")
							: file.content;

					// Skip write if local file is already identical to avoid
					// triggering watcher events for unchanged content.
					if (fs.existsSync(filePath)) {
						const existing = fs.readFileSync(filePath);
						if (Buffer.isBuffer(content)) {
							if (existing.equals(content)) {
								skipped++;
								continue;
							}
						} else if (existing.toString("utf8") === content) {
							skipped++;
							continue;
						}
					}

					// Tell file watcher we're about to write so it skips the change event
					if (this.onFileWritten) this.onFileWritten(filePath);
					fs.writeFileSync(filePath, content);
					written++;
				} catch (error: any) {
					this.debugLogger.log(
						`⚠️ Failed to write global file ${file.path}: ${error.message}`
					);
				}
			}

			this.debugLogger.log(
				`📦 Global files synced: ${written} written, ${skipped} unchanged (of ${result.count})`
			);
		} catch (error: any) {
			this.debugLogger.log(
				`⚠️ Could not download global files: ${error.message}`
			);
		}
	}

	/**
	 * Create the standard dev folder directory tree locally.
	 * Mirrors the structure that the WP plugin creates server-side in
	 * initialize_dev_folder() / ensure_dev_folder_structure().
	 */
	private ensureLocalFolderStructure(): void {
		const dirs = [
			"post-types/pages",
			"post-types/pages/_trash",
			"post-types/posts",
			"post-types/posts/_trash",
			"templates",
			"templates/_trash",
			"parts",
			"parts/_trash",
			"patterns/synced",
			"patterns/synced/_trash",
			"patterns/unsynced",
			"patterns/unsynced/_trash",
			"includes",
			"assets/css",
			"assets/css/blocks",
			"assets/js",
			"assets/js/components",
			"assets/images",
			"acf-json",
			"taxonomies",
			"media-library",
			".skylit/mappings",
			".skylit/cache",
			".skylit/metadata",
			".skylit/media",
		];

		let created = 0;
		for (const dir of dirs) {
			const fullPath = path.join(this.localDevPath, dir);
			if (!fs.existsSync(fullPath)) {
				fs.mkdirSync(fullPath, { recursive: true });
				created++;
			}
		}

		if (created > 0) {
			this.debugLogger.log(
				`📁 Local folder structure scaffolded: ${created} directories created`
			);
		}
	}

	private schedulePoll(): void {
		if (this.disposed) return;

		this.pollTimer = setTimeout(async () => {
			await this.poll();
			this.schedulePoll();
		}, this.pollIntervalMs);
	}

	private pollCount: number = 0;

	private async poll(): Promise<void> {
		if (this.isPolling || this.disposed) return;
		this.isPolling = true;
		this.pollCount++;

		try {
			const response = await this.restClient.getPendingExports();

			// Log every 20th poll as heartbeat so devs can verify polling is alive
			if (this.pollCount % 20 === 1) {
				this.debugLogger.log(
					`📡 Export poll #${this.pollCount} — pending: ${response.pending.length}, interval: ${this.pollIntervalMs}ms, devPath: ${this.localDevPath}`
				);
			}

			if (response.pending.length > 0) {
				this.debugLogger.info(
					`📥 ${
						response.pending.length
					} pending export(s): [${response.pending.join(", ")}]`
				);

				for (const postId of response.pending) {
					try {
						const payload = await this.restClient.getExportContent(postId);
						this.debugLogger.log(
							`📥 Export payload for post ${postId}: folder=${
								payload.folder_name
							}, type=${payload.type_folder}, html=${
								payload.html?.length || 0
							}b, css=${payload.css?.length || 0}b`
						);
						await this.writeExportLocally(payload);
					} catch (error: any) {
						this.debugLogger.warn(
							`⚠️ Failed to fetch export for post ${postId}: ${error.message}`
						);
					}
				}
			}

			// Also check for pending folder actions (trash/restore/delete)
			await this.processFolderActions();

			this.consecutiveErrors = 0;

			if (response.pending.length > 0) {
				this.consecutiveIdle = 0;
				this.pollIntervalMs = ExportPoller.MIN_INTERVAL;
			} else {
				this.consecutiveIdle++;
				if (this.consecutiveIdle >= ExportPoller.IDLE_POLLS_BEFORE_BACKOFF) {
					this.pollIntervalMs = ExportPoller.IDLE_INTERVAL;
				} else {
					this.pollIntervalMs = ExportPoller.MIN_INTERVAL;
				}
			}
		} catch (error: any) {
			this.consecutiveErrors++;

			if (this.consecutiveErrors >= ExportPoller.MAX_ERRORS_BEFORE_BACKOFF) {
				this.pollIntervalMs = Math.min(
					this.pollIntervalMs * 2,
					ExportPoller.MAX_INTERVAL
				);
				this.debugLogger.warn(
					`⚠️ Export poll error (${this.consecutiveErrors}x): ${error.message}, backing off to ${this.pollIntervalMs}ms`
				);
			} else {
				this.debugLogger.log(`⚠️ Export poll error: ${error.message}`);
			}
		} finally {
			this.isPolling = false;
		}
	}

	/**
	 * Process queued folder actions from WP (trash/restore/delete in decoupled mode).
	 */
	private async processFolderActions(): Promise<void> {
		try {
			const resp = await this.restClient.getPendingFolderActions();
			if (!resp || !resp.actions || resp.actions.length === 0) return;

			this.debugLogger.info(
				`📂 ${resp.actions.length} pending folder action(s)`
			);

			for (const action of resp.actions) {
				const { post_id, slug, type_folder, action: act, old_slug: oldSlug } = action;
				if (!slug || !type_folder) {
					this.debugLogger.log(
						`   ⚠️ Skipping folder action: missing slug/type_folder (post ${post_id})`
					);
					continue;
				}

				const activePath = path.join(this.localDevPath, type_folder, slug);
				const trashDir = path.join(this.localDevPath, type_folder, "_trash");
				const trashPath = path.join(trashDir, slug);

				try {
					if (act === "trash") {
						if (fs.existsSync(activePath)) {
							if (!fs.existsSync(trashDir))
								fs.mkdirSync(trashDir, { recursive: true });
							fs.renameSync(activePath, trashPath);
							this.debugLogger.log(
								`   🗑️ Moved to _trash: ${type_folder}/${slug}`
							);
						}
					} else if (act === "restore") {
						if (fs.existsSync(trashPath)) {
							fs.renameSync(trashPath, activePath);
							this.debugLogger.log(
								`   ♻️ Restored from _trash: ${type_folder}/${slug}`
							);
						}
					} else if (act === "delete") {
						const target = fs.existsSync(trashPath)
							? trashPath
							: fs.existsSync(activePath)
							? activePath
							: null;
						if (target) {
							fs.rmSync(target, { recursive: true, force: true });
							this.debugLogger.log(
								`   🧹 Permanently deleted: ${type_folder}/${slug}`
							);
						}
					} else if (act === "rename") {
						this.applyRenameAction(post_id, type_folder, oldSlug, slug);
					} else {
						this.debugLogger.log(
							`   ⚠️ Unknown folder action '${act}' for post ${post_id} — ignoring`
						);
					}
				} catch (err: any) {
					this.debugLogger.log(
						`   ⚠️ Folder action '${act}' failed for ${slug}: ${err.message}`
					);
				}
			}
		} catch (err: any) {
			// Non-critical — silently ignore if endpoint doesn't exist yet
			if (!err.message?.includes("404")) {
				this.debugLogger.log(`⚠️ Folder actions poll error: ${err.message}`);
			}
		}
	}

	/**
	 * Apply a queued rename action: move <type>/<old> → <type>/<new> (also handles _trash/)
	 * and rename inner <old>.html / <old>.css files to match the new slug.
	 *
	 * Tolerant of "already applied" states: if the source folder doesn't exist but the
	 * destination does (the IDE-driven slug change path), it's treated as a no-op.
	 */
	private applyRenameAction(
		postId: number,
		typeFolder: string,
		oldSlug: string | undefined,
		newSlug: string
	): void {
		if (!oldSlug || oldSlug === newSlug) {
			this.debugLogger.log(
				`   ⚠️ Rename skipped for post ${postId}: missing or unchanged old_slug`
			);
			return;
		}

		const activeOld = path.join(this.localDevPath, typeFolder, oldSlug);
		const activeNew = path.join(this.localDevPath, typeFolder, newSlug);
		const trashDir = path.join(this.localDevPath, typeFolder, "_trash");
		const trashOld = path.join(trashDir, oldSlug);
		const trashNew = path.join(trashDir, newSlug);

		// Determine the source we actually need to rename and the matching destination.
		let src: string | null = null;
		let dest: string | null = null;
		let inTrash = false;

		if (fs.existsSync(activeOld) && fs.statSync(activeOld).isDirectory()) {
			src = activeOld;
			dest = activeNew;
		} else if (fs.existsSync(trashOld) && fs.statSync(trashOld).isDirectory()) {
			src = trashOld;
			dest = trashNew;
			inTrash = true;
		} else {
			// Source missing — likely already-applied (IDE-driven slug change). Confirm via dest.
			const targetAlreadyAt =
				(fs.existsSync(activeNew) && fs.statSync(activeNew).isDirectory()) ||
				(fs.existsSync(trashNew) && fs.statSync(trashNew).isDirectory());
			if (targetAlreadyAt) {
				this.debugLogger.log(
					`   ↪️ Rename ${typeFolder}/${oldSlug} → ${newSlug} already applied, no-op (post ${postId})`
				);
			} else {
				this.debugLogger.log(
					`   ⚠️ Rename source not found for post ${postId}: ${typeFolder}/${oldSlug} (and target also missing)`
				);
			}
			return;
		}

		if (fs.existsSync(dest)) {
			this.debugLogger.log(
				`   ⚠️ Rename target already exists: ${dest} — skipping (manual intervention required)`
			);
			return;
		}

		try {
			fs.renameSync(src, dest);
			this.debugLogger.log(
				`   ✏️ Renamed: ${typeFolder}/${inTrash ? "_trash/" : ""}${oldSlug} → ${newSlug}`
			);
		} catch (err: any) {
			this.debugLogger.log(
				`   ⚠️ Rename failed for ${typeFolder}/${oldSlug} → ${newSlug}: ${err.message}`
			);
			return;
		}

		// Rename inner files that follow the slug-name convention (HTML/CSS).
		const renamePairs: Array<[string, string]> = [
			[`${oldSlug}.html`, `${newSlug}.html`],
			[`${oldSlug}.css`, `${newSlug}.css`],
		];
		for (const [oldName, newName] of renamePairs) {
			const oldFile = path.join(dest, oldName);
			const newFile = path.join(dest, newName);
			if (!fs.existsSync(oldFile)) continue;
			if (fs.existsSync(newFile)) continue; // don't clobber
			try {
				fs.renameSync(oldFile, newFile);
				this.debugLogger.log(`   ✏️ Renamed file: ${oldName} → ${newName}`);
			} catch (err: any) {
				this.debugLogger.log(
					`   ⚠️ Inner file rename failed (${oldName} → ${newName}): ${err.message}`
				);
			}
		}
	}

	/**
	 * Write an export payload to the local dev folder.
	 * Creates the folder structure and writes HTML/CSS files.
	 */
	private async writeExportLocally(payload: ExportPayload): Promise<void> {
		const folderPath = path.join(
			this.localDevPath,
			payload.type_folder,
			payload.folder_name
		);

		if (!fs.existsSync(folderPath)) {
			fs.mkdirSync(folderPath, { recursive: true });
			this.debugLogger.log(`📁 Created folder: ${folderPath}`);
		}

		const htmlFile = path.join(folderPath, `${payload.folder_name}.html`);
		const cssFile = path.join(folderPath, `${payload.folder_name}.css`);

		// Capture cursor position BEFORE writing — the write replaces the file
		// externally and VS Code reloads it, which can move the cursor to EOF.
		const normalizedHtml = htmlFile.replace(/\\/g, "/");
		let savedCursorLine: number | null = null;
		for (const editor of vscode.window.visibleTextEditors) {
			if (editor.document.uri.fsPath.replace(/\\/g, "/") === normalizedHtml) {
				savedCursorLine = editor.selection.active.line;
				break;
			}
		}

		// Try to resolve a better restore line from active-block.txt + payload metadata.
		// The payload carries block line numbers for the NEW file, so we can map the
		// active layoutBlockId to its new line even if the content shifted.
		let blockRestoreLine: number | null = null;
		if (savedCursorLine !== null) {
			try {
				const activeBlockPath = path.join(this.localDevPath, ".skylit", "active-block.txt");
				if (fs.existsSync(activeBlockPath)) {
					const raw = fs.readFileSync(activeBlockPath, "utf8").trim();
					const colonIdx = raw.indexOf(":");
					if (colonIdx > 0) {
						const activePostId = parseInt(raw.substring(0, colonIdx), 10);
						const activeLayoutId = raw.substring(colonIdx + 1);
						if (activePostId === payload.post_id && activeLayoutId && payload.block_changes) {
							const allBlocks = [
								...(payload.block_changes.changed_blocks || []),
								...(payload.block_changes.unchanged_blocks || []),
							];
							const match = allBlocks.find(b => b.layoutBlockId === activeLayoutId);
							if (match && match.line > 0) {
								blockRestoreLine = match.line - 1;
								this.debugLogger.log(
									`🎯 Block-aware restore: layoutBlockId=${activeLayoutId} → line ${match.line}`
								);
							}
						}
					}
				}
			} catch {
				// Ignore — fall back to savedCursorLine
			}
		}

		// Write HTML (check if content actually changed to avoid triggering file watcher)
		let htmlChanged = true;
		if (fs.existsSync(htmlFile)) {
			const existing = fs.readFileSync(htmlFile, "utf8");
			if (existing === payload.html) {
				htmlChanged = false;
			}
		}

		if (htmlChanged) {
			if (this.onFileWritten) this.onFileWritten(htmlFile);
			fs.writeFileSync(htmlFile, payload.html, "utf8");
			this.debugLogger.log(
				`📝 Wrote HTML: ${path.basename(htmlFile)} (${
					payload.html.length
				} bytes)`
			);

			// Restore cursor position after a short delay (VS Code needs time to
			// reload the externally changed file and update the editor).
			const restoreLine = blockRestoreLine ?? savedCursorLine;
			if (restoreLine !== null) {
				const targetLine = restoreLine;
				setTimeout(() => {
					for (const editor of vscode.window.visibleTextEditors) {
						if (editor.document.uri.fsPath.replace(/\\/g, "/") === normalizedHtml) {
							const maxLine = editor.document.lineCount - 1;
							const line = Math.min(targetLine, maxLine);
							const pos = new vscode.Position(line, 0);
							editor.selection = new vscode.Selection(pos, pos);
							editor.revealRange(
								new vscode.Range(pos, pos),
								vscode.TextEditorRevealType.InCenterIfOutsideViewport
							);
							this.debugLogger.log(`🎯 Restored cursor to line ${line + 1} after export write`);
							break;
						}
					}
				}, 300);
			}
		}

		// Write CSS
		if (payload.css) {
			let cssChanged = true;
			if (fs.existsSync(cssFile)) {
				const existing = fs.readFileSync(cssFile, "utf8");
				if (existing === payload.css) {
					cssChanged = false;
				}
			}

			if (cssChanged) {
				if (this.onFileWritten) this.onFileWritten(cssFile);
				fs.writeFileSync(cssFile, payload.css, "utf8");
				this.debugLogger.log(
					`📝 Wrote CSS: ${path.basename(cssFile)} (${
						payload.css.length
					} bytes)`
				);
			}
		}
	}
}
