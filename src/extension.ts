/**
 * Skylit Dev I/O - VS Code/Cursor Extension
 * Main entry point
 */

import * as vscode from 'vscode';
import { WorkspaceManager } from './workspaceManager';
import { AuthManager } from './authManager';
import { FileWatcher } from './fileWatcher';
import { RestClient } from './restClient';
import { StatusBar } from './statusBar';
import { ProtocolHandler } from './protocolHandler';
import { ConnectionState } from './types';

let workspaceManager: WorkspaceManager;
let authManager: AuthManager;
let fileWatcher: FileWatcher | null = null;
let restClient: RestClient | null = null;
let statusBar: StatusBar;
let protocolHandler: ProtocolHandler;
let outputChannel: vscode.OutputChannel;
let statusCheckInterval: NodeJS.Timeout | null = null;
let currentDevPath: string | null = null;

/**
 * Extension activation
 */
export async function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Skylit.DEV I/O');
    outputChannel.appendLine('🚀 Skylit.DEV I/O extension activated');

    // Initialize managers
    workspaceManager = new WorkspaceManager(outputChannel);
    authManager = new AuthManager(context, outputChannel);
    statusBar = new StatusBar(outputChannel);
    protocolHandler = new ProtocolHandler(outputChannel);

    // Register protocol handler
    protocolHandler.register(context);

    // Register commands
    registerCommands(context);

    // Detect WordPress sites in workspace
    const sites = await workspaceManager.detectWordPressSites();
    
    if (sites.length === 0) {
        outputChannel.appendLine('⚠️ No WordPress sites with Skylit.DEV plugin detected');
        outputChannel.appendLine('ℹ️ Make sure:');
        outputChannel.appendLine('   1. WordPress is in your workspace (or in a subdirectory like public_html/)');
        outputChannel.appendLine('   2. Skylit.DEV plugin is installed and activated');
        statusBar.updateStatus('disconnected', 'No Skylit.DEV detected');
        
        // Show helpful notification
        vscode.window.showWarningMessage(
            'Skylit.DEV plugin not detected. Install and activate the plugin in WordPress.',
            'Learn More'
        ).then(selection => {
            if (selection === 'Learn More') {
                vscode.env.openExternal(vscode.Uri.parse('https://skylit.dev/docs/getting-started'));
            }
        });
        
        return;
    }

    outputChannel.appendLine(`✅ Detected ${sites.length} WordPress site(s) with Skylit.DEV plugin`);
    sites.forEach(site => {
        outputChannel.appendLine(`   - ${site.name}: ${site.siteUrl}`);
    });

    // Check if auto-connect is enabled (default: true)
    const config = vscode.workspace.getConfiguration('skylit');
    const autoConnect = config.get<boolean>('autoConnect', true);

    if (autoConnect) {
        outputChannel.appendLine('🔄 Auto-connect enabled, attempting connection...');
        
        // Auto-connect to the first site (or let user choose if multiple)
        const siteToConnect = sites[0];
        
        try {
            await connectToWordPress(siteToConnect, context, true); // Pass true for isAutoConnect
        } catch (error: any) {
            outputChannel.appendLine(`⚠️ Auto-connect failed: ${error.message}`);
            outputChannel.appendLine('💡 You can manually connect by clicking the status bar or running "Skylit: Connect"');
            statusBar.updateStatus('disconnected', 'Auto-connect failed - Click to retry');
        }
    } else {
        outputChannel.appendLine('ℹ️ Auto-connect disabled in settings');
        statusBar.updateStatus('disconnected', 'Click to connect to WordPress');
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
    
    if (fileWatcher) {
        fileWatcher.dispose();
    }
    if (statusBar) {
        statusBar.dispose();
    }
    outputChannel.appendLine('👋 Skylit.DEV I/O extension deactivated');
    outputChannel.dispose();
}

/**
 * Register command palette actions
 */
