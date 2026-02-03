import * as vscode from 'vscode';
import * as path from 'path';
import { RestClient } from './restClient';
import { DebugLogger } from './debugLogger';

/**
 * Post Type Converter
 * 
 * Detects when folders are moved between post type directories and prompts
 * user to convert the post type in WordPress.
 */
export class PostTypeConverter {
    private watcher: vscode.FileSystemWatcher | undefined;
    private restClient: RestClient;
    private devFolderPath: string;
    private logger: DebugLogger;
    
    // Track folder moves (VS Code doesn't give us old/new paths directly)
    private pendingMoves: Map<string, { oldPath: string, timestamp: number }> = new Map();
    
    // Post type folder mappings
    private readonly FOLDER_MAP: Record<string, string> = {
        'post-types/pages': 'page',
        'post-types/posts': 'post',
        'templates': 'wp_template',
        'parts': 'wp_template_part',
        'patterns': 'wp_block'
    };
    
    constructor(restClient: RestClient, devFolderPath: string, logger: DebugLogger) {
        this.restClient = restClient;
        this.devFolderPath = devFolderPath;
        this.logger = logger;
    }
    
    /**
     * Start watching for folder moves
     */
    public startWatching(): void {
        if (!this.devFolderPath) {
            this.logger.log('Post Type Converter: No dev folder path configured');
            return;
        }
        
        // Watch all post type folders for changes
        const pattern = new vscode.RelativePattern(
            this.devFolderPath,
            '{post-types/{pages,posts},templates,parts,patterns}/**/*_[0-9]*'
        );
        
        this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
        
        // Track folder deletions (part of move operation)
        this.watcher.onDidDelete(async (uri) => {
            const folderPath = uri.fsPath;
            
            // Only track if it's a folder with _ID suffix
            if (this.isFolderWithId(folderPath)) {
                this.logger.log(`Post Type Converter: Folder deleted (potential move): ${folderPath}`);
                
                // Store for potential move detection
                this.pendingMoves.set(path.basename(folderPath), {
                    oldPath: folderPath,
                    timestamp: Date.now()
                });
                
                // Clean up old pending moves after 5 seconds
                setTimeout(() => {
                    this.pendingMoves.delete(path.basename(folderPath));
                }, 5000);
            }
        });
        
        // Track folder creations (part of move operation)
        this.watcher.onDidCreate(async (uri) => {
            const folderPath = uri.fsPath;
            
            // Check if this is part of a move operation
            const folderName = path.basename(folderPath);
            const pending = this.pendingMoves.get(folderName);
            
            if (pending && this.isFolderWithId(folderPath)) {
                this.logger.log(`Post Type Converter: Folder created (move detected): ${folderPath}`);
                
                // This is a move! Handle it
                await this.handleFolderMove(pending.oldPath, folderPath);
                
                // Clean up
                this.pendingMoves.delete(folderName);
            }
        });
        
        this.logger.log('Post Type Converter: Started watching for folder moves');
    }
    
    /**
     * Check if path is a folder with _ID suffix
     */
    private isFolderWithId(folderPath: string): boolean {
        const folderName = path.basename(folderPath);
        return /_\d+$/.test(folderName);
    }
    
    /**
     * Handle folder move detection
     */
    private async handleFolderMove(oldPath: string, newPath: string): Promise<void> {
        try {
            // Extract post types from paths
            const sourceType = this.extractPostType(oldPath);
            const targetType = this.extractPostType(newPath);
            
            if (!sourceType || !targetType) {
                this.logger.log('Post Type Converter: Not a post type folder move');
                return;
            }
            
            if (sourceType === targetType) {
                this.logger.log('Post Type Converter: Same type move, ignoring');
                return;
            }
            
            // Extract post ID from folder name
            const folderName = path.basename(oldPath);
            const match = folderName.match(/_(\d+)$/);
            
            if (!match) {
                this.logger.log('Post Type Converter: No ID found in folder name');
                return;
            }
            
            const postId = parseInt(match[1], 10);
            
            // Get post title for confirmation
            const postTitle = await this.getPostTitle(newPath);
            
            this.logger.log(`Post Type Converter: Detected conversion: ${sourceType} -> ${targetType} (ID: ${postId})`);
            
            // Show conversion prompt
            await this.showConversionPrompt(postId, postTitle, sourceType, targetType, oldPath, newPath);
            
        } catch (error) {
            this.logger.log(`Post Type Converter: Error handling move: ${error}`);
        }
    }
    
    /**
     * Extract post type from folder path
     */
    private extractPostType(folderPath: string): string | null {
        const normalizedPath = folderPath.replace(/\\/g, '/');
        
        for (const [folder, postType] of Object.entries(this.FOLDER_MAP)) {
            if (normalizedPath.includes(folder)) {
                return postType;
            }
        }
        
        return null;
    }
    
