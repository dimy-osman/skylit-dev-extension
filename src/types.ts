/**
 * TypeScript interfaces and types for Skylit Dev UI extension
 */

/**
 * WordPress site configuration
 */
export interface WordPressSite {
    name: string;
    path: string;
    siteUrl: string;
    devFolder: string;
    token?: string;
}

/**
 * Configuration parsed from wp-config.php
 */
export interface WpConfig {
    siteUrl: string;
    devFolder: string;
}

/**
 * File change event from chokidar
 */
export interface FileChangeEvent {
    path: string;
    type: 'add' | 'change' | 'unlink';
    postId?: number;
    postType?: string;
}

/**
 * Folder action event (trash/restore/delete)
 */
export interface FolderActionEvent {
    path: string;
    action: 'trash' | 'restore' | 'delete';
    postId: number;
    postType: string;
}

/**
 * WordPress REST API response for sync operations
 */
export interface SyncResponse {
    success: boolean;
    blocks_updated?: number;
    message?: string;
    timestamp?: string;
}

/**
 * Folder action REST API response
 */
export interface FolderActionResponse {
    success: boolean;
    action: 'trash' | 'restore' | 'delete';
    message: string;
}

/**
 * Token validation REST API response
 * Updated for v4.9.66: Returns minimal info (user_id only) for security
 */
export interface TokenValidationResponse {
    valid: boolean;
    user_id?: number; // Only user ID returned (no email/name for PII protection)
}

/**
 * Plugin status REST API response
 */
export interface StatusResponse {
    version: string;
    dev_path: string;
    theme_path?: string;
    last_sync: string | null;
}

/**
 * Asset sync REST API response
 */
export interface AssetSyncResponse {
    success: boolean;
    direction: 'to_theme' | 'from_theme';
    results?: {
        [key: string]: {
            status: string;
            synced: string[];
            errors?: string[];
        };
    };
}

/**
 * Block location REST API response
 */
export interface BlockLocationResponse {
    file: string;
    line: number;
    column: number;
}

/**
 * Extension connection state
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Sync status for status bar
 */
export type SyncStatus = 'idle' | 'syncing' | 'error';

/**
 * Post file structure
 */
export interface PostFiles {
    html: string;
    css: string;
    folder: string;
}

/**
 * Extension configuration from VS Code settings
 */
export interface ExtensionConfig {
    autoConnect: boolean;
    debounceMs: number;
    showNotifications: boolean;
    siteUrl: string;
}