function registerCommands(context: vscode.ExtensionContext) {
    // Scan for WordPress command
    context.subscriptions.push(
        vscode.commands.registerCommand('skylit.scanWorkspace', async () => {
            outputChannel.show(); // Show output channel
            outputChannel.appendLine('🔍 Manual WordPress scan triggered...');
            
            const sites = await workspaceManager.detectWordPressSites();
            
            if (sites.length === 0) {
                vscode.window.showWarningMessage(
                    'No WordPress sites with Skylit.DEV plugin found. Check Output panel for details.',
                    'View Output'
                ).then(selection => {
                    if (selection === 'View Output') {
                        outputChannel.show();
                    }
                });
                return;
            }

            vscode.window.showInformationMessage(
                `Found ${sites.length} WordPress site(s) with Skylit.DEV plugin!`,
                'Connect Now',
                'Setup Token'
            ).then(selection => {
                if (selection === 'Connect Now') {
                    vscode.commands.executeCommand('skylit.connect');
                } else if (selection === 'Setup Token') {
                    vscode.commands.executeCommand('skylit.setupToken');
                }
            });
        })
    );

    // Connect command
    context.subscriptions.push(
        vscode.commands.registerCommand('skylit.connect', async () => {
            outputChannel.appendLine('🔌 Manual connection requested...');
            
            const sites = await workspaceManager.detectWordPressSites();
            
            if (sites.length === 0) {
                vscode.window.showErrorMessage(
                    'No WordPress sites found in workspace',
                    'Scan Workspace'
                ).then(selection => {
                    if (selection === 'Scan Workspace') {
                        vscode.commands.executeCommand('skylit.scanWorkspace');
                    }
                });
                return;
            }

            // If multiple sites, let user choose
            let selectedSite = sites[0];
            if (sites.length > 1) {
                const choice = await vscode.window.showQuickPick(
                    sites.map(s => ({ label: s.name, description: s.siteUrl, site: s })),
                    { placeHolder: 'Select WordPress site to connect' }
                );
                if (!choice) return;
                selectedSite = choice.site;
            }

            await connectToWordPress(selectedSite, context, false); // Pass false for manual connection
        })
    );

    // Disconnect command
    context.subscriptions.push(
        vscode.commands.registerCommand('skylit.disconnect', async () => {
            // Stop status check interval
            if (statusCheckInterval) {
                clearInterval(statusCheckInterval);
                statusCheckInterval = null;
            }
            
            // Stop jump polling
            stopJumpPolling();
            
            if (fileWatcher) {
                fileWatcher.dispose();
                fileWatcher = null;
            }
            restClient = null;
            currentDevPath = null;
            statusBar.updateStatus('disconnected', 'Disconnected');
            outputChannel.appendLine('Skylit.DEV I/O: Disconnected from WordPress');
            outputChannel.appendLine('🔌 Disconnected from WordPress');
        })
    );

    // Setup token command
    context.subscriptions.push(
        vscode.commands.registerCommand('skylit.setupToken', async () => {
            const sites = await workspaceManager.detectWordPressSites();
            if (sites.length === 0) {
                vscode.window.showErrorMessage('No WordPress sites found in workspace');
                return;
            }

            const site = sites[0]; // TODO: Support multiple sites
            const token = await vscode.window.showInputBox({
                prompt: `Enter auth token for ${site.name}`,
                placeHolder: 'skylit_abc123...',
                password: true,
                ignoreFocusOut: true
            });

            if (!token) return;

            await authManager.saveToken(site.siteUrl, token);
            outputChannel.appendLine('✅ Auth token saved! Connecting...');
            await connectToWordPress(site, context);
        })
    );

    // Sync current file command
    context.subscriptions.push(
        vscode.commands.registerCommand('skylit.syncNow', async () => {
            if (!restClient) {
                vscode.window.showErrorMessage('Not connected to WordPress');
                return;
            }

            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No file open');
                return;
            }

            const filePath = editor.document.uri.fsPath;
            outputChannel.appendLine(`🔄 Manually syncing: ${filePath}`);
            
            // Trigger file watcher sync
            if (fileWatcher) {
                await fileWatcher.syncFile(filePath);
            }
        })
    );

    // Create post command - for AI-assisted development
    // AI calls this FIRST to get the correct folder path before creating files
    context.subscriptions.push(
        vscode.commands.registerCommand('skylit.createPost', async (args?: { title?: string; slug?: string; postType?: string }) => {
            if (!restClient) {
                outputChannel.appendLine('❌ [createPost] Not connected to WordPress');
                return { success: false, error: 'Not connected to WordPress' };
            }

            if (!currentDevPath) {
                outputChannel.appendLine('❌ [createPost] Dev path not available');
                return { success: false, error: 'Dev path not available' };
            }

            // Get parameters from args or prompt user
            let title = args?.title;
            let slug = args?.slug;
            let postType = args?.postType || 'page';

            if (!title) {
                title = await vscode.window.showInputBox({
                    prompt: 'Enter page/post title',
                    placeHolder: 'My New Page'
                });
                if (!title) {
                    return { success: false, error: 'Title is required' };
                }
            }

            if (!slug) {
                // Generate slug from title
                slug = title.toLowerCase()
                    .replace(/[^a-z0-9\s-]/g, '')
                    .replace(/\s+/g, '-')
                    .replace(/-+/g, '-')
                    .trim();
            }

            outputChannel.appendLine(`📄 [createPost] Creating ${postType}: "${title}" (${slug})`);

            try {
                // Create empty post in WordPress to get the ID
                const response = await restClient.createEmptyPost(postType, title, slug);

                if (response.success && response.post_id) {
                    const folderName = `${slug}_${response.post_id}`;
                    const postTypeFolder = postType === 'page' ? 'pages' : postType === 'post' ? 'posts' : postType + 's';
                    const folderPath = `post-types/${postTypeFolder}/${folderName}`;
                    const fullPath = `${currentDevPath.replace(/\\/g, '/')}/${folderPath}`;

                    outputChannel.appendLine(`✅ [createPost] Created ${postType} ID: ${response.post_id}`);
                    outputChannel.appendLine(`   Folder path: ${folderPath}`);
                    outputChannel.appendLine(`   Full path: ${fullPath}`);

                    // Write result to file for AI to read
                    const resultFile = `${currentDevPath}/.skylit/last-created-post.json`;
                    const resultData = {
                        success: true,
                        post_id: response.post_id,
                        post_type: postType,
                        title: title,
                        slug: slug,
                        folder_name: folderName,
                        folder_path: folderPath,
                        full_path: fullPath,
                        html_file: `${fullPath}/${folderName}.html`,
                        css_file: `${fullPath}/${folderName}.css`,
                        created_at: new Date().toISOString()
                    };

                    // Ensure .skylit folder exists
                    const skylitDir = vscode.Uri.file(`${currentDevPath}/.skylit`);
                    try {
                        await vscode.workspace.fs.stat(skylitDir);
                    } catch {
                        await vscode.workspace.fs.createDirectory(skylitDir);
                    }

                    // Write result file
                    await vscode.workspace.fs.writeFile(
                        vscode.Uri.file(resultFile),
                        Buffer.from(JSON.stringify(resultData, null, 2), 'utf8')
                    );

                    // Show notification
                    vscode.window.showInformationMessage(
                        `✅ Created ${postType}: ${title} → ${folderName}`
                    );

                    return resultData;
                } else {
                    outputChannel.appendLine(`❌ [createPost] Failed: ${response.error}`);
                    return { success: false, error: response.error };
                }
            } catch (error: any) {
                outputChannel.appendLine(`❌ [createPost] Error: ${error.message}`);
                return { success: false, error: error.message };
            }
        })
    );

    // Show menu command
    context.subscriptions.push(
        vscode.commands.registerCommand('skylit.showMenu', async () => {
            // If disconnected or error, show quick connect options
            if (statusBar['connectionState'] === 'disconnected' || statusBar['connectionState'] === 'error') {
                const items = [
                    { label: '🔌 Connect to WordPress', command: 'skylit.connect', description: 'Connect to detected WordPress site' },
                    { label: '🔑 Setup Auth Token', command: 'skylit.setupToken', description: 'Enter WordPress auth token' },
                    { label: '🔍 Scan for WordPress', command: 'skylit.scanWorkspace', description: 'Manually scan workspace for WordPress + Skylit plugin' },
                ];

                const choice = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Skylit.DEV I/O - Not Connected'
                });

                if (choice) {
                    vscode.commands.executeCommand(choice.command);
                }
            } else {
                // Connected - show all actions
                const items = [
                    { label: '🔄 Sync Current File', command: 'skylit.syncNow', description: 'Force sync the active file' },
                    { label: '❌ Disconnect', command: 'skylit.disconnect', description: 'Disconnect from WordPress' },
                    { label: '🔍 Scan for WordPress', command: 'skylit.scanWorkspace', description: 'Manually scan workspace for WordPress + Skylit plugin' },
                    { label: '🔑 Setup Auth Token', command: 'skylit.setupToken', description: 'Enter WordPress auth token' },
                ];

                const choice = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Skylit.DEV I/O Actions'
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
async function connectToWordPress(site: any, context: vscode.ExtensionContext, isAutoConnect: boolean = false) {
    outputChannel.appendLine(`🔌 Connecting to ${site.name}...`);
    statusBar.updateStatus('connecting', 'Connecting...');

    try {
        // Check if site URL is localhost and prompt for actual URL
        let siteUrl = site.siteUrl;
        if (siteUrl === 'http://localhost' || siteUrl === 'https://localhost') {
            outputChannel.appendLine(`⚠️ Default localhost URL detected`);
            
            // Don't prompt during auto-connect, just fail gracefully
            if (isAutoConnect) {
                outputChannel.appendLine('💡 Please set "skylit.siteUrl" in VS Code settings');
                statusBar.updateStatus('disconnected', 'Configure site URL');
                return;
            }
            
            // Prompt user for actual URL
            const userUrl = await vscode.window.showInputBox({
                prompt: 'Enter your WordPress site URL',
                placeHolder: 'https://palegreen-capybara-849923.hostingersite.com',
                value: siteUrl,
                ignoreFocusOut: true
            });
            
            if (!userUrl || userUrl.trim() === '') {
                statusBar.updateStatus('disconnected', 'Connection cancelled');
                return;
            }
            
            siteUrl = userUrl.trim().replace(/\/$/, '');
            site.siteUrl = siteUrl;
            outputChannel.appendLine(`✅ Using URL: ${siteUrl}`);
            
            // Save to settings for future use
            const vscodeConfig = vscode.workspace.getConfiguration('skylit');
            await vscodeConfig.update('siteUrl', siteUrl, vscode.ConfigurationTarget.Workspace);
        }

        // Check for saved token
        let token = await authManager.getToken(site.siteUrl);
        
        if (!token) {
            outputChannel.appendLine('⚠️ No auth token found');
            
            // Don't prompt during auto-connect, just fail gracefully
            if (isAutoConnect) {
                outputChannel.appendLine('💡 Run "Skylit: Setup Auth Token" or click the status bar to connect');
                statusBar.updateStatus('disconnected', 'No auth token - Click to setup');
                
                // Show a non-intrusive info message
                vscode.window.showInformationMessage(
                    'Skylit.DEV: Auth token required',
                    'Setup Token',
                    'Dismiss'
                ).then(selection => {
                    if (selection === 'Setup Token') {
                        vscode.commands.executeCommand('skylit.setupToken');
                    }
                });
                return;
            }
            
            const input = await vscode.window.showInputBox({
                prompt: `Enter auth token for ${site.name}`,
                placeHolder: 'skylit_abc123...',
                password: true,
                ignoreFocusOut: true
            });

            if (!input) {
                statusBar.updateStatus('disconnected', 'Connection cancelled');
                return;
            }

            token = input;
            await authManager.saveToken(site.siteUrl, token);
        }

        // Create REST client
        restClient = new RestClient(site.siteUrl, token, outputChannel);

        // Validate token
        const isValid = await restClient.validateToken();
        if (!isValid) {
            outputChannel.appendLine('❌ Invalid auth token');
            
            // Clear the invalid token
            await authManager.clearToken(site.siteUrl);
            
            if (isAutoConnect) {
                outputChannel.appendLine('💡 Token is invalid or expired. Please setup a new token.');
                statusBar.updateStatus('error', 'Invalid token - Click to setup');
                
                vscode.window.showWarningMessage(
                    'Skylit.DEV: Auth token is invalid or expired',
                    'Setup New Token',
                    'Dismiss'
                ).then(selection => {
                    if (selection === 'Setup New Token') {
                        vscode.commands.executeCommand('skylit.setupToken');
                    }
                });
                return;
            }
            
            vscode.window.showErrorMessage(
                'Invalid auth token. Please generate a new one in WordPress Admin → Skylit.DEV → Dev Sync',
                'Setup Token'
            ).then(selection => {
                if (selection === 'Setup Token') {
                    vscode.commands.executeCommand('skylit.setupToken');
                }
            });
            statusBar.updateStatus('error', 'Invalid token');
            return;
        }

        outputChannel.appendLine('✅ Token validated');

        // Get plugin status and dev folder from WordPress
        const status = await restClient.getStatus();
        outputChannel.appendLine(`✅ Connected to Skylit plugin v${status.version}`);
        outputChannel.appendLine(`   Dev folder from WordPress: ${status.dev_path}`);

        // Validate that WordPress provided a dev folder path
        if (!status.dev_path || status.dev_path.trim() === '') {
            outputChannel.appendLine('❌ WordPress did not provide a dev folder path');
            vscode.window.showErrorMessage(
                'Dev folder not configured in WordPress. Please set it in Admin → Skylit.DEV → Dev Sync'
            );
            statusBar.updateStatus('error', 'Dev folder not configured');
            return;
        }

        // Initialize file watcher with the dev folder from WordPress API
        // This is the source of truth - it reflects the actual WordPress settings
        if (fileWatcher) {
            fileWatcher.dispose();
        }

        outputChannel.appendLine(`👀 Starting file watcher for: ${status.dev_path}`);

        fileWatcher = new FileWatcher(
            status.dev_path,
            restClient,
            statusBar,
            outputChannel
        );

        await fileWatcher.start();

        // Store the current dev path
        currentDevPath = status.dev_path;

        // Start periodic status check (every 60 seconds) to detect dev folder changes
        if (statusCheckInterval) {
            clearInterval(statusCheckInterval);
        }
        
        statusCheckInterval = setInterval(async () => {
            if (!restClient) return;
            
            try {
                const updatedStatus = await restClient.getStatus();
                
                // Check if dev folder location changed in WordPress
                if (updatedStatus.dev_path !== currentDevPath) {
                    outputChannel.appendLine(`🔄 Dev folder changed: ${currentDevPath} → ${updatedStatus.dev_path}`);
                    outputChannel.appendLine(`   Restarting file watcher...`);
                    
                    // Restart file watcher with new path
                    if (fileWatcher) {
                        fileWatcher.dispose();
                    }
                    
                    fileWatcher = new FileWatcher(
                        updatedStatus.dev_path,
                        restClient,
                        statusBar,
                        outputChannel
                    );
                    
                    await fileWatcher.start();
                    currentDevPath = updatedStatus.dev_path;
                    
                    outputChannel.appendLine(`✅ Dev folder location updated: ${updatedStatus.dev_path}`);
                    outputChannel.appendLine('   Restarting file watcher...');
                }
            } catch (error: any) {
                // Silently fail - don't spam errors if WordPress is temporarily unavailable
                outputChannel.appendLine(`⚠️ Status check failed: ${error.message}`);
            }
        }, 60000); // Check every 60 seconds

        // Start jump-to-code polling (every 500ms for responsiveness)
        startJumpPolling();

        statusBar.updateStatus('connected', 'Connected');
        
        // Extract a readable folder path for the notification
        const devPath = status.dev_path.replace(/\\/g, '/');
        let displayMessage = '';
        
        if (devPath.includes('wp-content')) {
            // Inside WordPress wp-content directory
            const wpContentIndex = devPath.indexOf('wp-content');
            const relativePath = devPath.substring(wpContentIndex);
            displayMessage = `✅ Connected to .../${relativePath}`;
        } else {
            // Outside WordPress (server root level)
            const parts = devPath.split('/').filter(p => p);
            const folderName = parts[parts.length - 1] || parts[parts.length - 2];
            displayMessage = `✅ Connected to /${folderName} (Server Root)`;
        }
        
        vscode.window.showInformationMessage(displayMessage);

    } catch (error: any) {
        outputChannel.appendLine(`❌ Connection failed: ${error.message}`);
        statusBar.updateStatus('error', 'Connection failed');
        outputChannel.appendLine(`❌ Failed to connect: ${error.message}`);
    }
}

/**
 * Poll for jump-to-code requests
 */
let jumpPollingInterval: NodeJS.Timeout | null = null;

function startJumpPolling() {
    if (jumpPollingInterval) {
        clearInterval(jumpPollingInterval);
    }
    
    outputChannel.appendLine('📍 Starting jump-to-code polling...');
    
    jumpPollingInterval = setInterval(async () => {
        if (!restClient) return;
        
        try {
            const jumpData = await restClient.getPendingJump();
            
            if (jumpData.pending && jumpData.file && jumpData.line) {
                outputChannel.appendLine(`📍 Jump request received: ${jumpData.file}:${jumpData.line}`);
                outputChannel.appendLine(`   Current dev path from WordPress: ${currentDevPath}`);
                
                // Get workspace folders to determine if we're in a remote workspace
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (!workspaceFolders || workspaceFolders.length === 0) {
                    outputChannel.appendLine(`   ❌ No workspace folder found`);
                    return;
                }
                
                const workspaceUri = workspaceFolders[0].uri;
                outputChannel.appendLine(`   Workspace URI scheme: ${workspaceUri.scheme}`);
                outputChannel.appendLine(`   Workspace path: ${workspaceUri.path}`);
                
                // For remote workspaces (SSH, WSL, etc.), construct URI with the same scheme
                // For local workspaces, use file:// scheme
                let fileUri: vscode.Uri;
                
                if (workspaceUri.scheme !== 'file') {
                    // Remote workspace - use the workspace's URI scheme
                    fileUri = vscode.Uri.from({
                        scheme: workspaceUri.scheme,
                        authority: workspaceUri.authority,
                        path: jumpData.file
                    });
                    outputChannel.appendLine(`   Using remote URI scheme: ${workspaceUri.scheme}`);
                } else {
                    // Local workspace - use file:// scheme
                    fileUri = vscode.Uri.file(jumpData.file);
                    outputChannel.appendLine(`   Using local file scheme`);
                }
                
                outputChannel.appendLine(`   File URI: ${fileUri.toString()}`);
                outputChannel.appendLine(`   Attempting to open file...`);
                
                const document = await vscode.workspace.openTextDocument(fileUri);
                outputChannel.appendLine(`   ✅ Document opened: ${document.fileName}`);
                
                // Show document with cursor at specified line
                const editor = await vscode.window.showTextDocument(document, {
                    selection: new vscode.Range(
                        jumpData.line - 1, // VS Code uses 0-based line numbers
                        jumpData.column || 0,
                        jumpData.line - 1,
                        jumpData.column || 0
                    ),
                    viewColumn: vscode.ViewColumn.One
                });
                outputChannel.appendLine(`   ✅ Editor opened, showing line ${jumpData.line}`);
                
                // Reveal line at center of viewport
                editor.revealRange(
                    new vscode.Range(jumpData.line - 1, 0, jumpData.line - 1, 0),
                    vscode.TextEditorRevealType.InCenter
                );
                
                outputChannel.appendLine(`✅ Successfully jumped to ${jumpData.file}:${jumpData.line}`);
            }
        } catch (error: any) {
            // Log actual errors (not just "no pending jumps")
            if (error.message && !error.message.includes('No pending') && !error.message.includes('404')) {
                outputChannel.appendLine(`⚠️ Jump error: ${error.message}`);
            }
        }
    }, 500); // Poll every 500ms for responsiveness
}

function stopJumpPolling() {
    if (jumpPollingInterval) {
        clearInterval(jumpPollingInterval);
        jumpPollingInterval = null;
        outputChannel.appendLine('📍 Jump-to-code polling stopped');
    }
}
