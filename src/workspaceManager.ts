/**
 * Workspace Manager
 * Detects WordPress installations and dev folders in workspace
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WordPressSite, WpConfig } from './types';

export class WorkspaceManager {
    private outputChannel: vscode.OutputChannel;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    /**
     * Detect all WordPress sites in workspace
     */
    async detectWordPressSites(): Promise<WordPressSite[]> {
        const workspaceFolders = vscode.workspace.workspaceFolders || [];
        const sites: WordPressSite[] = [];

        this.outputChannel.appendLine('🔍 Scanning workspace for WordPress sites...');

        for (const folder of workspaceFolders) {
            const site = await this.detectWordPressInFolder(folder.uri.fsPath);
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
        this.outputChannel.appendLine(`   📁 Starting search from: ${folderPath}`);
        
        // Strategy 1: Search upward from current folder
        let wpRoot = this.findWordPressRoot(folderPath);
        
        // Strategy 2: If not found, search downward into common WordPress locations
        if (!wpRoot) {
            this.outputChannel.appendLine(`   🔍 Searching downward into subdirectories...`);
            wpRoot = this.findWordPressInSubdirectories(folderPath);
        }
        
        if (!wpRoot) {
            this.outputChannel.appendLine(`   ❌ wp-config.php not found`);
            return null;
        }

        this.outputChannel.appendLine(`   ✅ Found WordPress root: ${wpRoot}`);

        try {
            const wpConfigPath = path.join(wpRoot, 'wp-config.php');
            const config = await this.parseWpConfig(wpConfigPath);
            
            return {
                name: path.basename(wpRoot),
                path: wpRoot,
                siteUrl: config.siteUrl,
                devFolder: config.devFolder
            };
        } catch (error: any) {
            this.outputChannel.appendLine(`   ⚠️ Error parsing wp-config.php: ${error.message}`);
            return null;
        }
    }

    /**
     * Find WordPress in common subdirectories
     */
    private findWordPressInSubdirectories(startPath: string): string | null {
        // Common WordPress subdirectory patterns
        const commonPaths = [
            'public',           // Valet, Forge
            'app/public',       // LocalWP
            'htdocs',           // XAMPP
            'www',              // Some setups
            'wordpress',        // Manual installs
            'wp',               // Short name
        ];
        
        for (const subPath of commonPaths) {
            const fullPath = path.join(startPath, subPath);
            const wpConfigPath = path.join(fullPath, 'wp-config.php');
            
            this.outputChannel.appendLine(`   🔎 Checking: ${wpConfigPath}`);
            
            if (fs.existsSync(wpConfigPath)) {
                this.outputChannel.appendLine(`   ✅ Found wp-config.php in subdirectory!`);
                return fullPath;
            }
        }
        
        return null;
    }

    /**
     * Find WordPress root by searching upward for wp-config.php
     */
    private findWordPressRoot(startPath: string): string | null {
        let currentPath = startPath;
        const maxLevels = 10; // Prevent infinite loop
        
        for (let i = 0; i < maxLevels; i++) {
            const wpConfigPath = path.join(currentPath, 'wp-config.php');
            
            this.outputChannel.appendLine(`   🔎 Checking: ${wpConfigPath}`);
            
            if (fs.existsSync(wpConfigPath)) {
                this.outputChannel.appendLine(`   ✅ Found wp-config.php!`);
                return currentPath;
            }
            
            // Move up one directory
            const parentPath = path.dirname(currentPath);
            
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
        const content = fs.readFileSync(configPath, 'utf8');
        
        // Extract site URL
        let siteUrl = this.extractDefine(content, 'WP_HOME') 
                   || this.extractDefine(content, 'WP_SITEURL')
                   || 'http://localhost';

        // Find dev folder
        const devFolder = await this.findDevFolder(path.dirname(configPath));

        return {
            siteUrl: siteUrl.replace(/\/$/, ''), // Remove trailing slash
            devFolder
        };
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
        const wpContent = path.join(wpRoot, 'wp-content');
        
        if (fs.existsSync(wpContent)) {
            const items = fs.readdirSync(wpContent);
            
            for (const item of items) {
                if (item.endsWith('-dev-root')) {
                    const devPath = path.join(wpContent, item);
                    if (fs.statSync(devPath).isDirectory()) {
                        this.outputChannel.appendLine(`   📁 Dev folder: ${devPath}`);
                        return devPath;
                    }
                }
            }
        }

        // Strategy 3: Check for 'skylit-dev' folder (legacy)
        const legacyPath = path.join(wpContent, 'skylit-dev');
        if (fs.existsSync(legacyPath)) {
            this.outputChannel.appendLine(`   📁 Dev folder (legacy): ${legacyPath}`);
            return legacyPath;
        }

        // Strategy 4: Default to wp-content root
        this.outputChannel.appendLine(`   ⚠️ Dev folder not found, defaulting to wp-content`);
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
