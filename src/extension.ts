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
        outputChannel.appendLine('⚠️ No WordPress sites detected in workspace');
        statusBar.updateStatus('disconnected', 'No WordPress detected');
        return;
    }

    outputChannel.appendLine(`✅ Detected ${sites.length} WordPress site(s)`);
    sites.forEach(site => {
        outputChannel.appendLine(`   - ${site.name}: ${site.siteUrl}`);
    });

    // Check auto-connect setting
    const config = vscode.workspace.getConfiguration('skylit');
    const autoConnect = config.get<boolean>('autoConnect', true);

    if (autoConnect) {
        await connectToWordPress(sites[0], context);
    } else {
        statusBar.updateStatus('disconnected', 'Ready to connect');
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
    // Connect command
    context.subscriptions.push(
        vscode.commands.registerCommand('skylit.connect', async () => {
            const sites = await workspaceManager.detectWordPressSites();
            
            if (sites.length === 0) {
                vscode.window.showErrorMessage('No WordPress sites found in workspace');
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

            await connectToWordPress(selectedSite, context);
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

    // Show menu command
    context.subscriptions.push(
        vscode.commands.registerCommand('skylit.showMenu', async () => {
            const items = [
                { label: '🔌 Connect to WordPress', command: 'skylit.connect' },
                { label: '🔑 Setup Auth Token', command: 'skylit.setupToken' },
                { label: '🔄 Sync Current File', command: 'skylit.syncNow' },
                { label: '❌ Disconnect', command: 'skylit.disconnect' }
            ];

            const choice = await vscode.window.showQuickPick(items, {
                placeHolder: 'Skylit.DEV I/O Actions'
            });

            if (choice) {
                vscode.commands.executeCommand(choice.command);
            }
        })
    );
}

/**
 * Connect to WordPress site
 */
async function connectToWordPress(site: any, context: vscode.ExtensionContext) {
    outputChannel.appendLine(`🔌 Connecting to ${site.name}...`);
    statusBar.updateStatus('connecting', 'Connecting...');

    try {
        // Check for saved token
        let token = await authManager.getToken(site.siteUrl);
        
        if (!token) {
            outputChannel.appendLine('⚠️ No auth token found');
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
            vscode.window.showErrorMessage(
                'Invalid auth token. Please generate a new one in WordPress Admin → Skylit → About'
            );
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
                'Dev folder not configured in WordPress. Please set it in Admin → Skylit → Dev Sync'
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
                
                // Open file in editor
                const fileUri = vscode.Uri.file(jumpData.file);
                const document = await vscode.workspace.openTextDocument(fileUri);
                
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
                
                // Reveal line at center of viewport
                editor.revealRange(
                    new vscode.Range(jumpData.line - 1, 0, jumpData.line - 1, 0),
                    vscode.TextEditorRevealType.InCenter
                );
                
                outputChannel.appendLine(`✅ Jumped to ${jumpData.file}:${jumpData.line}`);
            }
        } catch (error: any) {
            // Silently fail - most polls will have no pending jumps
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
