/**
 * Workspace Manager
 * Detects WordPress installations and dev folders in workspace
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { DebugLogger } from './debugLogger';
import { WordPressSite, WpConfig } from './types';

export class WorkspaceManager {
    private debugLogger: DebugLogger;
    private pathSeparator: string = '/'; // Default to Unix-style
    private isRemote: boolean = false;
    private workspaceUri: vscode.Uri | null = null;

    constructor(debugLogger: DebugLogger) {
        this.debugLogger = debugLogger;
        
        // Detect if we're in a remote workspace (SSH, WSL, Dev Containers)
        const workspaceFolders = vscode.workspace.workspaceFolders || [];
        if (workspaceFolders.length > 0) {
            const firstFolder = workspaceFolders[0];
            this.isRemote = firstFolder.uri.scheme === 'vscode-remote';
            this.workspaceUri = firstFolder.uri;
            
            // Use forward slashes for remote, native path separators for local
            this.pathSeparator = this.isRemote ? '/' : path.sep;
        }
    }

    /**
     * Create a URI from a path string
     */
    private pathToUri(filePath: string): vscode.Uri {
        if (this.isRemote && this.workspaceUri) {
            // For remote: create URI with same scheme as workspace
            return vscode.Uri.from({
                scheme: this.workspaceUri.scheme,
                authority: this.workspaceUri.authority,
                path: filePath
            });
        } else {
            // For local: use file:// scheme
            return vscode.Uri.file(filePath);
        }
    }

    /**
     * Check if a file exists using VS Code's file system API
     */
    private async fileExists(filePath: string): Promise<boolean> {
        try {
            const uri = this.pathToUri(filePath);
            await vscode.workspace.fs.stat(uri);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Read a file using VS Code's file system API
     */
    private async readFile(filePath: string): Promise<string> {
        const uri = this.pathToUri(filePath);
        const content = await vscode.workspace.fs.readFile(uri);
        return Buffer.from(content).toString('utf8');
    }

    /**
     * Check if path is a directory using VS Code's file system API
     */
    private async isDirectory(filePath: string): Promise<boolean> {
        try {
            const uri = this.pathToUri(filePath);
            const stat = await vscode.workspace.fs.stat(uri);
            return stat.type === vscode.FileType.Directory;
        } catch {
            return false;
        }
    }

    /**
     * Read directory contents using VS Code's file system API
     */
    private async readDirectory(dirPath: string): Promise<string[]> {
        try {
            const uri = this.pathToUri(dirPath);
            const entries = await vscode.workspace.fs.readDirectory(uri);
            return entries.map(([name]) => name);
        } catch {
            return [];
        }
    }

    /**
     * Join path segments using the correct separator for the environment
     */
    private joinPath(...segments: string[]): string {
        if (this.isRemote) {
            // For remote: use forward slashes, handle leading slash
            const joined = segments
                .filter(s => s) // Remove empty segments
                .join('/')
                .replace(/\/+/g, '/'); // Normalize multiple slashes
            
            // Preserve leading slash for absolute paths
            return segments[0]?.startsWith('/') && !joined.startsWith('/') 
                ? '/' + joined 
                : joined;
        } else {
            // For local: use Node's path.join
            return path.join(...segments);
        }
    }

    /**
     * Get directory name from path
     */
    private getDirName(filePath: string): string {
        if (this.isRemote) {
            const parts = filePath.split('/');
            parts.pop();
            return parts.join('/') || '/';
        } else {
            return path.dirname(filePath);
        }
    }

    /**
     * Get base name from path
     */
    private getBaseName(filePath: string): string {
        if (this.isRemote) {
            const parts = filePath.split('/');
            return parts[parts.length - 1] || '';
        } else {
            return path.basename(filePath);
        }
    }

    /**
     * Detect all WordPress sites in workspace
     */
    async detectWordPressSites(): Promise<WordPressSite[]> {
        const workspaceFolders = vscode.workspace.workspaceFolders || [];
        const sites: WordPressSite[] = [];

        this.debugLogger.log('🔍 Scanning workspace for WordPress sites...');

        for (const folder of workspaceFolders) {
            // Use URI path for remote workspaces (SSH), fsPath for local
            const folderPath = folder.uri.scheme === 'vscode-remote' 
                ? folder.uri.path  // Remote: use forward slashes
                : folder.uri.fsPath; // Local: use OS-specific path
            
            const site = await this.detectWordPressInFolder(folderPath);
            if (site) {
                sites.push(site);
            }
        }

        return sites;
    }

    /**
     * Detect WordPress in a specific folder
     */
    private async detectWordPressInFolder(folderPath: string): Promise<WordPressSite | null> {
        this.debugLogger.log(`   📁 Starting search from: ${folderPath}`);
        
        // Strategy 1: Search upward from current folder
        let wpRoot = await this.findWordPressRoot(folderPath);
        
        // Strategy 2: If not found, search downward into common WordPress locations
        if (!wpRoot) {
            this.debugLogger.log(`   🔍 Searching downward into subdirectories...`);
            wpRoot = await this.findWordPressInSubdirectories(folderPath);
        }
        
        if (!wpRoot) {
            this.debugLogger.log(`   ❌ wp-config.php not found`);
            return null;
        }

        this.debugLogger.log(`   ✅ Found WordPress root: ${wpRoot}`);

        // Check if Skylit plugin is installed
        const isSkylitInstalled = await this.checkSkylitPlugin(wpRoot);
        if (!isSkylitInstalled) {
            this.debugLogger.log(`   ⚠️ Skylit.DEV plugin not found or not activated`);
            this.debugLogger.log(`   ℹ️ Please install and activate the Skylit.DEV plugin in WordPress`);
            return null;
        }

        this.debugLogger.log(`   ✅ Skylit.DEV plugin detected and active!`);

        try {
            const wpConfigPath = this.joinPath(wpRoot, 'wp-config.php');
            let config = await this.parseWpConfig(wpConfigPath);
            
            // Check if user has manually configured site URL in settings
            const vscodeConfig = vscode.workspace.getConfiguration('skylit');
            const manualSiteUrl = vscodeConfig.get<string>('siteUrl');
            
            if (manualSiteUrl && manualSiteUrl.trim() !== '') {
                config.siteUrl = manualSiteUrl.trim().replace(/\/$/, '');
                this.debugLogger.log(`   ✅ Using site URL from settings: ${config.siteUrl}`);
            }
            
            return {
                name: this.getBaseName(wpRoot),
                path: wpRoot,
                siteUrl: config.siteUrl,
                devFolder: config.devFolder
            };
        } catch (error: any) {
            this.debugLogger.log(`   ⚠️ Error parsing wp-config.php: ${error.message}`);
            return null;
        }
    }

    /**
     * Find WordPress in common subdirectories
     */
    private async findWordPressInSubdirectories(startPath: string): Promise<string | null> {
        // Common WordPress subdirectory patterns
        const commonPaths = [
            'public_html',      // Hostinger, cPanel, most shared hosts
            'public',           // Valet, Forge
            'app/public',       // LocalWP
            'htdocs',           // XAMPP
            'www',              // Some setups
            'wordpress',        // Manual installs
            'wp',               // Short name
        ];
        
        for (const subPath of commonPaths) {
            const fullPath = this.joinPath(startPath, subPath);
            const wpConfigPath = this.joinPath(fullPath, 'wp-config.php');
            
            this.debugLogger.log(`   🔎 Checking: ${wpConfigPath}`);
            
            if (await this.fileExists(wpConfigPath)) {
                this.debugLogger.log(`   ✅ Found wp-config.php in subdirectory!`);
                return fullPath;
            }
        }
        
        return null;
    }

    /**
     * Check if Skylit.DEV plugin is installed and activated
     */
    private async checkSkylitPlugin(wpRoot: string): Promise<boolean> {
        // Check for plugin file in multiple possible locations
        const pluginPaths = [
            this.joinPath(wpRoot, 'wp-content', 'plugins', 'skylit-dev', 'skylit-dev-ui.php'),
            this.joinPath(wpRoot, 'wp-content', 'plugins', 'skylit-dev-ui', 'skylit-dev-ui.php'),
            this.joinPath(wpRoot, 'wp-content', 'plugins', 'skylit', 'skylit-dev-ui.php'),
        ];

        for (const pluginPath of pluginPaths) {
            if (await this.fileExists(pluginPath)) {
                this.debugLogger.log(`   🔌 Found plugin file: ${pluginPath}`);
                
                // Read plugin file to check if it's the right one
                try {
                    const content = await this.readFile(pluginPath);
                    
                    // Verify it's actually the Skylit plugin
                    if (content.includes('Plugin Name: Skylit.DEV') || 
                        content.includes('Skylit Dev UI') ||
                        content.includes('SKYLIT_DEV_UI_VERSION')) {
                        
                        // Extract version if available
                        const versionMatch = content.match(/Version:\s*([0-9.]+)/i);
                        if (versionMatch) {
                            this.debugLogger.log(`   ℹ️ Plugin version: ${versionMatch[1]}`);
                        }
                        
                        return true;
                    }
                } catch (error: any) {
                    this.debugLogger.log(`   ⚠️ Could not read plugin file: ${error.message}`);
                }
            }
        }

        return false;
    }

    /**
     * Find WordPress root by searching upward for wp-config.php
     */
    private async findWordPressRoot(startPath: string): Promise<string | null> {
        let currentPath = startPath;
        const maxLevels = 10; // Prevent infinite loop
        
        for (let i = 0; i < maxLevels; i++) {
            const wpConfigPath = this.joinPath(currentPath, 'wp-config.php');
            
            this.debugLogger.log(`   🔎 Checking: ${wpConfigPath}`);
            
            if (await this.fileExists(wpConfigPath)) {
                this.debugLogger.log(`   ✅ Found wp-config.php!`);
                return currentPath;
            }
            
            // Move up one directory
            const parentPath = this.getDirName(currentPath);
            
            // If we've reached the root of the filesystem, stop
            if (parentPath === currentPath) {
                break;
            }
            
            currentPath = parentPath;
        }
        
        return null;
    }

    /**
     * Parse wp-config.php to extract site URL and dev folder
     */
    private async parseWpConfig(configPath: string): Promise<WpConfig> {
        const content = await this.readFile(configPath);
        const wpRoot = this.getDirName(configPath);
        
        // Extract site URL with multiple strategies
        let siteUrl = this.extractDefine(content, 'WP_HOME') 
                   || this.extractDefine(content, 'WP_SITEURL');
        
        // If no URL in wp-config, try to detect from .htaccess or other files
        if (!siteUrl) {
            siteUrl = await this.detectSiteUrlDynamic(wpRoot, content);
        }
        
        // Final fallback
        if (!siteUrl) {
            siteUrl = 'http://localhost';
            this.debugLogger.log(`   ⚠️ Could not auto-detect site URL, defaulting to ${siteUrl}`);
            this.debugLogger.log(`   💡 Set "skylit.siteUrl" in VS Code settings to override`);
        }

        // Find dev folder
        const devFolder = await this.findDevFolder(wpRoot);

        return {
            siteUrl: siteUrl.replace(/\/$/, ''), // Remove trailing slash
            devFolder
        };
    }
    
    /**
     * Try to detect site URL from various sources
     */
    private async detectSiteUrlDynamic(wpRoot: string, wpConfigContent: string): Promise<string | null> {
        // Strategy 1: Check for SERVER_NAME + HTTPS in wp-config
        const serverName = this.extractDefine(wpConfigContent, 'SERVER_NAME');
        if (serverName) {
            const isHttps = this.extractDefine(wpConfigContent, 'FORCE_SSL_ADMIN') === 'true';
            return `http${isHttps ? 's' : ''}://${serverName}`;
        }
        
        // Strategy 2: Read from .wp-cli.yml if exists
        const wpCliPath = this.joinPath(wpRoot, '.wp-cli.yml');
        if (await this.fileExists(wpCliPath)) {
            try {
                const wpCliContent = await this.readFile(wpCliPath);
                const urlMatch = wpCliContent.match(/url:\s*['"]?([^'"\n]+)['"]?/);
                if (urlMatch) {
                    this.debugLogger.log(`   🔍 Detected URL from .wp-cli.yml: ${urlMatch[1]}`);
                    return urlMatch[1];
                }
            } catch (e) {
                // Ignore errors
            }
        }
        
        // Strategy 3: Parse DB constants and try to query wp_options
        // This would require DB connection which is complex, skip for now
        
        return null;
    }

    /**
     * Extract define() value from wp-config.php
     */
    private extractDefine(content: string, constantName: string): string | null {
        // Match: define('WP_HOME', 'http://localhost');
        // or: define("WP_HOME", "http://localhost");
        const regex = new RegExp(
            `define\\s*\\(\\s*['"]${constantName}['"]\\s*,\\s*['"]([^'"]+)['"]\\s*\\)`,
            'i'
        );
        
        const match = content.match(regex);
        return match ? match[1] : null;
    }

    /**
     * Find Skylit dev folder
     */
    private async findDevFolder(wpRoot: string): Promise<string> {
        // Strategy 1: Check Skylit settings in WordPress database
        // (We can't easily do this without DB access, so skip for now)

        // Strategy 2: Look for folders matching pattern: *-dev-root
        const wpContent = this.joinPath(wpRoot, 'wp-content');
        
        if (await this.isDirectory(wpContent)) {
            const items = await this.readDirectory(wpContent);
            
            for (const item of items) {
                if (item.endsWith('-dev-root')) {
                    const devPath = this.joinPath(wpContent, item);
                    if (await this.isDirectory(devPath)) {
                        this.debugLogger.log(`   📁 Dev folder: ${devPath}`);
                        return devPath;
                    }
                }
            }
        }

        // Strategy 3: Check for 'skylit-dev' folder (legacy)
        const legacyPath = this.joinPath(wpContent, 'skylit-dev');
        if (await this.fileExists(legacyPath)) {
            this.debugLogger.log(`   📁 Dev folder (legacy): ${legacyPath}`);
            return legacyPath;
        }

        // Strategy 4: Default to wp-content root
        this.debugLogger.log(`   ⚠️ Dev folder not found, defaulting to wp-content`);
        return wpContent;
    }

    /**
     * Get site URL from settings (allows user override)
     */
    getSiteUrl(): string | undefined {
        const config = vscode.workspace.getConfiguration('skylit');
        const siteUrl = config.get<string>('siteUrl');
        
        return siteUrl && siteUrl.trim() !== '' ? siteUrl : undefined;
    }
}
