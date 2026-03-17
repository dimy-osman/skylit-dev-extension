/**
 * Skylit Dev I/O - VS Code/Cursor Extension
 * Main entry point
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { WorkspaceManager } from "./workspaceManager";
import { AuthManager } from "./authManager";
import { FileWatcher } from "./fileWatcher";
import { RestClient } from "./restClient";
import { StatusBar } from "./statusBar";
import { ProtocolHandler } from "./protocolHandler";
import { DebugLogger } from "./debugLogger";
import { PostTypeConverter } from "./postTypeConverter";
import { ConnectionState } from "./types";
import { InstanceAttributeGuard } from "./instanceAttributeGuard";
import { ExportPoller } from "./exportPoller";
import { AiSkillsetGenerator } from "./aiSkillsetGenerator";

let workspaceManager: WorkspaceManager;
let authManager: AuthManager;
let fileWatcher: FileWatcher | null = null;
let restClient: RestClient | null = null;
let statusBar: StatusBar;
let protocolHandler: ProtocolHandler;
let debugLogger: DebugLogger;
let postTypeConverter: PostTypeConverter | null = null;
let instanceAttributeGuard: InstanceAttributeGuard | null = null;
let exportPoller: ExportPoller | null = null;
let aiSkillsetGenerator: AiSkillsetGenerator | null = null;
let statusCheckInterval: NodeJS.Timeout | null = null;
let metadataCleanupInterval: NodeJS.Timeout | null = null;
let relocatePollingInterval: NodeJS.Timeout | null = null;
let workspaceLockHeartbeatInterval: NodeJS.Timeout | null = null;
let currentDevPath: string | null = null;
let isRemoteMode: boolean = false;
let connectionInProgress: boolean = false;
let lastConnectedSiteUrl: string | null = null;
let hasWorkspaceLock: boolean = false;
let currentWorkspaceLockPath: string | null = null;
const WORKSPACE_LOCK_FILE = ".skylit/.extension-lock.json";
const WORKSPACE_LOCK_STALE_MS = 45000;
const WORKSPACE_LOCK_HEARTBEAT_MS = 10000;
const workspaceSessionId = `${process.pid}-${Date.now()}-${Math.random()
	.toString(36)
	.slice(2, 8)}`;

/**
 * Get Skylit config scoped to the current workspace so the active site is per-workspace.
 * When a workspace folder is open, only Workspace settings are used (User value is ignored).
 * When no folder is open, falls back to effective config.
 */
function getWorkspaceSkylitConfig(): vscode.WorkspaceConfiguration {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (folder) {
		return vscode.workspace.getConfiguration("skylit", folder.uri);
	}
	return vscode.workspace.getConfiguration("skylit");
}

/**
 * Get workspace-scoped siteUrl only (ignores user-level settings).
 * This ensures the extension only connects when the workspace explicitly configures a site.
 * Returns undefined if no workspace is open or if siteUrl is only set at user level.
 */
function getWorkspaceSiteUrl(): string | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return undefined; // No workspace = no connection
	}
	
	// Inspect the configuration to separate workspace-level from user-level values
	const inspection = vscode.workspace.getConfiguration("skylit", folder.uri)
		.inspect<string>("siteUrl");
	
	// Only return workspace-level value (ignore user-level)
	const workspaceValue = inspection?.workspaceValue?.trim();
	const workspaceFolderValue = inspection?.workspaceFolderValue?.trim();
	
	return workspaceFolderValue || workspaceValue || undefined;
}

/**
 * Check if user has a user-level siteUrl configured (which should be migrated to workspace).
 * Returns the user-level value if found, undefined otherwise.
 */
function getUserLevelSiteUrl(): string | undefined {
	const inspection = vscode.workspace.getConfiguration("skylit")
		.inspect<string>("siteUrl");
	
	return inspection?.globalValue?.trim() || undefined;
}

/**
 * Extension activation
 */
export async function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel("Skylit.DEV I/O");
	debugLogger = new DebugLogger(outputChannel);
	debugLogger.info("🚀 Skylit.DEV I/O extension activated");

	// Initialize managers
	workspaceManager = new WorkspaceManager(debugLogger);
	authManager = new AuthManager(context, debugLogger);
	statusBar = new StatusBar(debugLogger);
	protocolHandler = new ProtocolHandler(debugLogger);

	// Register protocol handler
	protocolHandler.register(context);

	// Start instance attribute guard IMMEDIATELY (before connection).
	// It uses content-based detection (no REST API needed), so it can
	// protect pattern instance tags from the moment the editor opens.
	if (instanceAttributeGuard) {
		instanceAttributeGuard.dispose();
	}
	instanceAttributeGuard = new InstanceAttributeGuard("", debugLogger);
	instanceAttributeGuard.start();

	// Register commands
	registerCommands(context);

	// Check if a site URL is configured at WORKSPACE level only (not user level)
	// This ensures the extension only connects when the workspace explicitly configures a site
	const workspaceSiteUrl = getWorkspaceSiteUrl();
	const userLevelSiteUrl = getUserLevelSiteUrl();

	// Warn if user has user-level siteUrl configured
	if (userLevelSiteUrl && !workspaceSiteUrl) {
		debugLogger.warn("⚠️ User-level siteUrl detected but ignored");
		debugLogger.warn(`   User-level value: ${userLevelSiteUrl}`);
		debugLogger.info("💡 Configure skylit.siteUrl in workspace settings to connect");
		debugLogger.info("   User-level siteUrl is ignored to prevent unwanted connections across workspaces");
		
		// Show a one-time notification to help users migrate
		const hasShownMigrationWarning = context.globalState.get<boolean>('skylit.hasShownMigrationWarning', false);
		if (!hasShownMigrationWarning) {
			vscode.window.showInformationMessage(
				`Skylit: User-level siteUrl detected (${userLevelSiteUrl}). For workspace-specific connections, move this to Workspace Settings.`,
				"Open Settings",
				"Don't Show Again"
			).then(async (selection) => {
				if (selection === "Open Settings") {
					vscode.commands.executeCommand("workbench.action.openWorkspaceSettings", "skylit.siteUrl");
				} else if (selection === "Don't Show Again") {
					await context.globalState.update('skylit.hasShownMigrationWarning', true);
				}
			});
		}
		
		statusBar.updateStatus("disconnected", "Configure workspace siteUrl");
		return;
	}

	if (workspaceSiteUrl) {
		// URL-based connection: site URL is configured at workspace level, connect to it.
		// Whether we're in remote/decoupled mode is determined AFTER connecting,
		// based on the plugin's dev_folder_location setting.
		debugLogger.info("🌐 Workspace-level siteUrl configured");
		debugLogger.log(`   Site URL: ${workspaceSiteUrl}`);

		const remoteSite = {
			name: new URL(workspaceSiteUrl).hostname,
			path: "",
			siteUrl: workspaceSiteUrl,
			devFolder: "",
		};

		const config = getWorkspaceSkylitConfig();
		const autoConnect = config.get<boolean>("autoConnect", true);

		if (autoConnect) {
			try {
				await connectToWordPress(remoteSite, context, true);
			} catch (error: any) {
				debugLogger.warn(`⚠️ Auto-connect failed: ${error.message}`);
				statusBar.updateStatus(
					"disconnected",
					"Connect failed - Click to retry"
				);
			}
		} else {
			statusBar.updateStatus("disconnected", "Click to connect to WordPress");
		}

		return;
	}

	// Local mode: detect WordPress sites in workspace
	const sites = await workspaceManager.detectWordPressSites();

	if (sites.length === 0) {
		debugLogger.warn("⚠️ No WordPress sites with Skylit.DEV plugin detected");
		debugLogger.info("ℹ️ Make sure:");
		debugLogger.info(
			"   1. WordPress is in your workspace (or in a subdirectory like public_html/)"
		);
		debugLogger.info("   2. Skylit.DEV plugin is installed and activated");
		debugLogger.info(
			"   3. Or configure skylit.siteUrl + skylit.localDevPath for remote mode"
		);
		statusBar.updateStatus("disconnected", "No Skylit.DEV detected");

		vscode.window
			.showWarningMessage(
				"Skylit.DEV plugin not detected. Install locally or use 'Skylit: Connect to Remote WordPress' for remote mode.",
				"Connect Remote",
				"Learn More"
			)
			.then((selection) => {
				if (selection === "Learn More") {
					vscode.env.openExternal(
						vscode.Uri.parse("https://skylit.dev/docs/getting-started")
					);
				} else if (selection === "Connect Remote") {
					vscode.commands.executeCommand("skylit.connectRemote");
				}
			});

		return;
	}

	debugLogger.info(
		`✅ Detected ${sites.length} WordPress site(s) with Skylit.DEV plugin`
	);
	sites.forEach((site) => {
		debugLogger.log(`   - ${site.name}: ${site.siteUrl}`);
	});

	const config = getWorkspaceSkylitConfig();
	const autoConnect = config.get<boolean>("autoConnect", true);

	if (autoConnect) {
		debugLogger.log("🔄 Auto-connect enabled, attempting connection...");

		const siteToConnect = sites[0];

		try {
			await connectToWordPress(siteToConnect, context, true);
		} catch (error: any) {
			debugLogger.warn(`⚠️ Auto-connect failed: ${error.message}`);
			debugLogger.info(
				'💡 You can manually connect by clicking the status bar or running "Skylit: Connect"'
			);
			statusBar.updateStatus(
				"disconnected",
				"Auto-connect failed - Click to retry"
			);
		}
	} else {
		debugLogger.log("ℹ️ Auto-connect disabled in settings");
		statusBar.updateStatus("disconnected", "Click to connect to WordPress");
	}
}

/**
 * Extension deactivation
 */
export function deactivate() {
	// Stop status check interval
	if (statusCheckInterval) {
		clearInterval(statusCheckInterval);
		statusCheckInterval = null;
	}

	// Stop metadata cleanup interval
	if (metadataCleanupInterval) {
		clearInterval(metadataCleanupInterval);
		metadataCleanupInterval = null;
	}

	// Stop relocate polling
	stopRelocatePolling();
	stopWorkspaceLockHeartbeat();
	void releaseWorkspaceLock();

	if (fileWatcher) {
		fileWatcher.dispose();
	}
	if (exportPoller) {
		exportPoller.dispose();
		exportPoller = null;
	}
	if (instanceAttributeGuard) {
		instanceAttributeGuard.dispose();
		instanceAttributeGuard = null;
	}
	if (postTypeConverter) {
		postTypeConverter.dispose();
	}
	if (statusBar) {
		statusBar.dispose();
	}
	debugLogger.info("👋 Skylit.DEV I/O extension deactivated");
	debugLogger.dispose();
}

async function ensureWorkspaceLock(devPath: string): Promise<boolean> {
	try {
		const lockPath = path.join(devPath, ...WORKSPACE_LOCK_FILE.split("/"));
		currentWorkspaceLockPath = lockPath;

		const lockDir = path.dirname(lockPath);
		if (!fs.existsSync(lockDir)) {
			fs.mkdirSync(lockDir, { recursive: true });
		}

		let existing: any = null;
		if (fs.existsSync(lockPath)) {
			try {
				existing = JSON.parse(fs.readFileSync(lockPath, "utf8"));
			} catch {
				existing = null;
			}
		}

		const now = Date.now();
		const existingHeartbeat = Number(existing?.heartbeat || 0);
		const isStale =
			!existing ||
			!existing.sessionId ||
			now - existingHeartbeat > WORKSPACE_LOCK_STALE_MS;
		const isOwnedByCurrent = existing?.sessionId === workspaceSessionId;

		if (!isStale && !isOwnedByCurrent) {
			const owner = existing.window || existing.pid || existing.sessionId;
			vscode.window.showWarningMessage(
				`Skylit: This dev folder is already connected in another window (${owner}). Close that window or wait for lock timeout.`
			);
			hasWorkspaceLock = false;
			return false;
		}

		const payload = {
			sessionId: workspaceSessionId,
			pid: process.pid,
			window: vscode.env.appName,
			devPath,
			siteUrl: lastConnectedSiteUrl || "",
			createdAt: existing?.createdAt || now,
			heartbeat: now,
		};

		fs.writeFileSync(lockPath, JSON.stringify(payload, null, 2), "utf8");
		hasWorkspaceLock = true;
		startWorkspaceLockHeartbeat(devPath);
		return true;
	} catch (error: any) {
		debugLogger.warn(`⚠️ Could not create workspace lock: ${error.message}`);
		return false;
	}
}

function startWorkspaceLockHeartbeat(devPath: string) {
	stopWorkspaceLockHeartbeat();
	workspaceLockHeartbeatInterval = setInterval(async () => {
		if (!hasWorkspaceLock) return;
		try {
			await ensureWorkspaceLock(devPath);
		} catch {}
	}, WORKSPACE_LOCK_HEARTBEAT_MS);
}

function stopWorkspaceLockHeartbeat() {
	if (workspaceLockHeartbeatInterval) {
		clearInterval(workspaceLockHeartbeatInterval);
		workspaceLockHeartbeatInterval = null;
	}
}

async function releaseWorkspaceLock() {
	try {
		if (!currentWorkspaceLockPath || !fs.existsSync(currentWorkspaceLockPath)) {
			hasWorkspaceLock = false;
			return;
		}
		const current = JSON.parse(fs.readFileSync(currentWorkspaceLockPath, "utf8"));
		if (current?.sessionId === workspaceSessionId) {
			fs.unlinkSync(currentWorkspaceLockPath);
		}
	} catch {}
	hasWorkspaceLock = false;
}

