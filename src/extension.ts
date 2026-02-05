/**
 * Skylit Dev I/O - VS Code/Cursor Extension
 * Main entry point
 */

import * as vscode from "vscode";
import * as path from "path";
import { WorkspaceManager } from "./workspaceManager";
import { AuthManager } from "./authManager";
import { FileWatcher } from "./fileWatcher";
import { RestClient } from "./restClient";
import { StatusBar } from "./statusBar";
import { ProtocolHandler } from "./protocolHandler";
import { DebugLogger } from "./debugLogger";
import { PostTypeConverter } from "./postTypeConverter";
import { ConnectionState } from "./types";

let workspaceManager: WorkspaceManager;
let authManager: AuthManager;
let fileWatcher: FileWatcher | null = null;
let restClient: RestClient | null = null;
let statusBar: StatusBar;
let protocolHandler: ProtocolHandler;
let debugLogger: DebugLogger;
let postTypeConverter: PostTypeConverter | null = null;
let statusCheckInterval: NodeJS.Timeout | null = null;
let metadataCleanupInterval: NodeJS.Timeout | null = null;
let currentDevPath: string | null = null;

/**
 * Extension activation
 */
export async function activate(context: vscode.ExtensionContext) {
	const outputChannel =
		vscode.window.createOutputChannel("Skylit.DEV I/O");
	debugLogger = new DebugLogger(outputChannel);
	debugLogger.info("🚀 Skylit.DEV I/O extension activated");

	// Initialize managers
	workspaceManager = new WorkspaceManager(debugLogger);
	authManager = new AuthManager(context, debugLogger);
	statusBar = new StatusBar(debugLogger);
	protocolHandler = new ProtocolHandler(debugLogger);

	// Register protocol handler
	protocolHandler.register(context);

	// Register commands
	registerCommands(context);

	// Detect WordPress sites in workspace
	const sites = await workspaceManager.detectWordPressSites();

	if (sites.length === 0) {
		debugLogger.warn(
			"⚠️ No WordPress sites with Skylit.DEV plugin detected"
		);
		debugLogger.info("ℹ️ Make sure:");
		debugLogger.info(
			"   1. WordPress is in your workspace (or in a subdirectory like public_html/)"
		);
		debugLogger.info(
			"   2. Skylit.DEV plugin is installed and activated"
		);
		statusBar.updateStatus(
			"disconnected",
			"No Skylit.DEV detected"
		);

		// Show helpful notification
		vscode.window
			.showWarningMessage(
				"Skylit.DEV plugin not detected. Install and activate the plugin in WordPress.",
				"Learn More"
			)
			.then((selection) => {
				if (selection === "Learn More") {
					vscode.env.openExternal(
						vscode.Uri.parse(
							"https://skylit.dev/docs/getting-started"
						)
					);
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

	// Check if auto-connect is enabled (default: true)
	const config = vscode.workspace.getConfiguration("skylit");
	const autoConnect = config.get<boolean>("autoConnect", true);

	if (autoConnect) {
		debugLogger.log(
			"🔄 Auto-connect enabled, attempting connection..."
		);

		// Auto-connect to the first site (or let user choose if multiple)
		const siteToConnect = sites[0];

		try {
			await connectToWordPress(siteToConnect, context, true); // Pass true for isAutoConnect
		} catch (error: any) {
			debugLogger.warn(
				`⚠️ Auto-connect failed: ${error.message}`
			);
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
		statusBar.updateStatus(
			"disconnected",
			"Click to connect to WordPress"
		);
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

	if (fileWatcher) {
		fileWatcher.dispose();
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

/**
 * Register command palette actions
 */
function registerCommands(context: vscode.ExtensionContext) {
	// Scan for WordPress command
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"skylit.scanWorkspace",
			async () => {
				debugLogger.show(); // Show output channel
				debugLogger.log(
					"🔍 Manual WordPress scan triggered..."
				);

				const sites =
					await workspaceManager.detectWordPressSites();

				if (sites.length === 0) {
					vscode.window
						.showWarningMessage(
							"No WordPress sites with Skylit.DEV plugin found. Check Output panel for details.",
							"View Output"
						)
						.then((selection) => {
							if (
								selection ===
								"View Output"
							) {
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
						if (
							selection ===
							"Connect Now"
						) {
							vscode.commands.executeCommand(
								"skylit.connect"
							);
						} else if (
							selection ===
							"Setup Token"
						) {
							vscode.commands.executeCommand(
								"skylit.setupToken"
							);
						}
					});
			}
		)
	);

	// Connect command
	context.subscriptions.push(
		vscode.commands.registerCommand("skylit.connect", async () => {
			debugLogger.log("🔌 Manual connection requested...");

			const sites =
				await workspaceManager.detectWordPressSites();

			if (sites.length === 0) {
				vscode.window
					.showErrorMessage(
						"No WordPress sites found in workspace",
						"Scan Workspace"
					)
					.then((selection) => {
						if (
							selection ===
							"Scan Workspace"
						) {
							vscode.commands.executeCommand(
								"skylit.scanWorkspace"
							);
						}
					});
				return;
			}

			// If multiple sites, let user choose
			let selectedSite = sites[0];
			if (sites.length > 1) {
				const choice =
					await vscode.window.showQuickPick(
						sites.map((s) => ({
							label: s.name,
							description: s.siteUrl,
							site: s,
						})),
						{
							placeHolder:
								"Select WordPress site to connect",
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
		vscode.commands.registerCommand(
			"skylit.disconnect",
			async () => {
				// Stop status check interval
				if (statusCheckInterval) {
					clearInterval(statusCheckInterval);
					statusCheckInterval = null;
				}

				// Stop jump polling
				stopJumpPolling();

				// Stop metadata cleanup
				stopMetadataCleanup();

				if (fileWatcher) {
					fileWatcher.dispose();
					fileWatcher = null;
				}
				if (postTypeConverter) {
					postTypeConverter.dispose();
					postTypeConverter = null;
				}
				restClient = null;
				currentDevPath = null;
				statusBar.updateStatus(
					"disconnected",
					"Disconnected"
				);
				debugLogger.info(
					"🔌 Disconnected from WordPress"
				);
			}
		)
	);

	// Setup token command
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"skylit.setupToken",
			async () => {
				const sites =
					await workspaceManager.detectWordPressSites();
				if (sites.length === 0) {
					vscode.window.showErrorMessage(
						"No WordPress sites found in workspace"
					);
					return;
				}

				const site = sites[0]; // TODO: Support multiple sites
				const token = await vscode.window.showInputBox({
					prompt: `Enter auth token for ${site.name}`,
					placeHolder: "skylit_abc123...",
					password: true,
					ignoreFocusOut: true,
				});

				if (!token) return;

				await authManager.saveToken(
					site.siteUrl,
					token
				);
				debugLogger.info(
					"✅ Auth token saved! Connecting..."
				);
				await connectToWordPress(site, context);
			}
		)
	);

	// Sync current file command
	context.subscriptions.push(
		vscode.commands.registerCommand("skylit.syncNow", async () => {
			if (!restClient) {
				vscode.window.showErrorMessage(
					"Not connected to WordPress"
				);
				return;
			}

			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showWarningMessage(
					"No file open"
				);
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

	// Convert post type command (for manually triggering post type conversion)
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"skylit.convertPostType",
			async () => {
				if (!restClient) {
					vscode.window.showErrorMessage(
						"Not connected to WordPress"
					);
					return;
				}

				// Get current folder from explorer or active editor
				let folderPath: string | undefined;

				// Check if the user has a folder selected in the explorer
				const explorerSelection =
					vscode.window.activeTextEditor?.document
						.uri.fsPath;
				if (explorerSelection) {
					folderPath =
						path.dirname(explorerSelection);
				}

				// Prompt user to enter/confirm folder name
				const folderName =
					await vscode.window.showInputBox({
						prompt: "Enter the folder name with ID suffix (e.g., service_549)",
						placeHolder: "folder_123",
						value: folderPath
							? path.basename(
									folderPath
							  )
							: "",
						validateInput: (value) => {
							if (
								!/_\d+$/.test(
									value
								)
							) {
								return "Folder must have ID suffix (e.g., service_549)";
							}
							return null;
						},
					});

				if (!folderName) {
					return;
				}

				// Extract post ID
				const match = folderName.match(/_(\d+)$/);
				if (!match) {
					vscode.window.showErrorMessage(
						"Invalid folder name - must have _ID suffix"
					);
					return;
				}
				const postId = parseInt(match[1]);

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

				const targetType =
					await vscode.window.showQuickPick(
						postTypeOptions,
						{
							placeHolder:
								"Select the target post type",
						}
					);

				if (!targetType) {
					return;
				}

				// Confirm with user
				const confirm =
					await vscode.window.showWarningMessage(
						`Convert post ID ${postId} to "${targetType.label}"?`,
						{ modal: true },
						"Convert"
					);

				if (confirm !== "Convert") {
					return;
				}

				try {
					debugLogger.log(
						`Converting post ${postId} to ${targetType.value}`
					);

					const response =
						await restClient.convertPostType(
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
							`Failed to convert: ${
								response.message ||
								"Unknown error"
							}`
						);
					}
				} catch (error: any) {
					vscode.window.showErrorMessage(
						`Failed to convert post type: ${error.message}`
					);
				}
			}
		)
	);

	// Request WordPress ID command (create post for folder without valid ID)
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"skylit.requestPostId",
			async (uri?: vscode.Uri) => {
				if (!restClient) {
					vscode.window.showErrorMessage(
						"Not connected to WordPress"
					);
					return;
				}

				if (!currentDevPath) {
					vscode.window.showErrorMessage(
						"Dev folder not configured"
					);
					return;
				}

				// Get folder path from context menu, explorer selection, or active editor
				let folderPath: string | undefined;

				if (uri) {
					// Called from context menu on a folder/file
					folderPath = uri.fsPath;
					// If it's a file, get its parent folder
					if (path.extname(folderPath)) {
						folderPath =
							path.dirname(
								folderPath
							);
					}
				} else {
					// Try to get from active editor
					const editor =
						vscode.window.activeTextEditor;
					if (editor) {
						folderPath = path.dirname(
							editor.document.uri
								.fsPath
						);
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
				const relativePath = folderPath.replace(
					currentDevPath.replace(/\\/g, "/") +
						"/",
					""
				);
				let postType: string;

				if (
					relativePath.startsWith(
						"post-types/pages/"
					)
				) {
					postType = "page";
				} else if (
					relativePath.startsWith(
						"post-types/posts/"
					)
				) {
					postType = "post";
				} else if (
					relativePath.startsWith("templates/")
				) {
					postType = "wp_template";
				} else if (relativePath.startsWith("parts/")) {
					postType = "wp_template_part";
				} else if (
					relativePath.startsWith("patterns/")
				) {
					postType = "wp_block";
				} else {
					// Ask user for post type
					const typeChoice =
						await vscode.window.showQuickPick(
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
								placeHolder:
									"Select post type for this folder",
							}
						);

					if (!typeChoice) return;
					postType = typeChoice.value;
				}

				// Extract slug (remove any existing _ID suffix if present)
				const slug = folderName.replace(/_\d+$/, "");

				// Confirm with user
				const confirm =
					await vscode.window.showWarningMessage(
						`Create WordPress ${postType} from "${folderName}"?`,
						{
							modal: true,
							detail: `This will:\n1. Create a new ${postType} in WordPress with slug "${slug}"\n2. Rename the folder to include the new post ID\n3. Update all files to match`,
						},
						"Create Post",
						"Cancel"
					);

				if (confirm !== "Create Post") {
					return;
				}

				try {
					debugLogger.log(
						`📄 Creating ${postType} for folder: ${folderName}`
					);

					// Call REST API to create post
					const response =
						await restClient.createPostFromFolder(
							relativePath,
							postType,
							false // Don't skip rename - let server do it
						);

					if (response.success) {
						const newId = response.post_id;
						const newFolder =
							response.new_folder ||
							`${slug}_${newId}`;

						vscode.window.showInformationMessage(
							`✅ Created ${postType} "${response.title}" (ID: ${newId})`
						);

						debugLogger.log(
							`✅ Post created: ID=${newId}, folder renamed to ${newFolder}`
						);

						// The server should have renamed the folder, but we might need to refresh
						// If the server didn't rename (skip_rename was false), open the new file
						if (response.new_folder) {
							// Determine new file path
							let newBasePath: string;
							if (
								postType ===
								"wp_template"
							) {
								newBasePath = `templates/${response.new_folder}`;
							} else if (
								postType ===
								"wp_template_part"
							) {
								newBasePath = `parts/${response.new_folder}`;
							} else if (
								postType ===
								"wp_block"
							) {
								newBasePath = `patterns/${response.new_folder}`;
							} else {
								newBasePath = `post-types/${postType}s/${response.new_folder}`;
							}

							const newHtmlPath =
								path.join(
									currentDevPath,
									newBasePath,
									`${response.new_folder}.html`
								);

							// Try to open the new file
							try {
								const doc =
									await vscode.workspace.openTextDocument(
										newHtmlPath
									);
								await vscode.window.showTextDocument(
									doc
								);
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
								response.error ||
								response.message ||
								"Unknown error"
							}`
						);
					}
				} catch (error: any) {
					vscode.window.showErrorMessage(
						`Failed to create post: ${error.message}`
					);
					debugLogger.log(
						`❌ Request post ID failed: ${error.message}`
					);
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
					vscode.window.showErrorMessage(
						"Not connected to WordPress"
					);
					return;
				}

				if (!currentDevPath) {
					vscode.window.showErrorMessage(
						"Dev folder not configured"
					);
					return;
				}

				// Get folder path from context menu, explorer selection, or active editor
				let folderPath: string | undefined;

				if (uri) {
					// Called from context menu on a folder/file
					folderPath = uri.fsPath;
					// If it's a file, get its parent folder
					if (path.extname(folderPath)) {
						folderPath =
							path.dirname(
								folderPath
							);
					}
				} else {
					// Try to get from active editor
					const editor =
						vscode.window.activeTextEditor;
					if (editor) {
						folderPath = path.dirname(
							editor.document.uri
								.fsPath
						);
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

				// Extract post ID from folder name
				const idMatch = folderName.match(/_(\d+)$/);
				if (!idMatch) {
					vscode.window.showErrorMessage(
						`Folder "${folderName}" does not have a post ID suffix (e.g., my-page_123)`
					);
					return;
				}

				const postId = parseInt(idMatch[1], 10);

				// Show management options
				const statusOption = "Change Status";
				const slugOption = "Rename Slug";
				const titleOption = "Rename Title";
				const scheduleOption = "Schedule Post";
				const cancelOption = "Cancel";

				const choice =
					await vscode.window.showQuickPick(
						[
							{
								label: "$(edit) Change Status",
								description:
									"Publish, Draft, Pending, Private, or Schedule",
								value: statusOption,
							},
							{
								label: "$(symbol-text) Rename Slug",
								description:
									"Change the URL slug (e.g., my-page → new-page)",
								value: slugOption,
							},
							{
								label: "$(whole-word) Rename Title",
								description:
									"Change the post title",
								value: titleOption,
							},
							{
								label: "$(calendar) Schedule Post",
								description:
									"Set a future publish date/time",
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
						const statusChoice =
							await vscode.window.showQuickPick(
								[
									{
										label: "$(check) Publish",
										description:
											"Make post public",
										value: "publish",
									},
									{
										label: "$(edit) Draft",
										description:
											"Save as draft",
										value: "draft",
									},
									{
										label: "$(clock) Pending Review",
										description:
											"Submit for review",
										value: "pending",
									},
									{
										label: "$(lock) Private",
										description:
											"Only visible to admins",
										value: "private",
									},
									{
										label: "$(calendar) Schedule for Later",
										description:
											"Set future publish date",
										value: "future",
									},
								],
								{
									placeHolder:
										"Select new status",
								}
							);

						if (!statusChoice) return;

						let scheduledDate:
							| string
							| undefined;

						if (
							statusChoice.value ===
							"future"
						) {
							// Prompt for date and time
							const dateStr =
								await vscode.window.showInputBox(
									{
										prompt: "Enter publish date and time",
										placeHolder:
											"YYYY-MM-DD HH:MM:SS (e.g., 2026-02-10 14:30:00)",
										validateInput:
											(
												value
											) => {
												// Basic validation for date format
												if (
													!/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(
														value
													)
												) {
													return "Invalid format. Use: YYYY-MM-DD HH:MM:SS";
												}
												return null;
											},
									}
								);

							if (!dateStr) return;
							scheduledDate = dateStr;
						}

						statusBar.showSyncing(
							"Updating status..."
						);

						const response =
							await restClient.updatePostMeta(
								postId,
								{
									status: statusChoice.value,
									scheduled_date:
										scheduledDate,
								}
							);

						if (response.success) {
							statusBar.showSuccess(
								"Status updated"
							);
							vscode.window.showInformationMessage(
								`✅ Post status changed to "${statusChoice.label.replace(
									/\$\(.*?\)\s*/,
									""
								)}"`
							);
						} else {
							statusBar.showError(
								"Update failed"
							);
							vscode.window.showErrorMessage(
								`Failed to update status: ${
									response.message ||
									"Unknown error"
								}`
							);
						}
					} else if (
						choice.value === slugOption
					) {
						// Rename slug
						const currentSlug =
							folderName.replace(
								/_\d+$/,
								""
							);
						const newSlug =
							await vscode.window.showInputBox(
								{
									prompt: "Enter new slug (URL-friendly name)",
									placeHolder:
										"my-new-slug",
									value: currentSlug,
									validateInput:
										(
											value
										) => {
											if (
												!/^[a-z0-9-]+$/.test(
													value
												)
											) {
												return "Slug must contain only lowercase letters, numbers, and hyphens";
											}
											return null;
										},
								}
							);

						if (
							!newSlug ||
							newSlug === currentSlug
						) {
							return;
						}

						statusBar.showSyncing(
							"Renaming slug..."
						);

						const response =
							await restClient.updatePostMeta(
								postId,
								{
									slug: newSlug,
								}
							);

						if (response.success) {
							statusBar.showSuccess(
								"Slug updated"
							);
							vscode.window.showInformationMessage(
								`✅ Slug changed to "${newSlug}". Folder will be renamed automatically.`
							);
							debugLogger.log(
								`✅ Slug updated: ${currentSlug} → ${newSlug}`
							);
						} else {
							statusBar.showError(
								"Update failed"
							);
							vscode.window.showErrorMessage(
								`Failed to update slug: ${
									response.message ||
									"Unknown error"
								}`
							);
						}
					} else if (
						choice.value === titleOption
					) {
						// Rename title
						const newTitle =
							await vscode.window.showInputBox(
								{
									prompt: "Enter new title",
									placeHolder:
										"My New Title",
								}
							);

						if (!newTitle) return;

						statusBar.showSyncing(
							"Updating title..."
						);

						const response =
							await restClient.updatePostMeta(
								postId,
								{
									title: newTitle,
								}
							);

						if (response.success) {
							statusBar.showSuccess(
								"Title updated"
							);
							vscode.window.showInformationMessage(
								`✅ Title changed to "${newTitle}"`
							);
							debugLogger.log(
								`✅ Title updated for post ${postId}`
							);
						} else {
							statusBar.showError(
								"Update failed"
							);
							vscode.window.showErrorMessage(
								`Failed to update title: ${
									response.message ||
									"Unknown error"
								}`
							);
						}
					} else if (
						choice.value === scheduleOption
					) {
						// Schedule post
						const dateStr =
							await vscode.window.showInputBox(
								{
									prompt: "Enter publish date and time",
									placeHolder:
										"YYYY-MM-DD HH:MM:SS (e.g., 2026-02-10 14:30:00)",
									validateInput:
										(
											value
										) => {
											if (
												!/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(
													value
												)
											) {
												return "Invalid format. Use: YYYY-MM-DD HH:MM:SS";
											}
											return null;
										},
								}
							);

						if (!dateStr) return;

						statusBar.showSyncing(
							"Scheduling post..."
						);

						const response =
							await restClient.updatePostMeta(
								postId,
								{
									status: "future",
									scheduled_date:
										dateStr,
								}
							);

						if (response.success) {
							statusBar.showSuccess(
								"Post scheduled"
							);
							vscode.window.showInformationMessage(
								`✅ Post scheduled for ${dateStr}`
							);
						} else {
							statusBar.showError(
								"Scheduling failed"
							);
							vscode.window.showErrorMessage(
								`Failed to schedule post: ${
									response.message ||
									"Unknown error"
								}`
							);
						}
					}
				} catch (error: any) {
					statusBar.showError(
						`Failed: ${error.message}`
					);
					vscode.window.showErrorMessage(
						`Failed to update post: ${error.message}`
					);
					debugLogger.log(
						`❌ Manage post failed: ${error.message}`
					);
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
					vscode.window.showErrorMessage(
						"Not connected to WordPress"
					);
					return;
				}

				if (!currentDevPath) {
					vscode.window.showErrorMessage(
						"Dev folder not configured"
					);
					return;
				}

				// Get folder path from context menu, explorer selection, or active editor
				let folderPath: string | undefined;

				if (uri) {
					// Called from context menu on a folder/file
					folderPath = uri.fsPath;
					// If it's a file, get its parent folder
					if (path.extname(folderPath)) {
						folderPath =
							path.dirname(
								folderPath
							);
					}
				} else {
					// Try to get from active editor
					const editor =
						vscode.window.activeTextEditor;
					if (editor) {
						folderPath = path.dirname(
							editor.document.uri
								.fsPath
						);
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

				// Extract post ID from folder name
				const idMatch = folderName.match(/_(\d+)$/);
				if (!idMatch) {
					vscode.window.showErrorMessage(
						`Folder "${folderName}" does not have a post ID suffix (e.g., my-page_123)`
					);
					return;
				}

				const postId = parseInt(idMatch[1], 10);

				// Show delete options
				const trashOption = "Move to Trash";
				const deleteOption = "Delete Permanently";
				const cancelOption = "Cancel";

				const choice =
					await vscode.window.showWarningMessage(
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

				const action =
					choice === trashOption
						? "trash"
						: "delete";

				try {
					// Mark this post to skip the FileWatcher prompt (already confirmed by user)
					if (fileWatcher) {
						fileWatcher.markPostForDeletion(
							postId
						);
					}

					statusBar.showSyncing(
						`${
							action === "trash"
								? "Trashing"
								: "Deleting"
						}...`
					);

					const response =
						await restClient.sendFolderAction(
							postId,
							action
						);

					if (response.success) {
						const actionVerb =
							action === "trash"
								? "moved to trash"
								: "permanently deleted";
						debugLogger.log(
							`✅ Post ${postId} ${actionVerb}`
						);

						// Delete local folder
						try {
							const fs = await import(
								"fs"
							);
							if (
								fs.existsSync(
									folderPath
								)
							) {
								fs.rmSync(
									folderPath,
									{
										recursive: true,
									}
								);
								debugLogger.log(
									`🗑️ Deleted local folder: ${folderName}`
								);
							}
						} catch (fsError: any) {
							debugLogger.log(
								`⚠️ Could not delete local folder: ${fsError.message}`
							);
						}

						// Delete metadata file for permanent deletes
						if (action === "delete") {
							try {
								const fs =
									await import(
										"fs"
									);
								const metadataPath =
									path.join(
										currentDevPath,
										".skylit",
										"metadata",
										`${postId}.json`
									);
								if (
									fs.existsSync(
										metadataPath
									)
								) {
									fs.unlinkSync(
										metadataPath
									);
									debugLogger.log(
										`🗑️ Deleted metadata file: ${postId}.json`
									);
								}
							} catch (metaError: any) {
								debugLogger.log(
									`⚠️ Could not delete metadata file: ${metaError.message}`
								);
							}
						}

						statusBar.showSuccess(
							`Post ${actionVerb}`
						);
						vscode.window.showInformationMessage(
							`✅ Post ${postId} ${actionVerb} from WordPress`
						);
					} else {
						statusBar.showError(
							"Action failed"
						);
						vscode.window.showErrorMessage(
							`Failed to ${action} post: ${
								response.message ||
								"Unknown error"
							}`
						);
					}
				} catch (error: any) {
					statusBar.showError(
						`Failed: ${error.message}`
					);
					vscode.window.showErrorMessage(
						`Failed to ${action} post ${postId}: ${error.message}`
					);
					debugLogger.log(
						`❌ Delete post failed: ${error.message}`
					);
				}
			}
		)
	);

	// Show menu command
	context.subscriptions.push(
		vscode.commands.registerCommand("skylit.showMenu", async () => {
			// If disconnected or error, show quick connect options
			if (
				statusBar["connectionState"] ===
					"disconnected" ||
				statusBar["connectionState"] === "error"
			) {
				const items = [
					{
						label: "🔌 Connect to WordPress",
						command: "skylit.connect",
						description:
							"Connect to detected WordPress site",
					},
					{
						label: "🔑 Setup Auth Token",
						command: "skylit.setupToken",
						description:
							"Enter WordPress auth token",
					},
					{
						label: "🔍 Scan for WordPress",
						command: "skylit.scanWorkspace",
						description:
							"Manually scan workspace for WordPress + Skylit plugin",
					},
				];

				const choice =
					await vscode.window.showQuickPick(
						items,
						{
							placeHolder:
								"Skylit.DEV I/O - Not Connected",
						}
					);

				if (choice) {
					vscode.commands.executeCommand(
						choice.command
					);
				}
			} else {
				// Connected - show all actions
				const items = [
					{
						label: "🔄 Sync Current File",
						command: "skylit.syncNow",
						description:
							"Force sync the active file",
					},
					{
						label: "❌ Disconnect",
						command: "skylit.disconnect",
						description:
							"Disconnect from WordPress",
					},
					{
						label: "🔍 Scan for WordPress",
						command: "skylit.scanWorkspace",
						description:
							"Manually scan workspace for WordPress + Skylit plugin",
					},
					{
						label: "🔑 Setup Auth Token",
						command: "skylit.setupToken",
						description:
							"Enter WordPress auth token",
					},
				];

				const choice =
					await vscode.window.showQuickPick(
						items,
						{
							placeHolder:
								"Skylit.DEV I/O Actions",
						}
					);

				if (choice) {
					vscode.commands.executeCommand(
						choice.command
					);
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
	debugLogger.info(`🔌 Connecting to ${site.name}...`);
	statusBar.updateStatus("connecting", "Connecting...");

	try {
		// Check if site URL is localhost and prompt for actual URL
		let siteUrl = site.siteUrl;
		if (
			siteUrl === "http://localhost" ||
			siteUrl === "https://localhost"
		) {
			debugLogger.warn(`⚠️ Default localhost URL detected`);

			// Don't prompt during auto-connect, just fail gracefully
			if (isAutoConnect) {
				debugLogger.info(
					'💡 Please set "skylit.siteUrl" in VS Code settings'
				);
				statusBar.updateStatus(
					"disconnected",
					"Configure site URL"
				);
				return;
			}

			// Prompt user for actual URL
			const userUrl = await vscode.window.showInputBox({
				prompt: "Enter your WordPress site URL",
				placeHolder:
					"https://palegreen-capybara-849923.hostingersite.com",
				value: siteUrl,
				ignoreFocusOut: true,
			});

			if (!userUrl || userUrl.trim() === "") {
				statusBar.updateStatus(
					"disconnected",
					"Connection cancelled"
				);
				return;
			}

			siteUrl = userUrl.trim().replace(/\/$/, "");
			site.siteUrl = siteUrl;
			debugLogger.info(`✅ Using URL: ${siteUrl}`);

			// Save to settings for future use
			const vscodeConfig =
				vscode.workspace.getConfiguration("skylit");
			await vscodeConfig.update(
				"siteUrl",
				siteUrl,
				vscode.ConfigurationTarget.Workspace
			);
		}

		// Security: Warn if connecting over HTTP (not HTTPS)
		const isLocalhost =
			/^https?:\/\/(localhost|127\.0\.0\.1|::1)/i.test(
				siteUrl
			);
		const isHttps = siteUrl.startsWith("https://");

		if (!isHttps && !isLocalhost) {
			debugLogger.warn(
				"⚠️ Security Warning: Connecting over HTTP"
			);

			const choice = await vscode.window.showWarningMessage(
				"⚠️ Security Warning\n\nYou are connecting over HTTP instead of HTTPS. Your auth token will be transmitted in cleartext and could be intercepted.\n\nUse HTTPS in production for secure communication.",
				{ modal: true },
				"Continue Anyway",
				"Cancel"
			);

			if (choice !== "Continue Anyway") {
				debugLogger.info(
					"❌ User cancelled HTTP connection"
				);
				statusBar.updateStatus(
					"disconnected",
					"Connection cancelled (use HTTPS)"
				);
				return;
			}

			debugLogger.warn(
				"⚠️ User acknowledged HTTP security risk and continued"
			);
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
						if (
							selection ===
							"Setup Token"
						) {
							vscode.commands.executeCommand(
								"skylit.setupToken"
							);
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
				statusBar.updateStatus(
					"disconnected",
					"Connection cancelled"
				);
				return;
			}

			token = input;
			await authManager.saveToken(site.siteUrl, token);
		}

		// Create REST client
		restClient = new RestClient(site.siteUrl, token, debugLogger);

		// Validate token
		const isValid = await restClient.validateToken();
		if (!isValid) {
			debugLogger.error("❌ Invalid auth token");

			// Clear the invalid token
			await authManager.clearToken(site.siteUrl);

			if (isAutoConnect) {
				debugLogger.info(
					"💡 Token is invalid or expired. Please setup a new token."
				);
				statusBar.updateStatus(
					"error",
					"Invalid token - Click to setup"
				);

				vscode.window
					.showWarningMessage(
						"Skylit.DEV: Auth token is invalid or expired",
						"Setup New Token",
						"Dismiss"
					)
					.then((selection) => {
						if (
							selection ===
							"Setup New Token"
						) {
							vscode.commands.executeCommand(
								"skylit.setupToken"
							);
						}
					});
				return;
			}

			vscode.window
				.showErrorMessage(
					"Invalid auth token. Please generate a new one in WordPress Admin → Skylit.DEV → Dev Sync",
					"Setup Token"
				)
				.then((selection) => {
					if (selection === "Setup Token") {
						vscode.commands.executeCommand(
							"skylit.setupToken"
						);
					}
				});
			statusBar.updateStatus("error", "Invalid token");
			return;
		}

		debugLogger.info("✅ Token validated");

		// Get plugin status and dev folder from WordPress
		const status = await restClient.getStatus();
		debugLogger.info(
			`✅ Connected to Skylit plugin v${status.version}`
		);
		debugLogger.log(
			`   Dev folder from WordPress: ${status.dev_path}`
		);

		// Validate that WordPress provided a dev folder path
		if (!status.dev_path || status.dev_path.trim() === "") {
			debugLogger.error(
				"❌ WordPress did not provide a dev folder path"
			);
			vscode.window.showErrorMessage(
				"Dev folder not configured in WordPress. Please set it in Admin → Skylit.DEV → Dev Sync"
			);
			statusBar.updateStatus(
				"error",
				"Dev folder not configured"
			);
			return;
		}

		// Initialize file watcher with the dev folder from WordPress API
		// This is the source of truth - it reflects the actual WordPress settings
		if (fileWatcher) {
			fileWatcher.dispose();
		}

		debugLogger.log(
			`👀 Starting file watcher for: ${status.dev_path}`
		);

		fileWatcher = new FileWatcher(
			status.dev_path,
			restClient,
			statusBar,
			debugLogger
		);

		await fileWatcher.start();

		// Store the current dev path
		currentDevPath = status.dev_path;

		// Initialize post type converter
		if (postTypeConverter) {
			postTypeConverter.dispose();
		}
		postTypeConverter = new PostTypeConverter(
			restClient,
			status.dev_path,
			debugLogger
		);
		postTypeConverter.startWatching();
		debugLogger.log("🔄 Post type converter initialized");

		// Start periodic status check (every 60 seconds) to detect dev folder changes
		if (statusCheckInterval) {
			clearInterval(statusCheckInterval);
		}

		statusCheckInterval = setInterval(async () => {
			if (!restClient) return;

			try {
				const updatedStatus =
					await restClient.getStatus();

				// Check if dev folder location changed in WordPress
				if (updatedStatus.dev_path !== currentDevPath) {
					debugLogger.log(
						`🔄 Dev folder changed: ${currentDevPath} → ${updatedStatus.dev_path}`
					);
					debugLogger.log(
						`   Restarting file watcher...`
					);

					// Restart file watcher with new path
					if (fileWatcher) {
						fileWatcher.dispose();
					}

					fileWatcher = new FileWatcher(
						updatedStatus.dev_path,
						restClient,
						statusBar,
						debugLogger
					);

					await fileWatcher.start();
					currentDevPath = updatedStatus.dev_path;

					// Restart post type converter with new path
					if (postTypeConverter) {
						postTypeConverter.dispose();
					}
					postTypeConverter =
						new PostTypeConverter(
							restClient,
							updatedStatus.dev_path,
							debugLogger
						);
					postTypeConverter.startWatching();

					debugLogger.info(
						`✅ Dev folder location updated: ${updatedStatus.dev_path}`
					);
				}
			} catch (error: any) {
				// Silently fail - don't spam errors if WordPress is temporarily unavailable
				debugLogger.log(
					`⚠️ Status check failed: ${error.message}`
				);
			}
		}, 60000); // Check every 60 seconds

		// Start jump-to-code polling (every 500ms for responsiveness)
		startJumpPolling();

		// Run initial metadata cleanup on startup
		performMetadataCleanup();

		// Start periodic metadata cleanup (every 5 minutes)
		startMetadataCleanup();

		statusBar.updateStatus("connected", "Connected");

		// Extract a readable folder path for the notification
		const devPath = status.dev_path.replace(/\\/g, "/");
		let displayMessage = "";

		if (devPath.includes("wp-content")) {
			// Inside WordPress wp-content directory
			const wpContentIndex = devPath.indexOf("wp-content");
			const relativePath = devPath.substring(wpContentIndex);
			displayMessage = `✅ Connected to .../${relativePath}`;
		} else {
			// Outside WordPress (server root level)
			const parts = devPath.split("/").filter((p) => p);
			const folderName =
				parts[parts.length - 1] ||
				parts[parts.length - 2];
			displayMessage = `✅ Connected to /${folderName} (Server Root)`;
		}

		vscode.window.showInformationMessage(displayMessage);
	} catch (error: any) {
		debugLogger.error(`❌ Connection failed: ${error.message}`);
		statusBar.updateStatus("error", "Connection failed");
	}
}

/**
 * Poll for jump-to-code requests with exponential backoff
 */
let jumpPollingInterval: NodeJS.Timeout | null = null;
let jumpPollIntervalMs: number = 500; // Start at 500ms
const JUMP_POLL_MIN_INTERVAL = 500;
const JUMP_POLL_MAX_INTERVAL = 30000; // Max 30 seconds
let consecutiveErrors: number = 0;

function startJumpPolling() {
	if (jumpPollingInterval) {
		clearTimeout(jumpPollingInterval);
	}

	// Reset to default interval
	jumpPollIntervalMs = JUMP_POLL_MIN_INTERVAL;
	consecutiveErrors = 0;

	debugLogger.log("📍 Starting jump-to-code polling...");

	pollForJump();
}

async function pollForJump() {
	if (!restClient) return;

	try {
		const jumpData = await restClient.getPendingJump();

		// Success - reset interval to fast polling
		if (consecutiveErrors > 0) {
			debugLogger.log(
				`✅ Jump polling recovered, resetting interval to ${JUMP_POLL_MIN_INTERVAL}ms`
			);
		}
		jumpPollIntervalMs = JUMP_POLL_MIN_INTERVAL;
		consecutiveErrors = 0;

		if (jumpData.pending && jumpData.file && jumpData.line) {
			debugLogger.log(
				`📍 Jump request received: ${jumpData.file}:${jumpData.line}`
			);
			debugLogger.log(
				`   Current dev path from WordPress: ${currentDevPath}`
			);

			// Get workspace folders to determine if we're in a remote workspace
			const workspaceFolders =
				vscode.workspace.workspaceFolders;
			if (
				!workspaceFolders ||
				workspaceFolders.length === 0
			) {
				debugLogger.log(
					`   ❌ No workspace folder found`
				);
				return;
			}

			const workspaceUri = workspaceFolders[0].uri;
			debugLogger.log(
				`   Workspace URI scheme: ${workspaceUri.scheme}`
			);
			debugLogger.log(
				`   Workspace path: ${workspaceUri.path}`
			);

			// For remote workspaces (SSH, WSL, etc.), construct URI with the same scheme
			// For local workspaces, use file:// scheme
			let fileUri: vscode.Uri;

			if (workspaceUri.scheme !== "file") {
				// Remote workspace - use the workspace's URI scheme
				fileUri = vscode.Uri.from({
					scheme: workspaceUri.scheme,
					authority: workspaceUri.authority,
					path: jumpData.file,
				});
				debugLogger.log(
					`   Using remote URI scheme: ${workspaceUri.scheme}`
				);
			} else {
				// Local workspace - use file:// scheme
				fileUri = vscode.Uri.file(jumpData.file);
				debugLogger.log(`   Using local file scheme`);
			}

			debugLogger.log(`   File URI: ${fileUri.toString()}`);
			debugLogger.log(`   Attempting to open file...`);

			const document =
				await vscode.workspace.openTextDocument(
					fileUri
				);
			debugLogger.log(
				`   ✅ Document opened: ${document.fileName}`
			);

			// Show document with cursor at specified line
			const editor = await vscode.window.showTextDocument(
				document,
				{
					selection: new vscode.Range(
						jumpData.line - 1, // VS Code uses 0-based line numbers
						jumpData.column || 0,
						jumpData.line - 1,
						jumpData.column || 0
					),
					viewColumn: vscode.ViewColumn.One,
				}
			);
			debugLogger.log(
				`   ✅ Editor opened, showing line ${jumpData.line}`
			);

			// Reveal line at center of viewport
			editor.revealRange(
				new vscode.Range(
					jumpData.line - 1,
					0,
					jumpData.line - 1,
					0
				),
				vscode.TextEditorRevealType.InCenter
			);

			debugLogger.info(
				`✅ Successfully jumped to ${jumpData.file}:${jumpData.line}`
			);
		}
	} catch (error: any) {
		// Log actual errors (not just "no pending jumps")
		if (
			error.message &&
			!error.message.includes("No pending") &&
			!error.message.includes("404")
		) {
			consecutiveErrors++;

			// Exponential backoff with jitter
			if (consecutiveErrors > 1) {
				jumpPollIntervalMs = Math.min(
					jumpPollIntervalMs * 2,
					JUMP_POLL_MAX_INTERVAL
				);

				// Add jitter (±25%)
				const jitter =
					jumpPollIntervalMs *
					0.25 *
					(Math.random() - 0.5);
				jumpPollIntervalMs = Math.round(
					jumpPollIntervalMs + jitter
				);

				debugLogger.warn(
					`⚠️ Jump polling error (${consecutiveErrors} consecutive): ${error.message}. ` +
						`Backing off to ${jumpPollIntervalMs}ms`
				);
			} else {
				debugLogger.warn(
					`⚠️ Jump error: ${error.message}`
				);
			}
		}
	} finally {
		// Schedule next poll
		jumpPollingInterval = setTimeout(
			pollForJump,
			jumpPollIntervalMs
		);
	}
}

function stopJumpPolling() {
	if (jumpPollingInterval) {
		clearTimeout(jumpPollingInterval);
		jumpPollingInterval = null;
		jumpPollIntervalMs = JUMP_POLL_MIN_INTERVAL;
		consecutiveErrors = 0;
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

	debugLogger.log(
		"🧹 Starting periodic metadata cleanup (every 5 minutes)..."
	);

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
