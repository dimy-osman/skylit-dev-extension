/**
 * REST API Client
 * Communicates with WordPress Skylit plugin via REST API
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import * as vscode from 'vscode';
import {
    SyncResponse,
    FolderActionResponse,
    TokenValidationResponse,
    StatusResponse,
    BlockLocationResponse,
    AssetSyncResponse
} from './types';

export class RestClient {
    private client: AxiosInstance;
    private outputChannel: vscode.OutputChannel;
    private baseUrl: string;
    private token: string;

    constructor(
        siteUrl: string,
        token: string,
        outputChannel: vscode.OutputChannel
    ) {
        this.baseUrl = siteUrl.replace(/\/$/, ''); // Remove trailing slash
        this.token = token;
        this.outputChannel = outputChannel;

        // Create axios instance
        this.client = axios.create({
            baseURL: `${this.baseUrl}/wp-json/skylit/v1`,
            timeout: 30000, // 30 second timeout
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        // Add response interceptor for error handling
        this.client.interceptors.response.use(
            response => response,
            error => this.handleError(error)
        );
    }

    /**
     * Validate auth token
     */
    async validateToken(): Promise<boolean> {
        try {
            this.outputChannel.appendLine('🔑 Validating auth token...');
            
            const response = await this.client.get<TokenValidationResponse>(
                '/sync/validate-token'
            );

            if (response.data.valid) {
                this.outputChannel.appendLine(
                    `✅ Token valid for user: ${response.data.user?.name || 'Unknown'}`
                );
                return true;
            }

            return false;
        } catch (error: any) {
            this.outputChannel.appendLine(`❌ Token validation failed: ${error.message}`);
            return false;
        }
    }

    /**
     * Get plugin status
     */
    async getStatus(): Promise<StatusResponse> {
        const response = await this.client.get<StatusResponse>('/sync/status');
        return response.data;
    }

    /**
     * Sync file instantly to WordPress
     */
    async syncFile(postId: number, html: string, css: string): Promise<SyncResponse> {
        this.outputChannel.appendLine(`📤 Syncing post ${postId}...`);
        
        try {
            const response = await this.client.post<SyncResponse>(
                '/sync/import-instant',
                {
                    post_id: postId,
                    html: html,
                    css: css,
                    trigger: 'extension'
                }
            );

            if (response.data.success) {
                this.outputChannel.appendLine(
                    `✅ Synced! ${response.data.blocks_updated || 0} blocks updated`
                );
            }

            return response.data;
        } catch (error: any) {
            this.outputChannel.appendLine(`❌ Sync failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Send folder action (trash/restore/delete)
     */
    async sendFolderAction(
        postId: number,
        action: 'trash' | 'restore' | 'delete'
    ): Promise<FolderActionResponse> {
        this.outputChannel.appendLine(`📁 Folder action: ${action} post ${postId}`);
        
        try {
            const response = await this.client.post<FolderActionResponse>(
                '/sync/folder-action',
                {
                    post_id: postId,
                    action: action
                }
            );

            if (response.data.success) {
                this.outputChannel.appendLine(`✅ ${action} successful`);
            }

            return response.data;
        } catch (error: any) {
            this.outputChannel.appendLine(`❌ Folder action failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get block location in HTML file
     */
    async getBlockLocation(
        postId: number,
        blockClientId: string
    ): Promise<BlockLocationResponse> {
        const response = await this.client.post<BlockLocationResponse>(
            '/sync/block-location',
            {
                post_id: postId,
                block_client_id: blockClientId
            }
        );

        return response.data;
    }

    /**
     * Check for file changes (used for circular sync prevention)
     */
    async checkForChanges(postId: number): Promise<{ skip_import: boolean }> {
        const response = await this.client.get(`/sync/check/${postId}`);
        return response.data;
    }

    /**
     * Poll for pending jump requests (jump-to-code)
     */
    async getPendingJump(): Promise<{
        pending: boolean;
        file?: string;
        line?: number;
        column?: number;
    }> {
        const response = await this.client.get('/sync/get-jump');
        return response.data;
    }

    /**
     * Get block changes from last export
     * Used to restore folding states for unchanged blocks
     */
    async getBlockChanges(postId: number): Promise<{
        success: boolean;
        post_id: number;
        has_data: boolean;
        blocks_changed?: number;
        blocks_unchanged?: number;
        changed_blocks?: Array<{
            layoutBlockId: string;
            blockName: string;
            startLine: number;
            endLine: number;
        }>;
        unchanged_blocks?: Array<{
            layoutBlockId: string;
            blockName: string;
            startLine: number;
            endLine: number;
            whitespace_only?: boolean;
        }>;
        timestamp?: string;
        file_unchanged?: boolean;
    }> {
        const response = await this.client.get(`/sync/block-changes/${postId}`);
        return response.data;
    }

    /**
     * Sync theme.json from dev folder to active theme
     */
    async syncThemeJson(): Promise<{ success: boolean; message?: string }> {
        this.outputChannel.appendLine('🎨 Syncing theme.json...');
        
        try {
            const response = await this.client.post('/theme/sync-json');
            
            if (response.data.success) {
                this.outputChannel.appendLine('✅ theme.json synced');
            }
            
            return response.data;
        } catch (error: any) {
            this.outputChannel.appendLine(`❌ theme.json sync failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Import global CSS from file to database
     */
    async importGlobalCss(): Promise<{ success: boolean }> {
        this.outputChannel.appendLine('🎨 Importing global CSS...');
        
        try {
            const response = await this.client.post('/global-css/import');
            return response.data;
        } catch (error: any) {
            this.outputChannel.appendLine(`❌ Global CSS import failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Sync assets from dev folder to active theme
     * Copies CSS/JS/images from dev folder to theme for standard WordPress loading
     */
    async syncAssets(direction: 'to_theme' | 'from_theme' = 'to_theme'): Promise<AssetSyncResponse> {
        const directionLabel = direction === 'to_theme' ? 'dev → theme' : 'theme → dev';
        this.outputChannel.appendLine(`📦 Syncing assets (${directionLabel})...`);
        
        try {
            const response = await this.client.post<AssetSyncResponse>('/assets/sync', {
                direction: direction
            });
            
            if (response.data.success) {
                this.outputChannel.appendLine(`✅ Assets synced (${directionLabel})`);
            }
            
            return response.data;
        } catch (error: any) {
            this.outputChannel.appendLine(`❌ Asset sync failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Sync assets from theme back to dev folder (reverse sync)
     * Used when theme files are edited directly
     */
    async syncAssetsFromTheme(): Promise<AssetSyncResponse> {
        return this.syncAssets('from_theme');
    }

    /**
     * Sync assets from dev folder to theme
     * Used when dev folder files are edited
     */
    async syncAssetsToTheme(): Promise<AssetSyncResponse> {
        return this.syncAssets('to_theme');
    }

    /**
     * Get asset sync status including theme path
     */
    async getAssetStatus(): Promise<{
        dev_path: string;
        theme_path: string;
        directories: any;
    }> {
        const response = await this.client.get('/assets/status');
        return response.data;
    }

    /**
     * Import all new files from dev folder
     * Creates posts from folders without _ID suffix
     */
    async importNewFiles(): Promise<{
        success: boolean;
        imported: string[];
        skipped: string[];
        errors: string[];
    }> {
        this.outputChannel.appendLine('📥 Importing new files from dev folder...');
        
        try {
            const response = await this.client.post('/sync/import-new');
            
            if (response.data.success) {
                this.outputChannel.appendLine(
                    `✅ Import complete: ${response.data.imported?.length || 0} imported, ` +
                    `${response.data.skipped?.length || 0} skipped`
                );
            }
            
            return response.data;
        } catch (error: any) {
            this.outputChannel.appendLine(`❌ Import failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Create an empty WordPress post and get the ID
     * Used by AI to get the correct folder path BEFORE creating files
     * This prevents the race condition where AI creates files in wrong folder
     */
    async createEmptyPost(
        postType: string,
        title: string,
        slug: string
    ): Promise<{
        success: boolean;
        post_id?: number;
        folder_name?: string;
        error?: string;
    }> {
        this.outputChannel.appendLine(`📄 Creating empty ${postType}: "${title}" (${slug})`);
        
        try {
            const response = await this.client.post('/sync/create-empty-post', {
                post_type: postType,
                title: title,
                slug: slug
            });
            
            if (response.data.success) {
                this.outputChannel.appendLine(
                    `✅ Created: ${response.data.title} (ID: ${response.data.post_id})`
                );
            }
            
            return response.data;
        } catch (error: any) {
            this.outputChannel.appendLine(`❌ Create empty post failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Create a new post from a specific folder
     * Used when a new folder is detected in post-types directory
     */
    async createPostFromFolder(
        folderPath: string,
        postType: string
    ): Promise<{
        success: boolean;
        post_id?: number;
        post_type?: string;
        title?: string;
        slug?: string;
        old_folder?: string;
        new_folder?: string;
        message?: string;
        error?: string;
    }> {
        this.outputChannel.appendLine(`📄 Creating post from folder: ${folderPath} (${postType})`);
        
        try {
            const response = await this.client.post('/sync/create-post', {
                folder_path: folderPath,
                post_type: postType
            });
            
            if (response.data.success) {
                this.outputChannel.appendLine(
                    `✅ Created: ${response.data.title} (ID: ${response.data.post_id})`
                );
            }
            
            return response.data;
        } catch (error: any) {
            this.outputChannel.appendLine(`❌ Create post failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Update post slug (for bidirectional rename support)
     * Called when a folder is renamed in IDE
     */
    async updatePostSlug(
        postId: number,
        newSlug: string
    ): Promise<{
        success: boolean;
        post_id?: number;
        old_slug?: string;
        new_slug?: string;
        message?: string;
        error?: string;
    }> {
        this.outputChannel.appendLine(`📝 Updating slug for post ${postId}: ${newSlug}`);
        
        try {
            const response = await this.client.post('/sync/update-slug', {
                post_id: postId,
                new_slug: newSlug
            });
            
            if (response.data.success) {
                this.outputChannel.appendLine(
                    `✅ Slug updated: ${response.data.old_slug} → ${response.data.new_slug}`
                );
            }
            
            return response.data;
        } catch (error: any) {
            this.outputChannel.appendLine(`❌ Update slug failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Update post from metadata (for bidirectional sync)
     * Called when JSON metadata file changes in IDE
     */
    async updateFromMetadata(
        postId: number,
        metadata: {
            slug?: string;
            title?: string;
            status?: string;
        }
    ): Promise<{
        success: boolean;
        post_id?: number;
        changes?: Record<string, { from: string; to: string }>;
        folder_renamed?: boolean;
        message?: string;
        error?: string;
    }> {
        this.outputChannel.appendLine(`📝 Updating post ${postId} from metadata`);
        
        try {
            const response = await this.client.post('/sync/update-from-metadata', {
                post_id: postId,
                ...metadata
            });
            
            if (response.data.success) {
                this.outputChannel.appendLine(
                    `✅ Metadata synced: ${response.data.message}`
                );
            }
            
            return response.data;
        } catch (error: any) {
            this.outputChannel.appendLine(`❌ Metadata sync failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get folder rename notifications from plugin
     * Called periodically to catch any renames that might have been missed
     */
    async getRenameNotifications(
        since?: number,
        clear: boolean = false
    ): Promise<{
        success: boolean;
        notifications: Array<{
            type: string;
            old_folder: string;
            new_folder: string;
            post_id: number;
            post_type: string;
            timestamp: number;
            message: string;
        }>;
        count: number;
        timestamp: number;
    }> {
        try {
            const params: Record<string, any> = {};
            if (since !== undefined) {
                params.since = since;
            }
            if (clear) {
                params.clear = true;
            }
            
            const response = await this.client.get('/sync/rename-notifications', { params });
            
            if (response.data.count > 0) {
                this.outputChannel.appendLine(
                    `📁 ${response.data.count} rename notification(s) received`
                );
            }
            
            return response.data;
        } catch (error: any) {
            // Don't log error for this - it's just a polling endpoint
            return {
                success: false,
                notifications: [],
                count: 0,
                timestamp: Date.now() / 1000
            };
        }
    }

    /**
     * Process pending folder renames on the server
     * Triggers retry of any failed folder renames
     */
    async processPendingRenames(): Promise<{
        success: boolean;
        results: {
            processed: number;
            success: number;
            failed: number;
            removed?: number;
        };
        message: string;
    }> {
        this.outputChannel.appendLine('🔄 Processing pending folder renames...');
        
        try {
            const response = await this.client.post('/sync/process-pending-renames');
            
            if (response.data.results.success > 0) {
                this.outputChannel.appendLine(
                    `✅ ${response.data.results.success} pending rename(s) completed`
                );
            }
            
            return response.data;
        } catch (error: any) {
            this.outputChannel.appendLine(`⚠️ Could not process pending renames: ${error.message}`);
            return {
                success: false,
                results: { processed: 0, success: 0, failed: 0 },
                message: error.message
            };
        }
    }

    /**
     * Handle axios errors
     */
    private handleError(error: AxiosError): Promise<never> {
        if (error.response) {
            // Server responded with error status
            const status = error.response.status;
            const data = error.response.data as any;
            const message = data?.error || data?.message || error.message;

            this.outputChannel.appendLine(`❌ API Error ${status}: ${message}`);
            
            // Log additional details if available
            if (data?.error && data?.error !== message) {
                this.outputChannel.appendLine(`   Details: ${data.error}`);
            }

            if (status === 401 || status === 403) {
                vscode.window.showErrorMessage(
                    'Authentication failed. Please regenerate your auth token.'
                );
            } else if (status === 404) {
                // Log but don't popup for 404 - might be during plugin updates
                this.outputChannel.appendLine('   Skylit plugin API not found. Ensure plugin is activated and updated.');
            }
            // Don't show popup for 400 errors during batch operations (scan)
            // The error is already logged to output channel
        } else if (error.request) {
            // Request made but no response
            this.outputChannel.appendLine('❌ No response from WordPress');
            // Only log, don't popup - might be temporary network issue
        } else {
            // Error setting up request
            this.outputChannel.appendLine(`❌ Request error: ${error.message}`);
        }

        return Promise.reject(error);
    }
}