/**
 * Register command palette actions
 */
function registerCommands(context: vscode.ExtensionContext) {
	// Scan for WordPress command
	context.subscriptions.push(
		vscode.commands.registerCommand("skylit.scanWorkspace", async () => {
			debugLogger.show(); // Show output channel
			debugLogger.log("🔍 Manual WordPress scan triggered...");

			const sites = await workspaceManager.detectWordPressSites();

			if (sites.length === 0) {
				vscode.window
					.showWarningMessage(
						"No WordPress sites with Skylit.DEV plugin found. Check Output panel for details.",
						"View Output"
					)
					.then((selection) => {
						if (selection === "View Output") {
							debugLogger.show();
						}
					});
				return;
			}

			vscode.window
				.showInformationMessage(
					`Found ${sites.length} WordPress site(s) with Skylit.DEV plugin!`,
					"Connect Now",
					"Setup Token"
				)
				.then((selection) => {
					if (selection === "Connect Now") {
						vscode.commands.executeCommand("skylit.connect");
					} else if (selection === "Setup Token") {
						vscode.commands.executeCommand("skylit.setupToken");
					}
				});
		})
	);

	// Connect command
	context.subscriptions.push(
		vscode.commands.registerCommand("skylit.connect", async () => {
			debugLogger.log("🔌 Manual connection requested...");

			const sites = await workspaceManager.detectWordPressSites();

			if (sites.length === 0) {
				vscode.window
					.showErrorMessage(
						"No WordPress sites found in workspace",
						"Scan Workspace"
					)
					.then((selection) => {
						if (selection === "Scan Workspace") {
							vscode.commands.executeCommand("skylit.scanWorkspace");
						}
					});
				return;
			}

			// If multiple sites, let user choose
			let selectedSite = sites[0];
			if (sites.length > 1) {
				const choice = await vscode.window.showQuickPick(
					sites.map((s) => ({
						label: s.name,
						description: s.siteUrl,
						site: s,
					})),
					{
						placeHolder: "Select WordPress site to connect",
					}
				);
				if (!choice) return;
				selectedSite = choice.site;
			}

			await connectToWordPress(selectedSite, context, false); // Pass false for manual connection
		})
	);

	// Disconnect command
	context.subscriptions.push(
		vscode.commands.registerCommand("skylit.disconnect", async () => {
			// Stop status check interval
			if (statusCheckInterval) {
				clearInterval(statusCheckInterval);
				statusCheckInterval = null;
			}

			// Stop jump polling
			stopJumpPolling();

			// Stop relocate polling
			stopRelocatePolling();
			stopWorkspaceLockHeartbeat();
			await releaseWorkspaceLock();

			// Stop metadata cleanup
			stopMetadataCleanup();

			if (fileWatcher) {
				fileWatcher.dispose();
				fileWatcher = null;
			}
			if (instanceAttributeGuard) {
				instanceAttributeGuard.dispose();
				instanceAttributeGuard = null;
			}
			if (postTypeConverter) {
				postTypeConverter.dispose();
				postTypeConverter = null;
			}
			restClient = null;
			currentDevPath = null;
			statusBar.updateStatus("disconnected", "Disconnected");
			debugLogger.info("🔌 Disconnected from WordPress");
		})
	);

	// Setup token command — supports multiple domain/token pairs
	context.subscriptions.push(
		vscode.commands.registerCommand("skylit.setupToken", async () => {
			// Build picker items from registered sites + detected sites + manual entry
			const registeredSites = await authManager.getSitesWithTokens();
			const detectedSites = await workspaceManager.detectWordPressSites();

			const config = getWorkspaceSkylitConfig();
			const configuredUrl = config.get<string>("siteUrl", "").trim();

			const items: Array<{
				label: string;
				description: string;
				detail?: string;
				siteUrl?: string;
				isManual?: boolean;
			}> = [];

			// Registered sites (already paired domains)
			for (const rs of registeredSites) {
				items.push({
					label: `$(globe) ${rs.name}`,
					description: rs.url,
					detail: rs.hasToken ? "Token saved — replace?" : "No token saved",
					siteUrl: rs.url,
				});
			}

			// Detected local sites not already in registry
			for (const ds of detectedSites) {
				const alreadyListed = registeredSites.some(
					(r) =>
						r.url.replace(/^https?:\/\//, "").replace(/\/$/, "") ===
						ds.siteUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")
				);
				if (!alreadyListed) {
					items.push({
						label: `$(server) ${ds.name}`,
						description: ds.siteUrl,
						detail: "Detected in workspace",
						siteUrl: ds.siteUrl,
					});
				}
			}

			// Configured URL not already listed
			if (
				configuredUrl &&
				!items.some(
					(i) =>
						i.siteUrl?.replace(/^https?:\/\//, "").replace(/\/$/, "") ===
						configuredUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")
				)
			) {
				items.push({
					label: `$(settings-gear) ${configuredUrl}`,
					description: "From skylit.siteUrl setting",
					siteUrl: configuredUrl,
				});
			}

			// Manual entry option always last
			items.push({
				label: "$(add) Enter a new site URL...",
				description: "Pair a new WordPress domain",
				isManual: true,
			});

			const choice = await vscode.window.showQuickPick(items, {
				placeHolder: "Select a site to set up auth token for",
				matchOnDescription: true,
			});

			if (!choice) return;

			let siteUrl: string;

			if (choice.isManual) {
				const inputUrl = await vscode.window.showInputBox({
					prompt: "Enter the WordPress site URL",
					placeHolder: "https://mysite.com",
					ignoreFocusOut: true,
					validateInput: (value) => {
						if (!value.trim()) return "URL is required";
						try {
							new URL(value.trim());
						} catch {
							return "Invalid URL format";
						}
						return null;
					},
				});
				if (!inputUrl) return;
				siteUrl = inputUrl.trim().replace(/\/$/, "");
			} else {
				siteUrl = choice.siteUrl!;
			}

			const siteName = (() => {
				try {
					return new URL(siteUrl).hostname;
				} catch {
					return siteUrl;
				}
			})();

			const token = await vscode.window.showInputBox({
				prompt: `Enter auth token for ${siteName}`,
				placeHolder: "skylit_abc123...",
				password: true,
				ignoreFocusOut: true,
			});

			if (!token) return;

			await authManager.saveToken(siteUrl, token);
			await authManager.registerSite(siteUrl, siteName);
			debugLogger.info(`✅ Auth token saved for ${siteName}! Connecting...`);

			// Ask whether to switch the active site to this one
			const shouldConnect = await vscode.window.showInformationMessage(
				`Token saved for ${siteName}. Connect to this site now?`,
				"Connect",
				"Just Save"
			);

			if (shouldConnect === "Connect") {
				// Update the workspace setting so the extension connects to this site
				await config.update(
					"siteUrl",
					siteUrl,
					vscode.ConfigurationTarget.Workspace
				);

				const site = {
					name: siteName,
					path: "",
					siteUrl: siteUrl,
					devFolder: "",
				};

				await connectToWordPress(site, context);
			}
		})
	);

	// Sync current file command
	context.subscriptions.push(
		vscode.commands.registerCommand("skylit.syncNow", async () => {
			if (!restClient) {
				vscode.window.showErrorMessage("Not connected to WordPress");
				return;
			}

			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showWarningMessage("No file open");
				return;
			}

			const filePath = editor.document.uri.fsPath;
			debugLogger.log(`🔄 Manually syncing: ${filePath}`);

			// Trigger file watcher sync
			if (fileWatcher) {
				await fileWatcher.syncFile(filePath);
			}
		})
	);

	// Repair metadata command (opt-in, not automatic on connection)
	context.subscriptions.push(
		vscode.commands.registerCommand("skylit.repairMetadata", async () => {
			if (!fileWatcher) {
				vscode.window.showErrorMessage("Not connected to WordPress");
				return;
			}

			const pending = fileWatcher.pendingMetadataRepairs.length;
			if (pending === 0) {
				vscode.window.showInformationMessage(
					"No metadata repairs pending. Connect first, then run this command if the startup sync finds posts with empty block metadata."
				);
				return;
			}

			const confirm = await vscode.window.showWarningMessage(
				`Repair block metadata for ${pending} posts? This will fetch content from WordPress and may take a while.`,
				"Repair Now",
				"Cancel"
			);
			if (confirm !== "Repair Now") return;

			const result = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: `Repairing metadata for ${pending} posts...`,
					cancellable: false,
				},
				() => fileWatcher!.repairMetadata()
			);

			vscode.window.showInformationMessage(
				`Metadata repair: ${result.repaired} repaired, ${result.failed} failed`
			);
		})
	);

	// Repair blocks: force re-import current page from HTML file
	context.subscriptions.push(
		vscode.commands.registerCommand("skylit.repairBlocks", async () => {
			if (!restClient || !fileWatcher) {
				vscode.window.showErrorMessage("Not connected to WordPress");
				return;
			}

			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showErrorMessage(
					"Open an HTML file first to repair its blocks"
				);
				return;
			}

			// Use the document's own URI — works for both local and remote SSH workspaces.
			const docUri  = editor.document.uri;
			const filePath = docUri.fsPath;
			const postId = fileWatcher.getPostIdForFile(filePath);
			if (!postId) {
				vscode.window.showErrorMessage(
					"Could not determine post ID for this file"
				);
				return;
			}

			const confirm = await vscode.window.showWarningMessage(
				`Force re-import post ${postId} from file? This will recompile all blocks.`,
				"Repair Now",
				"Cancel"
			);
			if (confirm !== "Repair Now") return;

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: `Repairing blocks for post ${postId}...`,
					cancellable: false,
				},
				async () => {
					try {
						// Read via the document URI so remote SSH paths work correctly.
						const html = await vscode.workspace.fs.readFile(docUri);
						const htmlStr = Buffer.from(html).toString("utf-8");

						// Build CSS URI from document URI (swap .html → .css, keep same scheme/authority).
						const cssUri = docUri.with({
							path: docUri.path.replace(/\.html$/, ".css"),
						});
						let cssStr = "";
						try {
							const css = await vscode.workspace.fs.readFile(cssUri);
							cssStr = Buffer.from(css).toString("utf-8");
						} catch {
							// No CSS file — that's fine
						}

						const result = await restClient!.forceSyncFile(
							postId,
							htmlStr,
							cssStr
						);
						vscode.window.showInformationMessage(
							`Blocks repaired: ${result.blocks_updated || 0} blocks compiled`
						);
					} catch (error: any) {
						vscode.window.showErrorMessage(
							`Repair failed: ${error.message}`
						);
					}
				}
			);
		})
	);

	// Repair all: clear all sync hashes to force re-import
	context.subscriptions.push(
		vscode.commands.registerCommand("skylit.repairAll", async () => {
			if (!restClient) {
				vscode.window.showErrorMessage("Not connected to WordPress");
				return;
			}

			const confirm = await vscode.window.showWarningMessage(
				"Clear all sync hashes? All posts will be re-imported from their HTML files on the next sync cycle.",
				"Clear Hashes",
				"Cancel"
			);
			if (confirm !== "Clear Hashes") return;

			try {
				const result = await restClient.repairAll();
				vscode.window.showInformationMessage(
					`${result.hashes_cleared} sync hashes cleared. Re-connect or save a file to trigger re-import.`
				);
			} catch (error: any) {
				vscode.window.showErrorMessage(
					`Repair-all failed: ${error.message}`
				);
			}
		})
	);

	// Repair CSS storage for current page post (DB-side normalization and cleanup)
	context.subscriptions.push(
		vscode.commands.registerCommand("skylit.repairCssStorage", async () => {
			if (!restClient || !fileWatcher) {
				vscode.window.showErrorMessage("Not connected to WordPress");
				return;
			}

			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showErrorMessage(
					"Open an HTML file first to repair CSS storage"
				);
				return;
			}

			const filePath = editor.document.uri.fsPath;
			const postId = fileWatcher.getPostIdForFile(filePath);
			if (!postId) {
				vscode.window.showErrorMessage(
					"Could not determine post ID for this file"
				);
				return;
			}

			const confirm = await vscode.window.showWarningMessage(
				`Repair CSS storage for post ${postId}? This normalizes corrupted CSS in database block attrs and inline <style> content.`,
				"Repair CSS",
				"Cancel"
			);
			if (confirm !== "Repair CSS") return;

			try {
				const result = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: `Repairing CSS storage for post ${postId}...`,
						cancellable: false,
					},
					() => restClient!.repairCssStorage(postId)
				);

				if (result?.changed) {
					const stats = result.stats || {};
					vscode.window.showInformationMessage(
						`CSS repaired for post ${postId}. attrs:${stats.style_attrs || 0}, inline:${stats.inline_attrs || 0}, style-tags:${stats.style_tags || 0}, removed-empty:${stats.removed_empty_styles || 0}`
					);
				} else {
					vscode.window.showInformationMessage(
						`No CSS storage repairs needed for post ${postId}.`
					);
				}
			} catch (error: any) {
				vscode.window.showErrorMessage(
					`CSS repair failed: ${error.message}`
				);
			}
		})
	);

	// Repair CSS storage for all posts using server-side batched cursor pagination.
	context.subscriptions.push(
		vscode.commands.registerCommand("skylit.repairCssStorageAll", async () => {
			if (!restClient) {
				vscode.window.showErrorMessage("Not connected to WordPress");
				return;
			}

			const mode = await vscode.window.showQuickPick(
				[
					{
						label: "DB + GT only (Recommended)",
						description: "Fastest, lowest memory use",
						refreshFiles: false,
						limit: 20,
					},
					{
						label: "DB + GT + Dev Files",
						description:
							"Also rebuild/write canonical HTML+CSS files (slower)",
						refreshFiles: true,
						limit: 10,
					},
				],
				{
					placeHolder: "Select repair scope for all posts",
				}
			);
			if (!mode) return;

			const confirm = await vscode.window.showWarningMessage(
				`Repair CSS storage across all posts in batches? Mode: ${mode.label}.`,
				"Run Batch Repair",
				"Cancel"
			);
			if (confirm !== "Run Batch Repair") return;

			try {
				let cursor = 0;
				let hasMore = true;
				let batches = 0;
				let totalProcessed = 0;
				let totalRepaired = 0;
				let totalUnchanged = 0;
				let totalSkipped = 0;
				let totalFailed = 0;

				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: "Repairing CSS storage (all posts)...",
						cancellable: false,
					},
					async (progress) => {
						while (hasMore) {
							batches++;
							progress.report({
								message: `Batch ${batches} (cursor ${cursor})`,
							});

							const batch = await restClient!.repairCssStorageAllBatch(
								cursor,
								mode.limit,
								mode.refreshFiles
							);

							const summary = batch?.summary || {};
							totalProcessed += Number(summary.processed || 0);
							totalRepaired += Number(summary.repaired || 0);
							totalUnchanged += Number(summary.unchanged || 0);
							totalSkipped += Number(summary.skipped || 0);
							totalFailed += Number(summary.failed || 0);

							hasMore = Boolean(batch?.has_more);
							cursor = Number(batch?.next_cursor || 0);
						}
					}
				);

				vscode.window.showInformationMessage(
					`CSS batch repair complete: processed ${totalProcessed}, repaired ${totalRepaired}, unchanged ${totalUnchanged}, skipped ${totalSkipped}, failed ${totalFailed}.`
				);
			} catch (error: any) {
				vscode.window.showErrorMessage(
					`CSS batch repair failed: ${error.message}`
				);
			}
		})
	);

	// Convert post type command (for manually triggering post type conversion)
	context.subscriptions.push(
		vscode.commands.registerCommand("skylit.convertPostType", async () => {
			if (!restClient) {
				vscode.window.showErrorMessage("Not connected to WordPress");
				return;
			}

		// Get current folder from explorer or active editor
		let folderPath: string | undefined;

		// Check if the user has a folder selected in the explorer
		const explorerSelection =
			vscode.window.activeTextEditor?.document.uri.fsPath;
		if (explorerSelection) {
			folderPath = path.dirname(explorerSelection);
		}

		const detectedFolderName = folderPath ? path.basename(folderPath) : "";

		// Prompt user to enter/confirm folder name (no longer requires _ID suffix)
		const folderName = await vscode.window.showInputBox({
			prompt: "Enter the folder name (e.g., service or service_549)",
			placeHolder: "my-page",
			value: detectedFolderName,
		});

		if (!folderName) {
			return;
		}

		// Resolve post ID — try metadata cache first, then legacy _ID suffix
		let postId: number | null = null;
		if (fileWatcher && folderPath) {
			const htmlFile = path.join(folderPath, path.basename(folderPath) + ".html");
			postId = fileWatcher.getPostIdForFile(htmlFile);
		}
		if (!postId) {
			const match = folderName.match(/_(\d+)$/);
			if (match) postId = parseInt(match[1]);
		}
		if (!postId) {
			vscode.window.showErrorMessage(
				`Could not find a WordPress post for folder "${folderName}". Make sure the extension is connected and the folder is tracked.`
			);
			return;
		}

			// Ask what post type to convert to
			const postTypeOptions = [
				{
					label: "Page",
					description: "post-types/pages",
					value: "page",
				},
				{
					label: "Post",
					description: "post-types/posts",
					value: "post",
				},
				{
					label: "Template",
					description: "templates",
					value: "wp_template",
				},
				{
					label: "Template Part",
					description: "parts",
					value: "wp_template_part",
				},
				{
					label: "Pattern",
					description: "patterns",
					value: "wp_block",
				},
			];

			const targetType = await vscode.window.showQuickPick(postTypeOptions, {
				placeHolder: "Select the target post type",
			});

			if (!targetType) {
				return;
			}

			// Confirm with user
			const confirm = await vscode.window.showWarningMessage(
				`Convert post ID ${postId} to "${targetType.label}"?`,
				{ modal: true },
				"Convert"
			);

			if (confirm !== "Convert") {
				return;
			}

			try {
				debugLogger.log(`Converting post ${postId} to ${targetType.value}`);

				const response = await restClient.convertPostType(
					postId,
					targetType.value,
					folderName
				);

				if (response.success) {
					vscode.window.showInformationMessage(
						`✅ Post converted to ${targetType.label}!`
					);
				} else {
					vscode.window.showErrorMessage(
						`Failed to convert: ${response.message || "Unknown error"}`
					);
				}
			} catch (error: any) {
				vscode.window.showErrorMessage(
					`Failed to convert post type: ${error.message}`
				);
			}
		})
	);

	// Request WordPress ID command (create post for folder without valid ID)
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"skylit.requestPostId",
			async (uri?: vscode.Uri) => {
				if (!restClient) {
					vscode.window.showErrorMessage("Not connected to WordPress");
					return;
				}

				if (!currentDevPath) {
					vscode.window.showErrorMessage("Dev folder not configured");
					return;
				}

				// Get folder path from context menu, explorer selection, or active editor
				let folderPath: string | undefined;

				if (uri) {
					// Called from context menu on a folder/file
					folderPath = uri.fsPath;
					// If it's a file, get its parent folder
					if (path.extname(folderPath)) {
						folderPath = path.dirname(folderPath);
					}
				} else {
					// Try to get from active editor
					const editor = vscode.window.activeTextEditor;
					if (editor) {
						folderPath = path.dirname(editor.document.uri.fsPath);
					}
				}

				// Normalize path
				folderPath = folderPath?.replace(/\\/g, "/");

				if (!folderPath) {
					vscode.window.showErrorMessage(
						"No folder selected. Open a file or right-click on a folder."
					);
					return;
				}

				const folderName = path.basename(folderPath);

				// Determine post type from folder location
				// Normalize dev path - remove trailing slash before adding one
				const normalizedDevPath = currentDevPath
					.replace(/\\/g, "/")
					.replace(/\/+$/, "");
				const relativePath = folderPath.replace(normalizedDevPath + "/", "");
				let postType: string;

				if (relativePath.startsWith("post-types/pages/")) {
					postType = "page";
				} else if (relativePath.startsWith("post-types/posts/")) {
					postType = "post";
				} else if (relativePath.startsWith("templates/")) {
					postType = "wp_template";
				} else if (relativePath.startsWith("parts/")) {
					postType = "wp_template_part";
				} else if (relativePath.startsWith("patterns/")) {
					postType = "wp_block";
				} else {
					// Ask user for post type
					const typeChoice = await vscode.window.showQuickPick(
						[
							{
								label: "Page",
								value: "page",
							},
							{
								label: "Post",
								value: "post",
							},
							{
								label: "Template",
								value: "wp_template",
							},
							{
								label: "Template Part",
								value: "wp_template_part",
							},
							{
								label: "Pattern",
								value: "wp_block",
							},
						],
						{
							placeHolder: "Select post type for this folder",
						}
					);

					if (!typeChoice) return;
					postType = typeChoice.value;
				}

				const slug = folderName;

				// Confirm with user
				const confirm = await vscode.window.showWarningMessage(
					`Create WordPress ${postType} from "${folderName}"?`,
					{
						modal: true,
						detail: `This will create a new ${postType} in WordPress with slug "${slug}" and write metadata.`,
					},
					"Create Post",
					"Cancel"
				);

				if (confirm !== "Create Post") {
					return;
				}

				try {
					debugLogger.log(`📄 Creating ${postType} for folder: ${folderName}`);

					// Call REST API to create post (slug-only, no rename needed)
					const response = await restClient.createPostFromFolder(
						relativePath,
						postType
					);

					if (response.success) {
						const newId = response.post_id;
						const newFolder = response.new_folder || slug;

						vscode.window.showInformationMessage(
							`✅ Created ${postType} "${response.title}" (ID: ${newId})`
						);

						debugLogger.log(
							`✅ Post created: ID=${newId}, folder renamed to ${newFolder}`
						);

						if (response.new_folder) {
							// response.new_folder is a slug-only relative path like:
							// - "patterns/synced/my-pattern"
							// - "templates/page"
							// - "post-types/pages/about"
							let newBasePath: string;
							if (
								response.new_folder.startsWith("patterns/") ||
								response.new_folder.startsWith("templates/") ||
								response.new_folder.startsWith("parts/") ||
								response.new_folder.startsWith("post-types/")
							) {
								// Server returned full relative path
								newBasePath = response.new_folder;
							} else if (postType === "wp_template") {
								newBasePath = `templates/${response.new_folder}`;
							} else if (postType === "wp_template_part") {
								newBasePath = `parts/${response.new_folder}`;
							} else if (postType === "wp_block") {
								// Fallback - shouldn't happen with updated server
								newBasePath = `patterns/synced/${response.new_folder}`;
							} else {
								newBasePath = `post-types/${postType}s/${response.new_folder}`;
							}

							// Extract just the folder name from the path for the HTML filename
							const newFolderName =
								response.new_folder.split("/").pop() || response.new_folder;
							const newHtmlPath = path.join(
								currentDevPath,
								newBasePath,
								`${newFolderName}.html`
							);

							// Try to open the new file
							try {
								const doc = await vscode.workspace.openTextDocument(
									newHtmlPath
								);
								await vscode.window.showTextDocument(doc);
							} catch (e) {
								// File might not exist yet, that's OK
								debugLogger.log(
									`Note: Could not open ${newHtmlPath} - may need to refresh explorer`
								);
							}
						}
					} else {
						vscode.window.showErrorMessage(
							`Failed to create post: ${
								response.error || response.message || "Unknown error"
							}`
						);
					}
				} catch (error: any) {
					vscode.window.showErrorMessage(
						`Failed to create post: ${error.message}`
					);
					debugLogger.log(`❌ Request post ID failed: ${error.message}`);
				}
			}
		)
	);

	// Manage Post command (change status, slug, title, schedule, etc.)
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"skylit.managePost",
			async (uri?: vscode.Uri) => {
				if (!restClient) {
					vscode.window.showErrorMessage("Not connected to WordPress");
					return;
				}

				if (!currentDevPath) {
					vscode.window.showErrorMessage("Dev folder not configured");
					return;
				}

				// Get folder path from context menu, explorer selection, or active editor
				let folderPath: string | undefined;

				if (uri) {
					// Called from context menu on a folder/file
					folderPath = uri.fsPath;
					// If it's a file, get its parent folder
					if (path.extname(folderPath)) {
						folderPath = path.dirname(folderPath);
					}
				} else {
					// Try to get from active editor
					const editor = vscode.window.activeTextEditor;
					if (editor) {
						folderPath = path.dirname(editor.document.uri.fsPath);
					}
				}

				// Normalize path
				folderPath = folderPath?.replace(/\\/g, "/");

				if (!folderPath) {
					vscode.window.showErrorMessage(
						"No folder selected. Open a file or right-click on a folder."
					);
					return;
				}

				const folderName = path.basename(folderPath);

				// Resolve post ID — try metadata cache first (supports slug-only folders),
				// fall back to legacy _ID suffix for backwards compatibility.
				let postId: number | null = null;
				if (fileWatcher) {
					// Pass a path inside the folder so getPostIdForFile resolves the folder via dirname
					const htmlFile = path.join(folderPath, folderName + ".html");
					postId = fileWatcher.getPostIdForFile(htmlFile);
				}
				// Legacy fallback: _ID suffix in folder name
				if (!postId) {
					const idMatch = folderName.match(/_(\d+)$/);
					if (idMatch) postId = parseInt(idMatch[1], 10);
				}
				if (!postId) {
					vscode.window.showErrorMessage(
						`Could not find a WordPress post for folder "${folderName}". Make sure the extension is connected and the folder is tracked.`
					);
					return;
				}

				// Show management options
				const statusOption = "Change Status";
				const slugOption = "Rename Slug";
				const titleOption = "Rename Title";
				const scheduleOption = "Schedule Post";
				const cancelOption = "Cancel";

				const choice = await vscode.window.showQuickPick(
					[
						{
							label: "$(edit) Change Status",
							description: "Publish, Draft, Pending, Private, or Schedule",
							value: statusOption,
						},
						{
							label: "$(symbol-text) Rename Slug",
							description: "Change the URL slug (e.g., my-page → new-page)",
							value: slugOption,
						},
						{
							label: "$(whole-word) Rename Title",
							description: "Change the post title",
							value: titleOption,
						},
						{
							label: "$(calendar) Schedule Post",
							description: "Set a future publish date/time",
							value: scheduleOption,
						},
					],
					{
						placeHolder: `Manage post: ${folderName}`,
					}
				);

				if (!choice) {
					return;
				}

				try {
					if (choice.value === statusOption) {
						// Change post status
						const statusChoice = await vscode.window.showQuickPick(
							[
								{
									label: "$(check) Publish",
									description: "Make post public",
									value: "publish",
								},
								{
									label: "$(edit) Draft",
									description: "Save as draft",
									value: "draft",
								},
								{
									label: "$(clock) Pending Review",
									description: "Submit for review",
									value: "pending",
								},
								{
									label: "$(lock) Private",
									description: "Only visible to admins",
									value: "private",
								},
								{
									label: "$(calendar) Schedule for Later",
									description: "Set future publish date",
									value: "future",
								},
							],
							{
								placeHolder: "Select new status",
							}
						);

						if (!statusChoice) return;

						let scheduledDate: string | undefined;

						if (statusChoice.value === "future") {
							// Prompt for date and time
							const dateStr = await vscode.window.showInputBox({
								prompt: "Enter publish date and time",
								placeHolder: "YYYY-MM-DD HH:MM:SS (e.g., 2026-02-10 14:30:00)",
								validateInput: (value) => {
									// Basic validation for date format
									if (!/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(value)) {
										return "Invalid format. Use: YYYY-MM-DD HH:MM:SS";
									}
									return null;
								},
							});

							if (!dateStr) return;
							scheduledDate = dateStr;
						}

						statusBar.showSyncing("Updating status...");

						const response = await restClient.updatePostMeta(postId, {
							status: statusChoice.value,
							scheduled_date: scheduledDate,
						});

						if (response.success) {
							statusBar.showSuccess("Status updated");
							vscode.window.showInformationMessage(
								`✅ Post status changed to "${statusChoice.label.replace(
									/\$\(.*?\)\s*/,
									""
								)}"`
							);
						} else {
							statusBar.showError("Update failed");
							vscode.window.showErrorMessage(
								`Failed to update status: ${
									response.message || "Unknown error"
								}`
							);
						}
					} else if (choice.value === slugOption) {
						// Rename slug
						const currentSlug = folderName.replace(/_\d+$/, "");
						const newSlug = await vscode.window.showInputBox({
							prompt: "Enter new slug (URL-friendly name)",
							placeHolder: "my-new-slug",
							value: currentSlug,
							validateInput: (value) => {
								if (!/^[a-z0-9-]+$/.test(value)) {
									return "Slug must contain only lowercase letters, numbers, and hyphens";
								}
								return null;
							},
						});

						if (!newSlug || newSlug === currentSlug) {
							return;
						}

						statusBar.showSyncing("Renaming slug...");

						const response = await restClient.updatePostMeta(postId, {
							slug: newSlug,
						});

						if (response.success) {
							statusBar.showSuccess("Slug updated");
							vscode.window.showInformationMessage(
								`✅ Slug changed to "${newSlug}". Folder will be renamed automatically.`
							);
							debugLogger.log(`✅ Slug updated: ${currentSlug} → ${newSlug}`);
						} else {
							statusBar.showError("Update failed");
							vscode.window.showErrorMessage(
								`Failed to update slug: ${response.message || "Unknown error"}`
							);
						}
					} else if (choice.value === titleOption) {
						// Rename title
						const newTitle = await vscode.window.showInputBox({
							prompt: "Enter new title",
							placeHolder: "My New Title",
						});

						if (!newTitle) return;

						statusBar.showSyncing("Updating title...");

						const response = await restClient.updatePostMeta(postId, {
							title: newTitle,
						});

						if (response.success) {
							statusBar.showSuccess("Title updated");
							vscode.window.showInformationMessage(
								`✅ Title changed to "${newTitle}"`
							);
							debugLogger.log(`✅ Title updated for post ${postId}`);
						} else {
							statusBar.showError("Update failed");
							vscode.window.showErrorMessage(
								`Failed to update title: ${response.message || "Unknown error"}`
							);
						}
					} else if (choice.value === scheduleOption) {
						// Schedule post
						const dateStr = await vscode.window.showInputBox({
							prompt: "Enter publish date and time",
							placeHolder: "YYYY-MM-DD HH:MM:SS (e.g., 2026-02-10 14:30:00)",
							validateInput: (value) => {
								if (!/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(value)) {
									return "Invalid format. Use: YYYY-MM-DD HH:MM:SS";
								}
								return null;
							},
						});

						if (!dateStr) return;

						statusBar.showSyncing("Scheduling post...");

						const response = await restClient.updatePostMeta(postId, {
							status: "future",
							scheduled_date: dateStr,
						});

						if (response.success) {
							statusBar.showSuccess("Post scheduled");
							vscode.window.showInformationMessage(
								`✅ Post scheduled for ${dateStr}`
							);
						} else {
							statusBar.showError("Scheduling failed");
							vscode.window.showErrorMessage(
								`Failed to schedule post: ${
									response.message || "Unknown error"
								}`
							);
						}
					}
				} catch (error: any) {
					statusBar.showError(`Failed: ${error.message}`);
					vscode.window.showErrorMessage(
						`Failed to update post: ${error.message}`
					);
					debugLogger.log(`❌ Manage post failed: ${error.message}`);
				}
			}
		)
	);

	// Delete Post command (trash or permanently delete from WordPress)
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"skylit.deletePost",
			async (uri?: vscode.Uri) => {
				if (!restClient) {
					vscode.window.showErrorMessage("Not connected to WordPress");
					return;
				}

				if (!currentDevPath) {
					vscode.window.showErrorMessage("Dev folder not configured");
					return;
				}

				// Get folder path from context menu, explorer selection, or active editor
				let folderPath: string | undefined;

				if (uri) {
					// Called from context menu on a folder/file
					folderPath = uri.fsPath;
					// If it's a file, get its parent folder
					if (path.extname(folderPath)) {
						folderPath = path.dirname(folderPath);
					}
				} else {
					// Try to get from active editor
					const editor = vscode.window.activeTextEditor;
					if (editor) {
						folderPath = path.dirname(editor.document.uri.fsPath);
					}
				}

				// Normalize path
				folderPath = folderPath?.replace(/\\/g, "/");

				if (!folderPath) {
					vscode.window.showErrorMessage(
						"No folder selected. Open a file or right-click on a folder."
					);
					return;
				}

				const folderName = path.basename(folderPath);

				// Resolve post ID — try metadata cache first (supports slug-only folders),
				// fall back to legacy _ID suffix for backwards compatibility.
				let postId: number | null = null;
				if (fileWatcher) {
					const htmlFile = path.join(folderPath, folderName + ".html");
					postId = fileWatcher.getPostIdForFile(htmlFile);
				}
				if (!postId) {
					const idMatch = folderName.match(/_(\d+)$/);
					if (idMatch) postId = parseInt(idMatch[1], 10);
				}
				if (!postId) {
					vscode.window.showErrorMessage(
						`Could not find a WordPress post for folder "${folderName}". Make sure the extension is connected and the folder is tracked.`
					);
					return;
				}

				// Show delete options
				const trashOption = "Move to Trash";
				const deleteOption = "Delete Permanently";
				const cancelOption = "Cancel";

				const choice = await vscode.window.showWarningMessage(
					`Delete "${folderName}" from WordPress?`,
					{
						modal: true,
						detail: `Post ID: ${postId}\n\n• Move to Trash: Post goes to WordPress trash (recoverable). Local folder will be deleted.\n• Delete Permanently: Post removed from database, local folder and metadata deleted.\n• Cancel: No changes.`,
					},
					trashOption,
					deleteOption,
					cancelOption
				);

				if (!choice || choice === cancelOption) {
					return;
				}

				const action = choice === trashOption ? "trash" : "delete";

				try {
					// Mark this post to skip the FileWatcher prompt (already confirmed by user)
					if (fileWatcher) {
						fileWatcher.markPostForDeletion(postId);
					}

					statusBar.showSyncing(
						`${action === "trash" ? "Trashing" : "Deleting"}...`
					);

					const response = await restClient.sendFolderAction(postId, action);

					if (response.success) {
						const actionVerb =
							action === "trash" ? "moved to trash" : "permanently deleted";
						debugLogger.log(`✅ Post ${postId} ${actionVerb}`);

						// Delete local folder
						try {
							const fs = await import("fs");
							if (fs.existsSync(folderPath)) {
								fs.rmSync(folderPath, {
									recursive: true,
								});
								debugLogger.log(`🗑️ Deleted local folder: ${folderName}`);
							}
						} catch (fsError: any) {
							debugLogger.log(
								`⚠️ Could not delete local folder: ${fsError.message}`
							);
						}

						// Delete metadata file for permanent deletes
						if (action === "delete") {
							try {
								const fs = await import("fs");
								const metadataPath = path.join(
									currentDevPath,
									".skylit",
									"metadata",
									`${postId}.json`
								);
								if (fs.existsSync(metadataPath)) {
									fs.unlinkSync(metadataPath);
									debugLogger.log(`🗑️ Deleted metadata file: ${postId}.json`);
								}
							} catch (metaError: any) {
								debugLogger.log(
									`⚠️ Could not delete metadata file: ${metaError.message}`
								);
							}
						}

					statusBar.showSuccess(`Post ${actionVerb}`, 3000);
					vscode.window.showInformationMessage(
						`✅ Post ${postId} ${actionVerb} in WordPress`
					);
					} else {
						statusBar.showError("Action failed");
						vscode.window.showErrorMessage(
							`Failed to ${action} post: ${response.message || "Unknown error"}`
						);
					}
				} catch (error: any) {
					statusBar.showError(`Failed: ${error.message}`);
					vscode.window.showErrorMessage(
						`Failed to ${action} post ${postId}: ${error.message}`
					);
					debugLogger.log(`❌ Delete post failed: ${error.message}`);
				}
			}
		)
	);

	// Connect to Remote WordPress (prompts for URL, token, local path)
	context.subscriptions.push(
		vscode.commands.registerCommand("skylit.connectRemote", async () => {
			debugLogger.show();

			const siteUrl = await vscode.window.showInputBox({
				prompt: "Enter your remote WordPress site URL",
				placeHolder: "https://mysite.com",
				ignoreFocusOut: true,
				validateInput: (value) => {
					if (!value.trim()) return "URL is required";
					try {
						new URL(value.trim());
					} catch {
						return "Invalid URL format";
					}
					return null;
				},
			});
			if (!siteUrl) return;

			const token = await vscode.window.showInputBox({
				prompt: `Enter auth token for ${siteUrl}`,
				placeHolder: "skylit_abc123...",
				password: true,
				ignoreFocusOut: true,
			});
			if (!token) return;

			const localPath = await vscode.window.showInputBox({
				prompt: "Enter local dev folder path (where files will be stored)",
				placeHolder: "C:\\projects\\mysite-dev-root",
				ignoreFocusOut: true,
				validateInput: (value) => {
					if (!value.trim()) return "Path is required";
					return null;
				},
			});
			if (!localPath) return;

			const cleanUrl = siteUrl.trim().replace(/\/$/, "");
			const cleanPath = localPath.trim();

			// Save settings
			const vscodeConfig = vscode.workspace.getConfiguration("skylit");
			await vscodeConfig.update(
				"siteUrl",
				cleanUrl,
				vscode.ConfigurationTarget.Workspace
			);
			await vscodeConfig.update(
				"localDevPath",
				cleanPath,
				vscode.ConfigurationTarget.Workspace
			);

		// Save token and register site
		await authManager.saveToken(cleanUrl, token);
		await authManager.registerSite(cleanUrl, new URL(cleanUrl).hostname, cleanPath);

		const remoteSite = {
			name: new URL(cleanUrl).hostname,
			path: cleanPath,
			siteUrl: cleanUrl,
			devFolder: cleanPath,
		};

		await connectToWordPress(remoteSite, context, false);
	})
);

	// Manage Sites — view, switch, remove paired domain/token pairs
	context.subscriptions.push(
		vscode.commands.registerCommand("skylit.manageSites", async () => {
			const sites = await authManager.getSitesWithTokens();

			if (sites.length === 0) {
				const action = await vscode.window.showInformationMessage(
					"No sites registered yet. Pair a new site?",
					"Setup Token",
					"Connect Remote"
				);
				if (action === "Setup Token") {
					vscode.commands.executeCommand("skylit.setupToken");
				} else if (action === "Connect Remote") {
					vscode.commands.executeCommand("skylit.connectRemote");
				}
				return;
			}

			const config = getWorkspaceSkylitConfig();
			const activeSiteUrl = config.get<string>("siteUrl", "").trim();

			const items = sites.map((s) => {
				const isActive =
					activeSiteUrl &&
					s.url.replace(/^https?:\/\//, "").replace(/\/$/, "") ===
						activeSiteUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
				return {
					label: `${isActive ? "$(check) " : ""}${s.name}`,
					description: s.url,
					detail: [
						s.hasToken ? "Token saved" : "No token",
						s.localDevPath ? `Dev: ${s.localDevPath}` : null,
						isActive ? "Active" : null,
					]
						.filter(Boolean)
						.join(" · "),
					site: s,
					isActive,
				};
			});

			const choice = await vscode.window.showQuickPick(items, {
				placeHolder: "Select a site to manage",
				matchOnDescription: true,
			});

			if (!choice) return;

			const actions: Array<{
				label: string;
				description: string;
				value: string;
			}> = [];

			if (!choice.isActive) {
				actions.push({
					label: "$(plug) Switch to this site",
					description: "Set as active and connect",
					value: "switch",
				});
			}

			actions.push(
				{
					label: "$(key) Update token",
					description: "Enter a new auth token for this site",
					value: "token",
				},
				{
					label: "$(trash) Remove site",
					description: "Delete this domain/token pair",
					value: "remove",
				}
			);

			const action = await vscode.window.showQuickPick(actions, {
				placeHolder: `${choice.site.name} — choose an action`,
			});

			if (!action) return;

			if (action.value === "switch") {
				await config.update(
					"siteUrl",
					choice.site.url,
					vscode.ConfigurationTarget.Workspace
				);
				if (choice.site.localDevPath) {
					await config.update(
						"localDevPath",
						choice.site.localDevPath,
						vscode.ConfigurationTarget.Workspace
					);
				}

				const site = {
					name: choice.site.name,
					path: choice.site.localDevPath || "",
					siteUrl: choice.site.url,
					devFolder: choice.site.localDevPath || "",
				};

				debugLogger.info(`🔄 Switching to site: ${choice.site.name}`);
				await connectToWordPress(site, context, false);
			} else if (action.value === "token") {
				const token = await vscode.window.showInputBox({
					prompt: `Enter new auth token for ${choice.site.name}`,
					placeHolder: "skylit_abc123...",
					password: true,
					ignoreFocusOut: true,
				});
				if (!token) return;

				await authManager.saveToken(choice.site.url, token);
				vscode.window.showInformationMessage(
					`Token updated for ${choice.site.name}`
				);
			} else if (action.value === "remove") {
				const confirm = await vscode.window.showWarningMessage(
					`Remove ${choice.site.name} (${choice.site.url})? This deletes the saved token too.`,
					{ modal: true },
					"Remove",
					"Cancel"
				);
				if (confirm !== "Remove") return;

				await authManager.unregisterSite(choice.site.url);

				if (choice.isActive) {
					await config.update(
						"siteUrl",
						"",
						vscode.ConfigurationTarget.Workspace
					);
				}

				vscode.window.showInformationMessage(
					`Removed ${choice.site.name}`
				);
			}
		})
	);

	// Switch Site — quick-pick to change the active site connection
	context.subscriptions.push(
		vscode.commands.registerCommand("skylit.switchSite", async () => {
			const sites = await authManager.getSitesWithTokens();

			if (sites.length === 0) {
				vscode.window.showInformationMessage(
					"No sites registered. Use 'Skylit: Setup Auth Token' or 'Skylit: Connect to Remote WordPress' first."
				);
				return;
			}

			const config = vscode.workspace.getConfiguration("skylit");
			const activeSiteUrl = config.get<string>("siteUrl", "").trim();

			const items = sites.map((s) => {
				const isActive =
					activeSiteUrl &&
					s.url.replace(/^https?:\/\//, "").replace(/\/$/, "") ===
						activeSiteUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
				return {
					label: `${isActive ? "$(check) " : "$(globe) "}${s.name}`,
					description: s.url,
					detail: isActive
						? "Currently active"
						: s.hasToken
						? "Token saved — ready to connect"
						: "No token — will prompt on connect",
					site: s,
					isActive,
				};
			});

			const choice = await vscode.window.showQuickPick(items, {
				placeHolder: "Switch to a different WordPress site",
				matchOnDescription: true,
			});

			if (!choice || choice.isActive) return;

			await config.update(
				"siteUrl",
				choice.site.url,
				vscode.ConfigurationTarget.Workspace
			);
			if (choice.site.localDevPath) {
				await config.update(
					"localDevPath",
					choice.site.localDevPath,
					vscode.ConfigurationTarget.Workspace
				);
			}

			const site = {
				name: choice.site.name,
				path: choice.site.localDevPath || "",
				siteUrl: choice.site.url,
				devFolder: choice.site.localDevPath || "",
			};

			debugLogger.info(`🔄 Switching to site: ${choice.site.name}`);
			await connectToWordPress(site, context, false);
		})
	);

	// Sync all posts from remote (full sync)
	context.subscriptions.push(
		vscode.commands.registerCommand("skylit.syncFromRemote", async () => {
			if (!restClient) {
				vscode.window.showErrorMessage("Not connected to WordPress");
				return;
			}
			if (!exportPoller) {
				vscode.window.showErrorMessage(
					"Export poller not active (remote mode required)"
				);
				return;
			}

			const result = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: "Syncing all posts from remote WordPress...",
					cancellable: false,
				},
				async () => {
					return exportPoller!.performFullSync();
				}
			);

			if (result.failed) {
				vscode.window.showErrorMessage(
					"Full sync failed: could not fetch manifest from WordPress. Check connection and Output panel."
				);
			} else {
				vscode.window.showInformationMessage(
					`Full sync complete: ${result.synced} posts synced${
						result.errors > 0 ? `, ${result.errors} errors` : ""
					}`
				);
			}
		})
	);

	// Relocate dev folder (pull from server to local, or move between locations)
	context.subscriptions.push(
		vscode.commands.registerCommand("skylit.relocateDevFolder", async () => {
			debugLogger.show();

			if (!restClient) {
				vscode.window.showErrorMessage(
					"Not connected to WordPress. Connect first, then relocate."
				);
				return;
			}

			// Ask what they want to do
			const action = await vscode.window.showQuickPick(
				[
					{
						label: "$(cloud-download) Pull to local folder",
						description:
							"Download all posts from WordPress to a local dev folder and switch to remote mode",
						value: "pull-local",
					},
					{
						label: "$(file-symlink-directory) Move to different folder",
						description: "Move dev folder to a new location (local to local)",
						value: "move-local",
					},
				],
				{
					placeHolder: "How would you like to relocate the dev folder?",
				}
			);

			if (!action) return;

			if (action.value === "pull-local" || action.value === "move-local") {
				// Prompt for local path (showOpenDialog shows remote filesystem in SSH sessions)
				const newPath = await promptForLocalDevFolder(
					action.value === "pull-local"
						? "Enter the local path where posts should be downloaded"
						: "Enter the new local path for your dev folder"
				);

				if (!newPath) return;

				// If moving locally, copy existing files first
				if (action.value === "move-local" && currentDevPath) {
					const confirm = await vscode.window.showWarningMessage(
						`This will copy all files from:\n${currentDevPath}\n\nTo:\n${newPath}\n\nAnd switch the extension to use the new location.`,
						{ modal: true },
						"Copy & Switch",
						"Cancel"
					);

					if (confirm !== "Copy & Switch") return;

					await vscode.window.withProgress(
						{
							location: vscode.ProgressLocation.Notification,
							title: "Copying dev folder...",
							cancellable: false,
						},
						async (progress) => {
							const copyRecursive = (src: string, dest: string) => {
								if (!fs.existsSync(dest)) {
									fs.mkdirSync(dest, {
										recursive: true,
									});
								}

								const entries = fs.readdirSync(src, {
									withFileTypes: true,
								});

								for (const entry of entries) {
									const srcPath = path.join(src, entry.name);
									const destPath = path.join(dest, entry.name);

									if (entry.isDirectory()) {
										copyRecursive(srcPath, destPath);
									} else {
										fs.copyFileSync(srcPath, destPath);
									}
								}
							};

							progress.report({
								message: "Copying files...",
							});
							copyRecursive(currentDevPath!, newPath);
							progress.report({
								message: "Files copied!",
							});
						}
					);

					debugLogger.info(
						`📁 Copied dev folder from ${currentDevPath} to ${newPath}`
					);
				}

				// If pulling from remote, download via REST API
				if (action.value === "pull-local") {
					const manifest = await restClient!.getExportAll();

					const confirm = await vscode.window.showWarningMessage(
						`This will download ${manifest.count} posts from WordPress to:\n${newPath}\n\nAnd switch to remote dev folder mode.`,
						{ modal: true },
						"Download & Switch",
						"Cancel"
					);

					if (confirm !== "Download & Switch") return;

					// Create a temporary ExportPoller for the download
					const tempPoller = new ExportPoller(
						restClient!,
						newPath,
						statusBar,
						debugLogger
					);

					const result = await vscode.window.withProgress(
						{
							location: vscode.ProgressLocation.Notification,
							title: "Downloading posts from WordPress...",
							cancellable: false,
						},
						async (progress) => {
							progress.report({
								message: `Downloading ${manifest.count} posts...`,
							});
							return tempPoller.performFullSync();
						}
					);

					if (result.failed) {
						vscode.window.showErrorMessage(
							"Download failed: could not fetch manifest from WordPress. Check connection."
						);
						return;
					}

					debugLogger.info(
						`📦 Downloaded ${result.synced} posts to ${newPath}`
					);

					if (result.errors > 0) {
						vscode.window.showWarningMessage(
							`Downloaded ${result.synced} posts with ${result.errors} errors. Check Output panel.`
						);
					}
				}

				// Get the site URL (from current connection)
				const currentSiteUrl = restClient!.getSiteUrl();

				// Save settings for remote mode
				const vscodeConfig = vscode.workspace.getConfiguration("skylit");
				await vscodeConfig.update(
					"localDevPath",
					newPath,
					vscode.ConfigurationTarget.Workspace
				);

				// Ensure siteUrl is saved (for reconnection)
				if (!vscodeConfig.get<string>("siteUrl", "")) {
					await vscodeConfig.update(
						"siteUrl",
						currentSiteUrl,
						vscode.ConfigurationTarget.Workspace
					);
				}

				// Notify WordPress to switch to remote mode
				await restClient!.ackRelocate(true, newPath);

				// Switch to remote mode
				isRemoteMode = true;
				currentDevPath = newPath;

				// Restart file watcher on new path
				if (fileWatcher) {
					fileWatcher.dispose();
				}
				fileWatcher = new FileWatcher(
					newPath,
					restClient!,
					statusBar,
					debugLogger,
					newPath,
					isRemoteMode
				);
			await fileWatcher.start();

			// Media sync runs in the background — never blocks jump polling or import.
			fileWatcher.refreshMediaSyncSettings().catch((mediaErr: any) => {
				debugLogger.log(`⚠️ Media sync init failed: ${mediaErr?.message || mediaErr}`);
			});

				// Start export poller
				if (exportPoller) {
					exportPoller.dispose();
				}
				exportPoller = new ExportPoller(
					restClient!,
					newPath,
					statusBar,
					debugLogger
				);
				exportPoller.start();

				// Restart post type converter
				if (postTypeConverter) {
					postTypeConverter.dispose();
				}
				postTypeConverter = new PostTypeConverter(
					restClient!,
					newPath,
					debugLogger
				);
				postTypeConverter.startWatching();

				statusBar.updateStatus("connected", "Remote");

				vscode.window.showInformationMessage(
					`Dev folder relocated to ${newPath}. Now running in remote mode.`
				);
			}
		})
	);

	// Open in Gutenberg — launch WP editor for the active file in browser
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"skylit.openInGutenberg",
			async (uri?: vscode.Uri) => {
				if (!restClient) {
					vscode.window.showErrorMessage("Not connected to WordPress");
					return;
				}

				let html: string | undefined;

				if (uri) {
					// Right-click on folder/file — read the HTML file
					let fileUri = uri;
					if (!uri.path.endsWith(".html")) {
						const folderName = path.basename(uri.path);
						fileUri = vscode.Uri.joinPath(uri, `${folderName}.html`);
					}
					try {
						const content = await vscode.workspace.fs.readFile(fileUri);
						html = Buffer.from(content).toString("utf-8");
					} catch {}
				} else {
					// Keyboard shortcut — read from active editor (already open)
					const editor = vscode.window.activeTextEditor;
					if (editor && editor.document.uri.path.endsWith(".html")) {
						html = editor.document.getText();
					}
				}

				if (!html) {
					vscode.window.showErrorMessage(
						"Open an HTML file or right-click a folder to open in Gutenberg."
					);
					return;
				}

				const match = html.match(
					/<!--\s*\n?\s*WordPress Sync Metadata[\s\S]*?ID:\s*(\d+)/
				);
				if (!match) {
					vscode.window.showErrorMessage(
						"No WordPress post ID found in file metadata header."
					);
					return;
				}

				const postId = match[1];
				const siteUrl = restClient.getSiteUrl();
				const editUrl = `${siteUrl}/wp-admin/post.php?post=${postId}&action=edit`;

				await vscode.env.openExternal(vscode.Uri.parse(editUrl));
				debugLogger.log(`🌐 Opened in Gutenberg: post ${postId} → ${editUrl}`);
			}
		)
	);

	// Manual media push command
	context.subscriptions.push(
		vscode.commands.registerCommand("skylit.pushMediaToWP", async () => {
			if (!fileWatcher) {
				vscode.window.showErrorMessage("Skylit: not connected to WordPress.");
				return;
			}
			if (!restClient) {
				vscode.window.showErrorMessage("Skylit: not connected to WordPress.");
				return;
			}

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: "Skylit: pushing media to WordPress…",
					cancellable: false,
				},
				async (progressReporter) => {
					progressReporter.report({ message: "Scanning media-library/…" });

					const result = await fileWatcher!.pushAllMediaToWP(
						(fileName, done, total) => {
							const pct = Math.round((done / total) * 100);
							progressReporter.report({
								message: `${fileName} (${done}/${total})`,
								increment: pct / total,
							});
						}
					);

					if (result.pushed === 0 && result.errors === 0) {
						vscode.window.showInformationMessage(
							"Skylit Media: no files to push — media-library/ is empty or all files are already in sync."
						);
					} else if (result.errors > 0) {
						vscode.window.showWarningMessage(
							`Skylit Media: push complete — ${result.pushed} pushed, ${result.errors} error(s). Check output for details.`
						);
					} else {
						vscode.window.showInformationMessage(
							`Skylit Media: push complete — ${result.pushed} file(s) pushed to WordPress.`
						);
					}
				}
			);
		})
	);

	// Manual media import command (WP → media-library/)
	context.subscriptions.push(
		vscode.commands.registerCommand("skylit.importMediaFromWP", async () => {
			if (!fileWatcher || !restClient) {
				vscode.window.showErrorMessage("Skylit: not connected to WordPress.");
				return;
			}

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: "Skylit: importing media from WordPress…",
					cancellable: false,
				},
				async (progressReporter) => {
					progressReporter.report({ message: "Starting import…" });

					const result = await fileWatcher!.importMediaFromWP(
						(message, done, total) => {
							progressReporter.report({ message });
						}
					);

					if (result.processed === 0 && result.errors === 0) {
						vscode.window.showInformationMessage(
							`Skylit Media: import complete — all files already in sync (${result.skipped} skipped).`
						);
					} else if (result.errors > 0) {
						vscode.window.showWarningMessage(
							`Skylit Media: import complete — ${result.processed} imported, ${result.errors} error(s). Check output for details.`
						);
					} else {
						vscode.window.showInformationMessage(
							`Skylit Media: import complete — ${result.processed} file(s) imported from WordPress.`
						);
					}
				}
			);
		})
	);

	// Full media sync command
	context.subscriptions.push(
		vscode.commands.registerCommand("skylit.fullMediaSync", async () => {
			if (!fileWatcher || !restClient) {
				vscode.window.showErrorMessage("Skylit: not connected to WordPress.");
				return;
			}

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: "Skylit: full media sync…",
					cancellable: false,
				},
				async (progressReporter) => {
					progressReporter.report({ message: "Starting sync…" });

					const result = await fileWatcher!.fullMediaSync(
						(message, done, total) => {
							progressReporter.report({ message });
						}
					);

					if (result.errors > 0) {
						vscode.window.showWarningMessage(
							`Skylit Media: sync complete — ${result.processed} synced, ${result.skipped} skipped, ${result.errors} error(s).`
						);
					} else {
						vscode.window.showInformationMessage(
							`Skylit Media: sync complete — ${result.processed} synced, ${result.skipped} already up to date.`
						);
					}
				}
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("skylit.settings", () => {
			vscode.commands.executeCommand(
				"workbench.action.openSettings",
				"@ext:dimy-osman.skylit-dev-io"
			);
		})
	);

	// Show menu command
	context.subscriptions.push(
		vscode.commands.registerCommand("skylit.showMenu", async () => {
			// If disconnected or error, show quick connect options
			if (
				statusBar["connectionState"] === "disconnected" ||
				statusBar["connectionState"] === "error"
			) {
				const registeredSites = authManager.getRegisteredSites();
				const items: Array<{
					label: string;
					command: string;
					description: string;
				}> = [
					{
						label: "🔌 Connect to WordPress",
						command: "skylit.connect",
						description: "Connect to detected WordPress site",
					},
					{
						label: "🌐 Connect to Remote WordPress",
						command: "skylit.connectRemote",
						description:
							"Connect to WordPress on a remote server with local dev folder",
					},
					...(registeredSites.length > 1
						? [
								{
									label: "🔀 Switch Site",
									command: "skylit.switchSite",
									description: `${registeredSites.length} sites registered — switch active connection`,
								},
						  ]
						: []),
					{
						label: "🔑 Setup Auth Token",
						command: "skylit.setupToken",
						description: "Pair a domain with an auth token",
					},
					...(registeredSites.length > 0
						? [
								{
									label: "📋 Manage Sites",
									command: "skylit.manageSites",
									description: `${registeredSites.length} paired site(s) — view, switch, or remove`,
								},
						  ]
						: []),
				{
					label: "🔍 Scan for WordPress",
					command: "skylit.scanWorkspace",
					description:
						"Manually scan workspace for WordPress + Skylit plugin",
				},
				{
					label: "⚙️ Extension Settings",
					command: "skylit.settings",
					description: "Open Skylit extension settings",
				},
			];

			const choice = await vscode.window.showQuickPick(items, {
				placeHolder: "Skylit.DEV I/O - Not Connected",
			});

				if (choice) {
					vscode.commands.executeCommand(choice.command);
				}
			} else {
				// Connected - show all actions
				const items: Array<{
					label: string;
					command: string;
					description: string;
				}> = [
				{
					label: "🔄 Sync Current File",
					command: "skylit.syncNow",
					description: "Force sync the active file",
				},
				{
					label: "📷 Push All Media to WordPress",
					command: "skylit.pushMediaToWP",
					description: "Push all files in media-library/ to WP media library",
				},
				{
					label: "📥 Import All Media from WordPress",
					command: "skylit.importMediaFromWP",
					description: "Pull all WP media attachments into media-library/",
				},
				{
					label: "🔁 Full Media Sync",
					command: "skylit.fullMediaSync",
					description: "Bidirectional media sync between WP and media-library/",
				},
				{
					label: "📁 Relocate Dev Folder",
						command: "skylit.relocateDevFolder",
						description:
							"Move dev folder to a different location or pull from server",
					},
					...(isRemoteMode
						? [
								{
									label: "📦 Sync All from Remote",
									command: "skylit.syncFromRemote",
									description: "Download all posts from WordPress",
								},
						  ]
						: []),
				...(fileWatcher && fileWatcher.pendingMetadataRepairs.length > 0
					? [
							{
								label: `🔧 Repair Block Metadata (${fileWatcher.pendingMetadataRepairs.length} pending)`,
								command: "skylit.repairMetadata",
								description:
									"Fetch block data from WP for posts with empty metadata",
							},
					  ]
					: []),
				{
					label: "🔧 Repair Blocks (current page)",
					command: "skylit.repairBlocks",
					description:
						"Force re-import current page from HTML file",
				},
				{
					label: "🧼 Repair CSS Storage (current page)",
					command: "skylit.repairCssStorage",
					description:
						"Normalize corrupted block CSS in WordPress database",
				},
				{
					label: "🧼 Repair CSS Storage (all posts, batched)",
					command: "skylit.repairCssStorageAll",
					description:
						"Batch-normalize CSS storage across all posts with cursor pagination",
				},
				{
					label: "🔧 Repair All (clear sync hashes)",
					command: "skylit.repairAll",
					description:
						"Clear all sync hashes to force re-import on next cycle",
				},
				{
					label: "❌ Disconnect",
					command: "skylit.disconnect",
					description: "Disconnect from WordPress",
				},
				...(authManager.getRegisteredSites().length > 1
					? [
							{
								label: "🔀 Switch Site",
								command: "skylit.switchSite",
								description: "Switch to a different paired WordPress site",
							},
					  ]
					: []),
					{
						label: "📋 Manage Sites",
						command: "skylit.manageSites",
						description: "View, switch, or remove paired domain/token pairs",
					},
					{
						label: "🔑 Setup Auth Token",
						command: "skylit.setupToken",
						description: "Pair a domain with an auth token",
					},
				{
					label: "🔍 Scan for WordPress",
					command: "skylit.scanWorkspace",
					description:
						"Manually scan workspace for WordPress + Skylit plugin",
				},
				{
					label: "⚙️ Extension Settings",
					command: "skylit.settings",
					description: "Open Skylit extension settings",
				},
			];

			const choice = await vscode.window.showQuickPick(items, {
				placeHolder: "Skylit.DEV I/O Actions",
			});

				if (choice) {
					vscode.commands.executeCommand(choice.command);
				}
			}
		})
	);
}

