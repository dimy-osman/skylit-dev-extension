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
	type: "add" | "change" | "unlink";
	postId?: number;
	postType?: string;
}

/**
 * Folder action event (trash/restore/delete)
 */
export interface FolderActionEvent {
	path: string;
	action: "trash" | "restore" | "delete";
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
	action: "trash" | "restore" | "delete";
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
	/** Plugin's dev folder location setting: 'root' | 'app' | 'wp_root' | 'wp_content' | 'custom' | 'remote' */
	dev_folder_location?: string;
	theme_path?: string;
	last_sync: string | null;
	/** 'auto' = rename after delay, 'manual' = only on explicit user request */
	id_assign_mode?: "auto" | "manual";
	/** Delay in seconds before auto-rename (used only when id_assign_mode = 'auto') */
	id_assign_delay?: number;
	/** Where global JS is loaded from on the frontend: 'theme' | 'database' */
	js_source?: "theme" | "database";
	/** Where global CSS is loaded from on the frontend: 'theme' | 'database' */
	css_source?: "theme" | "database";
	/** Where global PHP is loaded from on the frontend: 'theme' | 'database' */
	php_source?: "theme" | "database";
}

/**
 * Asset sync REST API response
 */
export interface AssetSyncResponse {
	success: boolean;
	direction: "to_theme" | "from_theme";
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
export type ConnectionState =
	| "disconnected"
	| "connecting"
	| "connected"
	| "error";

/**
 * Sync status for status bar
 */
export type SyncStatus = "idle" | "syncing" | "error";

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
	localDevPath: string;
}

/**
 * Export payload from WordPress (API-first export)
 */
export interface ExportPayload {
	post_id: number;
	html: string;
	css: string;
	slug: string;
	title: string;
	post_type: string;
	post_status: string;
	folder_name: string;
	type_folder: string;
	block_changes: {
		changed_blocks: Array<{
			layoutBlockId: string;
			blockName: string | null;
			line: number;
		}>;
		unchanged_blocks: Array<{
			layoutBlockId: string;
			blockName: string | null;
			line: number;
		}>;
	};
	timestamp: number;
}

/**
 * Pending exports response
 */
export interface PendingExportsResponse {
	pending: number[];
	count: number;
}

/**
 * Export-all manifest entry
 */
export interface ExportManifestEntry {
	post_id: number;
	slug: string;
	title: string;
	post_type: string;
	post_status: string;
	folder_name: string;
	type_folder: string;
	has_pending: boolean;
	sync_hash?: string;
}

/**
 * Export-all response
 */
export interface ExportAllResponse {
	posts: ExportManifestEntry[];
	count: number;
}

/**
 * Discovery response (updated with remote capability)
 */
export interface DiscoverResponse {
	siteUrl: string;
	devPath: string;
	remoteCapable?: boolean;
}

/**
 * A registered site in the multi-site registry.
 * Tokens are stored separately in SecretStorage keyed by URL.
 */
export interface RegisteredSite {
	url: string;
	name: string;
	localDevPath?: string;
	addedAt: number;
}

/**
 * A single skill file returned by the skillset/files endpoint
 */
export interface SkillsetFile {
	filename: string;
	type: "system" | "custom";
	content: string;
}

/**
 * Response from GET /skylit/v1/skillset/files
 */
export interface SkillsetFilesResponse {
	success: boolean;
	files: SkillsetFile[];
}

// ---- Media Library Sync ----

export type MediaSyncDirection = "bidirectional" | "wp-to-local" | "local-to-wp";

export interface MediaMetadata {
	attachment_id: number;
	local_path: string;
	wp_path: string;
	sync_hash: string;
	modified_local: string;
	modified_wp: string;
}

export interface MediaPushResult {
	success: boolean;
	attachment_id?: number;
	url?: string;
	error?: string;
}

export interface MediaPushResponse {
	success: boolean;
	results: MediaPushResult[];
}

export interface MediaRenameResponse {
	success: boolean;
	attachment_id?: number;
	new_path?: string;
	message?: string;
}

export interface MediaSettingsResponse {
	enabled: boolean;
	direction: MediaSyncDirection;
}
