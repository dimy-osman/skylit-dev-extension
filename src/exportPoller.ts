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

	constructor(
		restClient: RestClient,
		localDevPath: string,
		statusBar: StatusBar,
		debugLogger: DebugLogger
	) {
		this.restClient = restClient;
		this.localDevPath = localDevPath;
		this.statusBar = statusBar;
		this.debugLogger = debugLogger;
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

		try {
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
	 * (assets/, includes/, acf-json/, theme.json, etc.)
	 */
	private async downloadGlobalFiles(): Promise<void> {
		try {
			const result = await this.restClient.getGlobalFiles();

			if (result.count === 0) {
				this.debugLogger.log("📦 No global files found on remote server");
				return;
			}

			let written = 0;
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

					fs.writeFileSync(filePath, content);
					written++;
				} catch (error: any) {
					this.debugLogger.log(
						`⚠️ Failed to write global file ${file.path}: ${error.message}`
					);
				}
			}

			this.debugLogger.log(
				`📦 Global files synced: ${written}/${result.count} written`
			);
		} catch (error: any) {
			this.debugLogger.log(
				`⚠️ Could not download global files: ${error.message}`
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
				const { post_id, slug, type_folder, action: act } = action;
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