    /**
     * Get post title from HTML file
     */
    private async getPostTitle(folderPath: string): Promise<string> {
        try {
            // Find HTML files in folder
            const files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(folderPath, '*.html'),
                null,
                1
            );
            
            if (files.length === 0) {
                return path.basename(folderPath);
            }
            
            // Read HTML and extract title from metadata comment
            const content = await vscode.workspace.fs.readFile(files[0]);
            const text = Buffer.from(content).toString('utf8');
            
            const titleMatch = text.match(/Title:\s*(.+)/);
            return titleMatch ? titleMatch[1].trim() : path.basename(folderPath);
            
        } catch (error) {
            this.logger.log(`Post Type Converter: Error getting title: ${error}`);
            return path.basename(folderPath);
        }
    }
    
    /**
     * Show conversion prompt to user
     */
    private async showConversionPrompt(
        postId: number,
        postTitle: string,
        sourceType: string,
        targetType: string,
        oldPath: string,
        newPath: string
    ): Promise<void> {
        const sourceLabel = this.getTypeLabel(sourceType);
        const targetLabel = this.getTypeLabel(targetType);
        
        const action = await vscode.window.showWarningMessage(
            `Convert "${postTitle}" from ${sourceLabel} to ${targetLabel}?`,
            {
                modal: true,
                detail: `You moved this folder from ${sourceLabel} to ${targetLabel}. Do you want to update the post type in WordPress to match?`
            },
            'Convert in WordPress',
            'Undo Move',
            'Ignore'
        );
        
        if (action === 'Convert in WordPress') {
            await this.performConversion(postId, postTitle, targetType, newPath);
        } else if (action === 'Undo Move') {
            await this.undoMove(oldPath, newPath, postTitle);
        } else {
            this.logger.log('Post Type Converter: User ignored conversion');
        }
    }
    
    /**
     * Perform conversion via WordPress API
     */
    private async performConversion(
        postId: number,
        postTitle: string,
        targetType: string,
        newPath: string
    ): Promise<void> {
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Converting "${postTitle}"...`,
                cancellable: false
            }, async (progress) => {
                progress.report({ increment: 0, message: 'Calling WordPress API...' });
                
                // Call WordPress API directly using restClient's internal client
                const response = await (this.restClient as any).client.post('/convert-post-type', {
                    post_id: postId,
                    target_type: targetType,
                    options: {
                        preserve_metadata: true,
                        delete_original: true
                    }
                });
                
                progress.report({ increment: 50, message: 'Updating local files...' });
                
                const result = response.data;
                
                if (result.success) {
                    // Update local file metadata
                    await this.updateLocalMetadata(newPath, result.data);
                    
                    progress.report({ increment: 100 });
                    
                    vscode.window.showInformationMessage(
                        `✓ "${postTitle}" converted successfully to ${this.getTypeLabel(targetType)}`
                    );
                    
                    this.logger.log(`Post Type Converter: Conversion successful (ID: ${postId})`);
                } else {
                    throw new Error(result.error || 'Conversion failed');
                }
            });
        } catch (error: any) {
            vscode.window.showErrorMessage(
                `Failed to convert post type: ${error.message}`
            );
            this.logger.log(`Post Type Converter: Conversion failed: ${error}`);
        }
    }
    
    /**
     * Undo folder move
     */
    private async undoMove(oldPath: string, newPath: string, postTitle: string): Promise<void> {
        try {
            // Check if folder still exists at new path
            try {
                await vscode.workspace.fs.stat(vscode.Uri.file(newPath));
            } catch {
                vscode.window.showWarningMessage('Folder no longer exists at the new location');
                return;
            }
            
            // Move folder back
            await vscode.workspace.fs.rename(
                vscode.Uri.file(newPath),
                vscode.Uri.file(oldPath),
                { overwrite: false }
            );
            
            vscode.window.showInformationMessage(
                `✓ "${postTitle}" moved back to original location`
            );
            
            this.logger.log('Post Type Converter: Move undone successfully');
            
        } catch (error: any) {
            vscode.window.showErrorMessage(
                `Failed to undo move: ${error.message}`
            );
            this.logger.log(`Post Type Converter: Undo failed: ${error}`);
        }
    }
    
    /**
     * Update local file metadata after conversion
     */
    private async updateLocalMetadata(folderPath: string, conversionResult: any): Promise<void> {
        try {
            // Find HTML file
            const files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(folderPath, '*.html'),
                null,
                1
            );
            
            if (files.length === 0) {
                this.logger.log('Post Type Converter: No HTML file found for metadata update');
                return;
            }
            
            // Read file
            const content = await vscode.workspace.fs.readFile(files[0]);
            let text = Buffer.from(content).toString('utf8');
            
            // Build new metadata comment
            const metadataComment = this.buildMetadataComment(conversionResult);
            
            // Replace or prepend metadata
            if (text.includes('WordPress Sync Metadata')) {
                text = text.replace(
                    /<!--\s*WordPress Sync Metadata[\s\S]*?-->/,
                    metadataComment
                );
            } else {
                text = metadataComment + '\n' + text;
            }
            
            // Write back
            await vscode.workspace.fs.writeFile(
                files[0],
                Buffer.from(text, 'utf8')
            );
            
            this.logger.log('Post Type Converter: Local metadata updated');
            
        } catch (error) {
            this.logger.log(`Post Type Converter: Error updating metadata: ${error}`);
        }
    }
    
    /**
     * Build metadata comment
     */
    private buildMetadataComment(data: any): string {
        const now = new Date().toISOString();
        return `<!--
WordPress Sync Metadata
ID: ${data.target_id || data.source_id}
Type: ${data.target_type}
Status: publish
Modified: ${now}
-->`;
    }
    
    /**
     * Get human-readable post type label
     */
    private getTypeLabel(postType: string): string {
        const labels: Record<string, string> = {
            'page': 'Page',
            'post': 'Post',
            'wp_template': 'Template',
            'wp_template_part': 'Template Part',
            'wp_block': 'Pattern'
        };
        return labels[postType] || postType;
    }
    
    /**
     * Stop watching and clean up
     */
    public dispose(): void {
        if (this.watcher) {
            this.watcher.dispose();
            this.watcher = undefined;
        }
        this.pendingMoves.clear();
        this.logger.log('Post Type Converter: Disposed');
    }
}