/**
 * Connect to WordPress site
 */
async function connectToWordPress(
	site: any,
	context: vscode.ExtensionContext,
	isAutoConnect: boolean = false
) {
	if (connectionInProgress) {
		debugLogger.warn(
			"⚠️ Connection already in progress — skipping duplicate call"
		);
		return;
	}
	connectionInProgress = true;

	debugLogger.info(`🔌 Connecting to ${site.name}...`);
	statusBar.updateStatus("connecting", "Connecting...");

	try {
		// Start with URL from wp-config.php detection
		let siteUrl = site.siteUrl;

		// Try discovery endpoint to get canonical siteUrl and devPath from WordPress
		// This is the source of truth - WordPress knows its own URL
		const discovered = await RestClient.discover(siteUrl, debugLogger);
		if (discovered) {
			siteUrl = discovered.siteUrl;
			site.siteUrl = siteUrl;
			site.devFolder = discovered.devPath;
			debugLogger.info(`✅ Discovered from WordPress: ${siteUrl}`);
		}

		// VS Code settings can still override (for edge cases like proxies)
		const vscodeConfig = vscode.workspace.getConfiguration("skylit");
		const manualSiteUrl = vscodeConfig.get<string>("siteUrl");
		if (manualSiteUrl?.trim()) {
			debugLogger.warn(
				`⚠️ skylit.siteUrl setting is overriding discovered URL: ${manualSiteUrl}`
			);
			siteUrl = manualSiteUrl.trim().replace(/\/$/, "");
			site.siteUrl = siteUrl;
		}

		// Check if site URL is still localhost
		if (siteUrl === "http://localhost" || siteUrl === "https://localhost") {
			debugLogger.warn(`⚠️ Default localhost URL detected`);

			// Don't prompt during auto-connect, just fail gracefully
			if (isAutoConnect) {
				debugLogger.info('💡 Please set "skylit.siteUrl" in VS Code settings');
				statusBar.updateStatus("disconnected", "Configure site URL");
				return;
			}

			// Prompt user for actual URL
			const userUrl = await vscode.window.showInputBox({
				prompt: "Enter your WordPress site URL",
				placeHolder: "https://palegreen-capybara-849923.hostingersite.com",
				value: siteUrl,
				ignoreFocusOut: true,
			});

			if (!userUrl || userUrl.trim() === "") {
				statusBar.updateStatus("disconnected", "Connection cancelled");
				return;
			}

			siteUrl = userUrl.trim().replace(/\/$/, "");
			site.siteUrl = siteUrl;
			debugLogger.info(`✅ Using URL: ${siteUrl}`);

			// Save to settings for future use
			await vscodeConfig.update(
				"siteUrl",
				siteUrl,
				vscode.ConfigurationTarget.Workspace
			);
		}

	// Security: Auto-upgrade HTTP → HTTPS, warn only when manually connecting
	const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|::1)/i.test(
		siteUrl
	);
	const isHttps = siteUrl.startsWith("https://");

	if (!isHttps && !isLocalhost) {
		if (isAutoConnect) {
			// Silently upgrade to HTTPS on auto-connect to avoid popup on every start
			const upgradedUrl = siteUrl.replace(/^http:\/\//, "https://");
			debugLogger.warn(`⚠️ Auto-upgrading HTTP → HTTPS: ${upgradedUrl}`);
			siteUrl = upgradedUrl;
			site.siteUrl = siteUrl;
			// Persist the upgraded URL so it doesn't revert
			const vscodeConfig2 = vscode.workspace.getConfiguration("skylit");
			await vscodeConfig2.update(
				"siteUrl",
				siteUrl,
				vscode.ConfigurationTarget.Workspace
			);
		} else {
			debugLogger.warn("⚠️ Security Warning: Connecting over HTTP");

			// Modal: the X/Escape already acts as Cancel — don't add explicit Cancel button
			const choice = await vscode.window.showWarningMessage(
				"⚠️ Security Warning\n\nYou are connecting over HTTP instead of HTTPS. Your auth token will be transmitted in cleartext and could be intercepted.\n\nWould you like to switch to HTTPS automatically?",
				{ modal: true },
				"Use HTTPS",
				"Continue with HTTP"
			);

			if (!choice || choice === "Use HTTPS") {
				const upgradedUrl = siteUrl.replace(/^http:\/\//, "https://");
				debugLogger.info(`✅ Upgrading to HTTPS: ${upgradedUrl}`);
				siteUrl = upgradedUrl;
				site.siteUrl = siteUrl;
				const vscodeConfig2 = vscode.workspace.getConfiguration("skylit");
				await vscodeConfig2.update(
					"siteUrl",
					siteUrl,
					vscode.ConfigurationTarget.Workspace
				);
			} else {
				debugLogger.warn("⚠️ User chose to continue over HTTP");
			}
		}
	}

		// Check for saved token
		let token = await authManager.getToken(site.siteUrl);

		if (!token) {
			debugLogger.warn("⚠️ No auth token found");

			// Don't prompt during auto-connect, just fail gracefully
			if (isAutoConnect) {
				debugLogger.info(
					'💡 Run "Skylit: Setup Auth Token" or click the status bar to connect'
				);
				statusBar.updateStatus(
					"disconnected",
					"No auth token - Click to setup"
				);

				// Show a non-intrusive info message
				vscode.window
					.showInformationMessage(
						"Skylit.DEV: Auth token required",
						"Setup Token",
						"Dismiss"
					)
					.then((selection) => {
						if (selection === "Setup Token") {
							vscode.commands.executeCommand("skylit.setupToken");
						}
					});
				return;
			}

			const input = await vscode.window.showInputBox({
				prompt: `Enter auth token for ${site.name}`,
				placeHolder: "skylit_abc123...",
				password: true,
				ignoreFocusOut: true,
			});

			if (!input) {
				statusBar.updateStatus("disconnected", "Connection cancelled");
				return;
			}

			token = input;
			await authManager.saveToken(site.siteUrl, token);
		}

		// Create REST client
		restClient = new RestClient(site.siteUrl, token, debugLogger);

		// Validate token
		const authResult = await restClient.validateToken();
		if (!authResult.valid) {
			if (authResult.tokenInvalid) {
				// Token is definitively wrong — clear it and prompt for a new one
				debugLogger.error("❌ Token rejected by WordPress");
				await authManager.clearToken(site.siteUrl);

				if (isAutoConnect) {
					debugLogger.info(
						"💡 Token is invalid or expired. Please setup a new token."
					);
					statusBar.updateStatus("error", "Invalid token - Click to setup");
					vscode.window
						.showWarningMessage(
							"Skylit.DEV: Auth token is invalid or expired",
							"Setup New Token",
							"Dismiss"
						)
						.then((selection) => {
							if (selection === "Setup New Token") {
								vscode.commands.executeCommand("skylit.setupToken");
							}
						});
				} else {
					vscode.window
						.showErrorMessage(
							"Invalid auth token. Please generate a new one in WordPress Admin → Skylit.DEV → Dev Sync",
							"Setup Token"
						)
						.then((selection) => {
							if (selection === "Setup Token") {
								vscode.commands.executeCommand("skylit.setupToken");
							}
						});
					statusBar.updateStatus("error", "Invalid token");
				}
			} else {
				// Server error (crash, 404, network) — keep the token, show server error
				debugLogger.error(
					"❌ Cannot reach Skylit plugin — server error or plugin crashed"
				);
				statusBar.updateStatus("error", "Server error - check PHP logs");
				vscode.window
					.showErrorMessage(
						"Cannot connect to Skylit plugin. The WordPress server may be crashing (memory limit) or the plugin is deactivated. Check your PHP error log.",
						"Retry"
					)
					.then((selection) => {
						if (selection === "Retry") {
							vscode.commands.executeCommand("skylit.connect");
						}
					});
			}
			return;
		}

		debugLogger.info("✅ Token validated");

		// Get plugin status and dev folder from WordPress
		const status = await restClient.getStatus();
		debugLogger.info(`✅ Connected to Skylit plugin v${status.version}`);
		debugLogger.log(`   Dev folder from WordPress: ${status.dev_path}`);
		debugLogger.log(
			`   Dev folder location mode: ${status.dev_folder_location || "unknown"}`
		);

		// Detect plugin version change — server already clears hashes, but log it
		const lastPluginVersion = context.globalState.get<string>(
			"skylit.lastPluginVersion"
		);
		if (lastPluginVersion && lastPluginVersion !== status.version) {
			debugLogger.info(
				`🔄 Plugin version changed: ${lastPluginVersion} → ${status.version}. Sync hashes cleared server-side.`
			);
		}
		context.globalState.update("skylit.lastPluginVersion", status.version);

		// Derive remote/decoupled mode from the plugin's setting — NOT from local config
		const pluginIsDecoupled = status.dev_folder_location === "remote";
		isRemoteMode = pluginIsDecoupled;
		restClient!.isRemoteMode = isRemoteMode;

		// Determine the effective dev path:
		// Decoupled mode → use local dev path from extension settings
		// Same-machine mode → use server dev path from WordPress
		const localDevPath = vscodeConfig.get<string>("localDevPath", "").trim();
		let effectiveDevPath: string;

		if (isRemoteMode) {
			if (!localDevPath) {
				debugLogger.error(
					"❌ Decoupled mode active but no local dev path configured"
				);
				vscode.window.showErrorMessage(
					"Plugin is in decoupled/remote mode but skylit.localDevPath is not set. " +
						"Set it in VS Code settings or switch the plugin to a same-machine mode."
				);
				statusBar.updateStatus("error", "Local dev path not configured");
				return;
			}
			effectiveDevPath = localDevPath;
			debugLogger.info(
				`🔌 Decoupled mode: using local dev path: ${effectiveDevPath}`
			);
		} else {
			effectiveDevPath = status.dev_path;

			// Fallback: if status endpoint returned empty, try the discovered devPath
			if ((!effectiveDevPath || effectiveDevPath.trim() === "") && site.devFolder) {
				debugLogger.warn(
					`⚠️ Status returned empty dev_path, falling back to discovered devPath: ${site.devFolder}`
				);
				effectiveDevPath = site.devFolder;
			}

			if (!effectiveDevPath || effectiveDevPath.trim() === "") {
				debugLogger.error("❌ No dev folder path from WordPress");
				vscode.window.showErrorMessage(
					"Dev folder not configured in WordPress. Please set it in Admin → Skylit.DEV → Dev Sync"
				);
				statusBar.updateStatus("error", "Dev folder not configured");
				return;
			}
			debugLogger.info(
				`📂 Same-machine mode (${status.dev_folder_location}): dev path: ${effectiveDevPath}`
			);
		}

		// Initialize file watcher with the effective dev path
		const lockAcquired = await ensureWorkspaceLock(effectiveDevPath);
		if (!lockAcquired) {
			statusBar.updateStatus(
				"disconnected",
				"Another window owns this dev folder"
			);
			return;
		}

		if (fileWatcher) {
			fileWatcher.dispose();
		}

		debugLogger.info(`👀 Starting file watcher for: ${effectiveDevPath}`);

		// Show "Connected" immediately so the user isn't blocked by the startup sync
		const modeLabel = isRemoteMode ? "Decoupled" : "Connected";
		statusBar.updateStatus("connected", modeLabel);

		fileWatcher = new FileWatcher(
			effectiveDevPath,
			restClient,
			statusBar,
			debugLogger,
			effectiveDevPath,
			isRemoteMode
		);

		fileWatcher.setAssetSourceModes({
			js: (status.js_source || "theme") as "theme" | "database",
			css: (status.css_source || "theme") as "theme" | "database",
			php: (status.php_source || "theme") as "theme" | "database",
		});

		await fileWatcher.start();

		// Media sync runs in the background — never blocks jump polling or import.
		fileWatcher.refreshMediaSyncSettings().catch((mediaErr: any) => {
			debugLogger.log(`⚠️ Media sync init failed: ${mediaErr?.message || mediaErr}`);
		});

		// Store the current dev path
		currentDevPath = effectiveDevPath;

		// Export poller only in decoupled mode — pulls queued exports from WordPress.
		// In same-machine mode the plugin writes files directly to the server dev folder.
		if (isRemoteMode) {
			if (exportPoller) {
				exportPoller.dispose();
			}
			exportPoller = new ExportPoller(
				restClient,
				effectiveDevPath,
				statusBar,
				debugLogger
			);
			exportPoller.start();
			debugLogger.info("📡 Export poller started (decoupled mode)");

			const postTypesDir = path.join(effectiveDevPath, "post-types");
			if (!fs.existsSync(postTypesDir)) {
				const syncNow = await vscode.window.showInformationMessage(
					"Decoupled dev folder appears empty. Sync all posts from WordPress?",
					"Sync Now",
					"Later"
				);
				if (syncNow === "Sync Now") {
					vscode.commands.executeCommand("skylit.syncFromRemote");
				}
			}
		} else {
			if (exportPoller) {
				exportPoller.dispose();
				exportPoller = null;
			}
			debugLogger.info(
				"📂 Same-machine mode — plugin writes files directly, no export poller"
			);
		}

		// Initialize post type converter
		if (postTypeConverter) {
			postTypeConverter.dispose();
		}
		postTypeConverter = new PostTypeConverter(
			restClient,
			effectiveDevPath,
			debugLogger
		);
		postTypeConverter.startWatching();
		debugLogger.log("🔄 Post type converter initialized");

		// Generate AI skillset files (.skylit/skillset/) on connect
		aiSkillsetGenerator = new AiSkillsetGenerator(
			restClient,
			debugLogger,
			effectiveDevPath
		);
		if (fileWatcher) {
			fileWatcher.setAiSkillsetGenerator(aiSkillsetGenerator);
		}
		aiSkillsetGenerator.generate().catch((err: any) => {
			debugLogger.warn(`📚 Skillset generation on connect failed: ${err.message}`);
		});

		// Start periodic status check (every 60 seconds) to detect dev folder changes
		if (statusCheckInterval) {
			clearInterval(statusCheckInterval);
		}

		statusCheckInterval = setInterval(async () => {
			if (!restClient) return;

			const profileEnd = debugLogger.profileStart("statusCheck");
			try {
				const updatedStatus = await restClient.getStatus();
				profileEnd();
				const updatedIsRemote = updatedStatus.dev_folder_location === "remote";

				// Detect mode change (user switched in WP admin)
				if (updatedIsRemote !== isRemoteMode) {
					debugLogger.info(
						`🔄 Mode changed: ${
							isRemoteMode ? "decoupled" : "same-machine"
						} → ${updatedIsRemote ? "decoupled" : "same-machine"}`
					);
					isRemoteMode = updatedIsRemote;

					// Reconnect to apply the new mode
					await connectToWordPress(site, context, true);
					return;
				}

				// In same-machine mode, check if dev folder path changed
				if (
					!isRemoteMode &&
					updatedStatus.dev_path &&
					updatedStatus.dev_path.trim() !== "" &&
					updatedStatus.dev_path !== currentDevPath
				) {
					debugLogger.log(
						`🔄 Dev folder changed: ${currentDevPath} → ${updatedStatus.dev_path}`
					);

					if (fileWatcher) {
						fileWatcher.dispose();
					}

					fileWatcher = new FileWatcher(
						updatedStatus.dev_path,
						restClient,
						statusBar,
						debugLogger,
						updatedStatus.dev_path,
						isRemoteMode
					);

			await fileWatcher.start();
			// Media sync runs in the background — never blocks jump polling or import.
			fileWatcher.refreshMediaSyncSettings().catch((mediaErr: any) => {
				debugLogger.log(`⚠️ Media sync init failed: ${mediaErr?.message || mediaErr}`);
			});
			currentDevPath = updatedStatus.dev_path;

				if (postTypeConverter) {
					postTypeConverter.dispose();
				}
				postTypeConverter = new PostTypeConverter(
					restClient,
						updatedStatus.dev_path,
						debugLogger
					);
					postTypeConverter.startWatching();

				debugLogger.info(
					`✅ Dev folder location updated: ${updatedStatus.dev_path}`
				);
				}

				// Check for .sources-updated marker (WP admin ACF changes)
				if (aiSkillsetGenerator && currentDevPath) {
					const markerPath = path.join(currentDevPath, ".skylit", ".sources-updated");
					if (fs.existsSync(markerPath)) {
						debugLogger.log("📚 Detected .sources-updated marker — regenerating skillset");
						aiSkillsetGenerator.generate().then(() => {
							aiSkillsetGenerator!.clearSourcesUpdatedMarker();
						}).catch((err: any) => {
							debugLogger.warn(`📚 Marker-triggered skillset regen failed: ${err.message}`);
						});
					}
				}
			} catch (error: any) {
				profileEnd(`error: ${error.message}`);
				debugLogger.log(`⚠️ Status check failed: ${error.message}`);
			}
		}, 60000); // Check every 60 seconds

		// Start jump-to-code polling (every 500ms for responsiveness)
		if (hasWorkspaceLock) {
			startJumpPolling();
		}

		// Start relocation request polling (every 5s, handles plugin-initiated moves)
		startRelocatePolling();

		// Run initial metadata cleanup on startup
		performMetadataCleanup();

		// Start periodic metadata cleanup (every 5 minutes)
		startMetadataCleanup();

		const displayDevPath = effectiveDevPath.replace(/\\/g, "/");
		let displayMessage = "";

		if (isRemoteMode) {
			const parts = displayDevPath.split("/").filter((p: string) => p);
			const folderName = parts[parts.length - 1] || parts[parts.length - 2];
			displayMessage = `✅ Connected to remote WordPress → local /${folderName}`;
		} else if (displayDevPath.includes("wp-content")) {
			const wpContentIndex = displayDevPath.indexOf("wp-content");
			const relativePath = displayDevPath.substring(wpContentIndex);
			displayMessage = `✅ Connected to .../${relativePath}`;
		} else {
			const parts = displayDevPath.split("/").filter((p: string) => p);
			const folderName = parts[parts.length - 1] || parts[parts.length - 2];
			displayMessage = `✅ Connected to /${folderName} (Server Root)`;
		}

		lastConnectedSiteUrl = siteUrl;

		// Auto-register this site so it appears in the multi-site picker
		const siteName = (() => {
			try { return new URL(siteUrl).hostname; } catch { return siteUrl; }
		})();
		await authManager.registerSite(
			siteUrl,
			siteName,
			isRemoteMode ? effectiveDevPath : undefined
		);

		vscode.window.showInformationMessage(displayMessage);
	} catch (error: any) {
		debugLogger.error(`❌ Connection failed: ${error.message}`);
		stopWorkspaceLockHeartbeat();
		await releaseWorkspaceLock();
		statusBar.updateStatus("error", "Connection failed");
	} finally {
		connectionInProgress = false;
	}
}

/**
 * Poll for jump-to-code requests with exponential backoff.
 *
 * Dedup strategy: track the last consumed jump by its server-side timestamp
 * AND file:line key. A jump is only executed if:
 *   - the server timestamp is newer than the last one we consumed, OR
 *   - the file:line:column key differs from the last one we consumed
 * This prevents infinite re-jumps when server-level HTTP caching (e.g.
 * LiteSpeed) returns a stale GET response after the transient was deleted.
 */
let jumpPollingInterval: NodeJS.Timeout | null = null;
let jumpPollIntervalMs: number = 500;
const JUMP_POLL_MIN_INTERVAL = 500;
const JUMP_POLL_MAX_INTERVAL = 30000;
let consecutiveErrors: number = 0;
let lastHandledJumpKey: string | null = null;
let lastHandledJumpTimestamp: number = 0;

function startJumpPolling() {
	if (jumpPollingInterval) {
		clearTimeout(jumpPollingInterval);
	}

	jumpPollIntervalMs = JUMP_POLL_MIN_INTERVAL;
	consecutiveErrors = 0;

	debugLogger.log("📍 Starting jump-to-code polling...");

	pollForJump();
}

async function pollForJump() {
	if (!restClient || !hasWorkspaceLock) return;

	const profileEnd = debugLogger.profileStart("pollForJump");
	try {
		const jumpData = await restClient.getPendingJump();

		if (consecutiveErrors > 0) {
			debugLogger.log(
				`✅ Jump polling recovered, resetting interval to ${JUMP_POLL_MIN_INTERVAL}ms`
			);
		}
		jumpPollIntervalMs = JUMP_POLL_MIN_INTERVAL;
		consecutiveErrors = 0;

		if (jumpData.pending && jumpData.file && jumpData.line) {
			const jumpKey = `${jumpData.file}:${jumpData.line}:${jumpData.column || 0}`;
			const serverTs = jumpData.timestamp || 0;

			// Dedup: skip if we already handled this exact jump (same key AND same server timestamp).
			// This catches stale cached responses that keep returning the same transient data.
			if (
				lastHandledJumpKey === jumpKey &&
				serverTs <= lastHandledJumpTimestamp
			) {
				debugLogger.log(`⏭️ Skipping already-consumed jump: ${jumpKey} (ts=${serverTs})`);
				return;
			}

			debugLogger.info(`📍 Jump request: ${jumpData.file}:${jumpData.line}`);

			if (!currentDevPath) {
				debugLogger.warn(`   ❌ No currentDevPath set, cannot resolve jump`);
				return;
			}

			const devRoot = currentDevPath.replace(/\\/g, "/").replace(/\/$/, "");
			const relFile = jumpData.file.replace(/\\/g, "/").replace(/^\/+/, "");
			if (relFile.includes("..")) {
				debugLogger.warn(`   ❌ Ignoring unsafe jump path: ${jumpData.file}`);
				return;
			}
			const fullPath = `${devRoot}/${relFile}`;

			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			let fileUri: vscode.Uri;

			if (workspaceFolder && workspaceFolder.uri.scheme !== "file") {
				fileUri = workspaceFolder.uri.with({ path: fullPath });
			} else {
				fileUri = vscode.Uri.file(fullPath);
			}

			debugLogger.info(`   Dev root: ${devRoot}`);
			debugLogger.info(`   File URI: ${fileUri.toString()}`);

			try {
				await vscode.workspace.fs.stat(fileUri);
			} catch {
				debugLogger.warn(`   ❌ Jump file not found in active workspace: ${fullPath}`);
				return;
			}

			const document = await vscode.workspace.openTextDocument(fileUri);
			const editor = await vscode.window.showTextDocument(document, {
				selection: new vscode.Range(
					jumpData.line - 1,
					jumpData.column || 0,
					jumpData.line - 1,
					jumpData.column || 0
				),
				preserveFocus: false,
			});

			editor.revealRange(
				new vscode.Range(jumpData.line - 1, 0, jumpData.line - 1, 0),
				vscode.TextEditorRevealType.InCenter
			);

			if (fileWatcher) {
				fileWatcher.suppressCursorSyncBriefly();
			}

			lastHandledJumpKey = jumpKey;
			lastHandledJumpTimestamp = serverTs;
			debugLogger.info(`✅ Jumped to ${jumpData.file}:${jumpData.line}`);

			// Explicitly clear the server-side transient via POST.
			// GET-side-effect deletion can be defeated by server HTTP caches.
			restClient.clearPendingJump().catch(() => {});
		}
	} catch (error: any) {
		if (
			error.message &&
			!error.message.includes("No pending") &&
			!error.message.includes("404")
		) {
			consecutiveErrors++;

			if (consecutiveErrors > 1) {
				jumpPollIntervalMs = Math.min(
					jumpPollIntervalMs * 2,
					JUMP_POLL_MAX_INTERVAL
				);
				const jitter = jumpPollIntervalMs * 0.25 * (Math.random() - 0.5);
				jumpPollIntervalMs = Math.round(jumpPollIntervalMs + jitter);
			}

			if (consecutiveErrors <= 2 || consecutiveErrors % 10 === 0) {
				debugLogger.log(
					`⚠️ Jump poll error (${consecutiveErrors}x): ${error.message} — interval: ${jumpPollIntervalMs}ms, devPath: ${currentDevPath}`
				);
			}
		}
	} finally {
		profileEnd();
		jumpPollingInterval = setTimeout(pollForJump, jumpPollIntervalMs);
	}
}

function stopJumpPolling() {
	if (jumpPollingInterval) {
		clearTimeout(jumpPollingInterval);
		jumpPollingInterval = null;
		jumpPollIntervalMs = JUMP_POLL_MIN_INTERVAL;
		consecutiveErrors = 0;
		lastHandledJumpKey = null;
		lastHandledJumpTimestamp = 0;
		debugLogger.log("📍 Jump-to-code polling stopped");
	}
}

/**
 * Perform metadata cleanup
 * Removes orphaned metadata files for deleted posts/folders
 */
async function performMetadataCleanup() {
	if (!restClient) {
		return;
	}

	try {
		const result = await restClient.cleanupMetadata();

		if (result.deleted > 0) {
			debugLogger.info(
				`🧹 Metadata cleanup: ${result.deleted} orphaned file(s) removed, ${result.kept} kept`
			);
		}
	} catch (error: any) {
		// Silent fail - don't interrupt normal operation
		debugLogger.log(`⚠️ Metadata cleanup error: ${error.message}`);
	}
}

/**
 * Start periodic metadata cleanup (every 5 minutes)
 */
function startMetadataCleanup() {
	if (metadataCleanupInterval) {
		clearInterval(metadataCleanupInterval);
	}

	debugLogger.log("🧹 Starting periodic metadata cleanup (every 5 minutes)...");

	metadataCleanupInterval = setInterval(async () => {
		await performMetadataCleanup();
	}, 5 * 60 * 1000); // 5 minutes
}

/**
 * Stop metadata cleanup interval
 */
function stopMetadataCleanup() {
	if (metadataCleanupInterval) {
		clearInterval(metadataCleanupInterval);
		metadataCleanupInterval = null;
		debugLogger.log("🧹 Metadata cleanup stopped");
	}
}

/**
 * Prompt user for a local dev folder path.
 * Uses showInputBox instead of showOpenDialog because in Remote SSH sessions
 * the file picker shows the server filesystem, not the local machine.
 */
async function promptForLocalDevFolder(
	prompt: string
): Promise<string | undefined> {
	const isRemoteSession =
		typeof vscode.env.remoteName === "string" && vscode.env.remoteName !== "";

	if (!isRemoteSession) {
		const folderUri = await vscode.window.showOpenDialog({
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
			openLabel: "Select Dev Folder",
			title: prompt,
		});
		if (!folderUri || folderUri.length === 0) return undefined;
		return folderUri[0].fsPath;
	}

	// Remote SSH: use showSaveDialog which opens on the LOCAL machine
	// (same mechanism as the built-in "Download..." command).
	// The user picks a location + names the folder, we use that as the dev folder path.
	const config = vscode.workspace.getConfiguration("skylit");
	const siteUrl = config.get<string>("siteUrl", "");
	const suggestedName = siteUrl
		? new URL(siteUrl).hostname.split(".")[0] + "-dev-root"
		: "skylit-dev-root";

	const saveUri = await vscode.window.showSaveDialog({
		saveLabel: "Download Here",
		title: "Choose where to download your dev folder",
		defaultUri: vscode.Uri.from({ scheme: "file", path: `/${suggestedName}` }),
	});

	if (!saveUri) return undefined;

	const selectedPath = saveUri.fsPath;
	debugLogger.info(`📁 User selected local dev folder: ${selectedPath}`);
	return selectedPath;
}

/**
 * Relocation request polling
 * Polls the plugin for pending relocation requests initiated from the WP admin panel.
 * When a request is found, prompts the user to choose a local folder and performs the relocation.
 */
const RELOCATE_POLL_INTERVAL = 5000; // 5 seconds

function startRelocatePolling() {
	if (relocatePollingInterval) {
		clearTimeout(relocatePollingInterval);
	}
	debugLogger.log(
		"🔄 Starting relocation request polling (every 5 seconds)..."
	);
	pollForRelocate();
}

function stopRelocatePolling() {
	if (relocatePollingInterval) {
		clearTimeout(relocatePollingInterval);
		relocatePollingInterval = null;
		debugLogger.log("🔄 Relocation request polling stopped");
	}
}

async function pollForRelocate() {
	if (!restClient) {
		relocatePollingInterval = setTimeout(
			pollForRelocate,
			RELOCATE_POLL_INTERVAL
		);
		return;
	}

	try {
		const data = await restClient.getPendingRelocate();

		if (data.pending) {
			debugLogger.info(
				`🔄 Relocation request received from plugin (action: ${data.action})`
			);
			await handlePluginRelocateRequest(data.action || "pull-local");
		}
	} catch {
		// Silent fail - plugin may not have the endpoint yet
	}

	relocatePollingInterval = setTimeout(pollForRelocate, RELOCATE_POLL_INTERVAL);
}

async function handlePluginRelocateRequest(action: string) {
	if (!restClient) return;

	// Prompt user to type a local path (showOpenDialog shows remote filesystem in SSH sessions)
	const newPath = await promptForLocalDevFolder(
		"WordPress requested dev folder relocation. Enter the local path where your dev folder should live."
	);

	if (!newPath) {
		await restClient.ackRelocate(false, "");
		debugLogger.info("🔄 Relocation cancelled by user");
		return;
	}

	try {
		// Download all posts from WordPress
		const manifest = await restClient.getExportAll();

		const confirm = await vscode.window.showWarningMessage(
			`WordPress wants to move the dev folder here.\n\n` +
				`${manifest.count} posts will be downloaded to:\n${newPath}\n\n` +
				`The extension will switch to remote mode.`,
			{ modal: true },
			"Download & Switch",
			"Cancel"
		);

		if (confirm !== "Download & Switch") {
			await restClient.ackRelocate(false, "");
			return;
		}

		const tempPoller = new ExportPoller(
			restClient,
			newPath,
			statusBar,
			debugLogger
		);

		const result = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: "Downloading posts from WordPress...",
				cancellable: false,
			},
			async (progress) => {
				progress.report({
					message: `Downloading ${manifest.count} posts...`,
				});
				return tempPoller.performFullSync();
			}
		);

		if (result.failed) {
			vscode.window.showErrorMessage(
				"Relocation failed: could not fetch manifest from WordPress."
			);
			await restClient.ackRelocate(false, newPath);
			return;
		}

		debugLogger.info(`📦 Downloaded ${result.synced} posts to ${newPath}`);

		// Save settings for remote mode
		const currentSiteUrl = restClient.getSiteUrl();
		const vscodeConfig = vscode.workspace.getConfiguration("skylit");
		await vscodeConfig.update(
			"localDevPath",
			newPath,
			vscode.ConfigurationTarget.Workspace
		);
		if (!vscodeConfig.get<string>("siteUrl", "")) {
			await vscodeConfig.update(
				"siteUrl",
				currentSiteUrl,
				vscode.ConfigurationTarget.Workspace
			);
		}

		// Switch to remote mode
		isRemoteMode = true;
		currentDevPath = newPath;

		// Restart file watcher on new path
		if (fileWatcher) {
			fileWatcher.dispose();
		}
	fileWatcher = new FileWatcher(
		newPath,
		restClient,
		statusBar,
		debugLogger,
		newPath,
		isRemoteMode
	);
	await fileWatcher.start();
	// Media sync runs in the background — never blocks jump polling or import.
	fileWatcher.refreshMediaSyncSettings().catch((mediaErr: any) => {
		debugLogger.log(`⚠️ Media sync init failed: ${mediaErr?.message || mediaErr}`);
	});

	// Start export poller
	if (exportPoller) {
		exportPoller.dispose();
	}
	exportPoller = new ExportPoller(
		restClient,
		newPath,
		statusBar,
		debugLogger
	);
	exportPoller.start();

		// Restart post type converter
		if (postTypeConverter) {
			postTypeConverter.dispose();
		}
		postTypeConverter = new PostTypeConverter(restClient, newPath, debugLogger);
		postTypeConverter.startWatching();

		statusBar.updateStatus("connected", "Remote");

		// Acknowledge success back to the plugin
		await restClient.ackRelocate(true, newPath);

		if (result.errors > 0) {
			vscode.window.showWarningMessage(
				`Relocated with ${result.synced} posts downloaded (${result.errors} errors). Check Output panel.`
			);
		} else {
			vscode.window.showInformationMessage(
				`Dev folder relocated to ${newPath}. ${result.synced} posts downloaded. Now running in remote mode.`
			);
		}
	} catch (error: any) {
		debugLogger.log(`❌ Plugin-initiated relocation failed: ${error.message}`);
		await restClient.ackRelocate(false, "");
		vscode.window.showErrorMessage(`Relocation failed: ${error.message}`);
	}
}
