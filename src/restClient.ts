/**
 * REST API Client
 * Communicates with WordPress Skylit plugin via REST API
 */

import axios, { AxiosInstance, AxiosError } from "axios";
import { createHash } from "crypto";
import * as vscode from "vscode";
import { DebugLogger } from "./debugLogger";
import {
	SyncResponse,
	FolderActionResponse,
	TokenValidationResponse,
	StatusResponse,
	BlockLocationResponse,
	AssetSyncResponse,
	PendingExportsResponse,
	ExportPayload,
	ExportAllResponse,
	DiscoverResponse,
	SkillsetFilesResponse,
	MediaPushResponse,
	MediaRenameResponse,
	MediaSettingsResponse,
} from "./types";

export class RestClient {
	private client: AxiosInstance;
	private debugLogger: DebugLogger;
	private baseUrl: string;
	private token: string;
	public isRemoteMode: boolean = false;
	private useQueryParamAuth: boolean = false;

	/**
	 * Get the base site URL this client is connected to
	 */
	getSiteUrl(): string {
		return this.baseUrl;
	}

	constructor(siteUrl: string, token: string, debugLogger: DebugLogger) {
		this.baseUrl = siteUrl.replace(/\/$/, ""); // Remove trailing slash
		this.token = token;
		this.debugLogger = debugLogger;

		// Create axios instance
		this.client = axios.create({
			baseURL: `${this.baseUrl}/wp-json/skylit/v1`,
			timeout: 30000, // 30 second timeout
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
		});

		// Request interceptor: append token as query param when header auth is stripped
		this.client.interceptors.request.use((config) => {
			if (this.useQueryParamAuth) {
				config.params = config.params || {};
				config.params._skylit_token = this.token;
			}
			return config;
		});

		// Add response interceptor for error handling
		this.client.interceptors.response.use(
			(response) => response,
			(error) => this.handleError(error)
		);
	}

	/**
	 * Discovery endpoint (no auth required) - returns canonical siteUrl and devPath
	 * Call this BEFORE authentication to get the correct site URL
	 */
	static async discover(
		baseUrl: string,
		debugLogger: DebugLogger
	): Promise<DiscoverResponse | null> {
		const url = `${baseUrl.replace(/\/$/, "")}/wp-json/skylit/v1/sync/discover`;
		debugLogger.log(`🔍 Discovering site config from ${url}`);

		try {
			const response = await axios.get(url, {
				timeout: 10000,
			});
			if (response.data?.siteUrl) {
				debugLogger.log(
					`   ✅ Discovered: siteUrl=${response.data.siteUrl}, devPath=${
						response.data.devPath || "(remote)"
					}, remoteCapable=${response.data.remoteCapable || false}`
				);
				return {
					siteUrl: response.data.siteUrl.replace(/\/$/, ""),
					devPath: response.data.devPath || "",
					remoteCapable: response.data.remoteCapable || false,
				};
			}
		} catch (error: any) {
			debugLogger.log(`   ⚠️ Discovery failed: ${error.message}`);
		}
		return null;
	}

	/**
	 * Validate auth token
	 */
	/**
	 * Result of token validation with reason for failure.
	 * `tokenInvalid` is true ONLY when the server explicitly rejected the token.
	 * When false, the failure is due to network/server issues and the token should be kept.
	 */
	async validateToken(): Promise<{ valid: boolean; tokenInvalid: boolean }> {
		const tokenPreview = this.token
			? `${this.token.substring(0, 12)}...${this.token.substring(this.token.length - 4)}`
			: "(empty)";
		const url = `${this.baseUrl}/wp-json/skylit/v1/sync/validate-token`;

		// Attempt 1: Header-based auth (standard Bearer token)
		this.debugLogger.log(
			`🔑 Validating token (${tokenPreview}) against ${this.baseUrl}...`
		);
		try {
			const resp = await axios.get(url, {
				timeout: 30000,
				headers: {
					Authorization: `Bearer ${this.token}`,
					"Content-Type": "application/json",
				},
				validateStatus: () => true,
			});

			this.debugLogger.log(
				`   Header auth → HTTP ${resp.status} — ${JSON.stringify(resp.data)}`
			);

			if (resp.status === 200 && resp.data?.valid) {
				this.debugLogger.log(`✅ Token valid (header auth) for user ${resp.data.user_id}`);
				return { valid: true, tokenInvalid: false };
			}

			// 404 = REST route not registered = plugin crashed/deactivated
			if (resp.status === 404) {
				this.debugLogger.error(
					"❌ Skylit REST API not found (HTTP 404). Plugin may have crashed or is deactivated."
				);
				return { valid: false, tokenInvalid: false };
			}

			// 500 = server error (likely memory exhaustion)
			if (resp.status >= 500) {
				this.debugLogger.error(
					`❌ Server error (HTTP ${resp.status}). Check PHP error log — likely memory exhaustion.`
				);
				return { valid: false, tokenInvalid: false };
			}
		} catch (err: any) {
			this.debugLogger.log(`   Header auth network error: ${err.message}`);
		}

		// Attempt 2: Query parameter auth (for hosts that strip Authorization header)
		this.debugLogger.log(
			"🔄 Header auth failed — retrying with query parameter auth..."
		);
		try {
			const resp2 = await axios.get(url, {
				timeout: 30000,
				params: { _skylit_token: this.token },
				headers: { "Content-Type": "application/json" },
				validateStatus: () => true,
			});

			this.debugLogger.log(
				`   Query param auth → HTTP ${resp2.status} — ${JSON.stringify(resp2.data)}`
			);

			if (resp2.status === 200 && resp2.data?.valid) {
				this.useQueryParamAuth = true;
				this.debugLogger.log(
					`✅ Token valid (query param mode) for user ${resp2.data.user_id}`
				);
				this.debugLogger.info(
					"ℹ️ Your host strips the Authorization header. Using query param auth.\n" +
					"   For better security, add to .htaccess: RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]"
				);
				return { valid: true, tokenInvalid: false };
			}

			if (resp2.status === 404) {
				this.debugLogger.error(
					"❌ Skylit REST API not found (404). The plugin is not active on this WordPress site."
				);
				return { valid: false, tokenInvalid: false };
			}

			if (resp2.status >= 500) {
				this.debugLogger.error(
					`❌ Server error (HTTP ${resp2.status}). WordPress is crashing — check PHP error log.`
				);
				return { valid: false, tokenInvalid: false };
			}

			// 401 from both header and query param = token is genuinely wrong
			if (resp2.status === 401) {
				this.debugLogger.log("❌ Token rejected by WordPress (401 on both auth methods).");
				return { valid: false, tokenInvalid: true };
			}
		} catch (err: any) {
			this.debugLogger.log(`   Query param auth network error: ${err.message}`);
		}

		this.debugLogger.log("❌ Could not validate token — server may be down or unreachable.");
		return { valid: false, tokenInvalid: false };
	}

	/**
	 * Get plugin status
	 */
	async getStatus(): Promise<StatusResponse> {
		const response = await this.client.get<StatusResponse>("/sync/status");
		return response.data;
	}

	/**
	 * Sync file instantly to WordPress.
	 *
	 * Automatically retries on HTTP 503 (plugin's import queue timeout).
	 * The plugin sets a Retry-After header; we honour it so shared-hosting
	 * PHP workers have time to drain before the next attempt.
	 */
	async syncFile(
		postId: number,
		html: string,
		css: string,
		_retriesLeft: number = 4
	): Promise<SyncResponse> {
		const profileEnd = this.debugLogger.profileStart("REST import-instant");
		this.debugLogger.log(`📤 Syncing post ${postId}...`);

		try {
			const html_hash = createHash("md5").update(html).digest("hex");
			const css_hash = css
				? createHash("md5").update(css).digest("hex")
				: null;
			const body: Record<string, unknown> = {
				post_id: postId,
				html: html,
				css: css,
				trigger: "extension",
				html_hash,
				css_hash,
			};
			if (this.isRemoteMode) {
				body.include_canonical = true;
			}
			const response = await this.client.post<SyncResponse>(
				"/sync/import-instant",
				body
			);

			profileEnd(`post ${postId} blocks=${response.data.blocks_updated ?? 0}`);
			if (response.data.success) {
				this.debugLogger.log(
					`✅ Synced! ${response.data.blocks_updated || 0} blocks updated`
				);
			}

			return response.data;
		} catch (error: any) {
			profileEnd(`post ${postId} error`);

			const httpStatus = error?.response?.status ?? error?.status;

			// 503 = plugin's import serialization queue timed out (too many concurrent
			// imports).  Wait for the Retry-After period and try again, up to _retriesLeft
			// attempts.  This handles bursts where the AI saves many files at once.
			if (httpStatus === 503 && _retriesLeft > 0) {
				const retryAfterSec = parseInt(
					error?.response?.headers?.["retry-after"] ?? "5",
					10
				);
				const waitMs = retryAfterSec * 1000;
				this.debugLogger.log(
					`⏳ [syncFile] post ${postId} → 503, retrying in ${retryAfterSec}s (${_retriesLeft} retries left)...`
				);
				await new Promise<void>((r) => setTimeout(r, waitMs));
				return this.syncFile(postId, html, css, _retriesLeft - 1);
			}

			// Log the full response body so PHP errors are visible in the Output panel,
			// not just the generic "Request failed with status code 500" message.
			const responseBody = error?.response?.data;
			const bodyDetail = responseBody
				? (typeof responseBody === "string"
					? responseBody.substring(0, 500)
					: JSON.stringify(responseBody).substring(0, 500))
				: "(no response body)";
			this.debugLogger.log(
				`❌ Sync failed [${httpStatus ?? "?"}] post ${postId}: ${error.message} | body: ${bodyDetail}`
			);
			throw error;
		}
	}

	/**
	 * Force-sync a file to WordPress, bypassing the hash check.
	 */
	async forceSyncFile(
		postId: number,
		html: string,
		css: string
	): Promise<SyncResponse> {
		this.debugLogger.log(`🔧 Force-syncing post ${postId}...`);
		try {
			const body: Record<string, unknown> = {
				post_id: postId,
				html,
				css,
				trigger: "repair",
				force: true,
			};
			if (this.isRemoteMode) {
				body.include_canonical = true;
			}
			const response = await this.client.post<SyncResponse>(
				"/sync/import-instant",
				body
			);
			this.debugLogger.log(
				`✅ Force sync done: ${response.data.blocks_updated || 0} blocks`
			);
			return response.data;
		} catch (error: any) {
			this.debugLogger.log(`❌ Force sync failed: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Diagnose a post's block integrity and optionally repair.
	 */
	async diagnosePost(
		postId: number,
		repair: boolean = false
	): Promise<any> {
		this.debugLogger.log(
			`🔍 Diagnosing post ${postId}${repair ? " (with repair)" : ""}...`
		);
		try {
			const response = await this.client.post<any>(
				`/sync/diagnose/${postId}`,
				{ repair }
			);
			return response.data;
		} catch (error: any) {
			this.debugLogger.log(`❌ Diagnose failed: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Clear all sync hashes to force re-import on next cycle.
	 */
	async repairAll(): Promise<any> {
		this.debugLogger.log("🔧 Clearing all sync hashes...");
		try {
			const response = await this.client.post<any>("/sync/repair-all", {});
			this.debugLogger.log(
				`✅ Repair-all: ${response.data.hashes_cleared} hashes cleared`
			);
			return response.data;
		} catch (error: any) {
			this.debugLogger.log(`❌ Repair-all failed: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Repair corrupted CSS storage for a single post.
	 * Normalizes block CSS attrs and inline <style> payloads in DB content.
	 */
	async repairCssStorage(postId: number): Promise<any> {
		this.debugLogger.log(`🧼 Repairing CSS storage for post ${postId}...`);
		try {
			const response = await this.client.post<any>(
				`/repair/css-storage/${postId}`,
				{}
			);
			this.debugLogger.log(
				`✅ CSS storage repair finished (changed=${response.data?.changed ? "yes" : "no"})`
			);
			return response.data;
		} catch (error: any) {
			this.debugLogger.log(`❌ CSS storage repair failed: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Repair corrupted CSS storage across posts in batches.
	 * Uses cursor pagination to keep server memory usage bounded.
	 */
	async repairCssStorageAllBatch(
		cursor: number = 0,
		limit: number = 15,
		refreshFiles: boolean = false
	): Promise<any> {
		this.debugLogger.log(
			`🧼 Repairing CSS storage batch (cursor=${cursor}, limit=${limit}, refreshFiles=${refreshFiles})...`
		);
		try {
			const response = await this.client.post<any>(
				"/repair/css-storage-all",
				{
					cursor,
					limit,
					refresh_files: refreshFiles,
				}
			);
			return response.data;
		} catch (error: any) {
			this.debugLogger.log(
				`❌ CSS storage batch repair failed: ${error.message}`
			);
			throw error;
		}
	}

	/**
	 * Send folder action (trash/restore/delete)
	 */
	async sendFolderAction(
		postId: number,
		action: "trash" | "restore" | "delete"
	): Promise<FolderActionResponse> {
		this.debugLogger.log(`📁 Folder action: ${action} post ${postId}`);

		try {
			const response = await this.client.post<FolderActionResponse>(
				"/sync/folder-action",
				{
					post_id: postId,
					action: action,
				}
			);

			if (response.data.success) {
				this.debugLogger.log(`✅ ${action} successful`);
			}

			return response.data;
		} catch (error: any) {
			this.debugLogger.log(`❌ Folder action failed: ${error.message}`);
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
			"/sync/block-location",
			{
				post_id: postId,
				block_client_id: blockClientId,
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
	 * Poll for pending jump requests (jump-to-code).
	 * Cache-busted to avoid LiteSpeed / server-level HTTP caching.
	 */
	async getPendingJump(): Promise<{
		pending: boolean;
		file?: string;
		line?: number;
		column?: number;
		timestamp?: number;
	}> {
		const response = await this.client.get("/sync/get-jump", {
			params: { _t: Date.now() },
			headers: { "Cache-Control": "no-cache, no-store" },
		});
		return response.data;
	}

	/**
	 * Acknowledge a jump was consumed so the server can clear its state.
	 * Separate POST ensures the transient is deleted even if GET responses are cached.
	 */
	async clearPendingJump(): Promise<void> {
		try {
			await this.client.post("/sync/clear-jump");
		} catch {
			// Best-effort — if the endpoint doesn't exist yet, ignore
		}
	}

	/**
	 * Push cursor block ID to the server via direct DB write.
	 * Fire-and-forget with a short timeout so it doesn't block cursor movement.
	 */
	async pushCursorBlock(postId: number, blockId: string, ts: number): Promise<void> {
		try {
			await this.client.post("/sync/cursor", { post_id: postId, block_id: blockId, ts }, { timeout: 3000 });
		} catch {
			// Best-effort — don't let network issues affect cursor UX
		}
	}

	/**
	 * Rescan metadata line numbers using sequential structural matching.
	 * DB blocks are matched to the current HTML file; only metadata is updated.
	 */
	async rescanLines(postId: number): Promise<{
		success: boolean;
		blocks?: Array<{ layoutBlockId: string; blockName: string; line: number }>;
		count?: number;
	}> {
		const response = await this.client.post(`/sync/rescan-lines/${postId}`);
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
		this.debugLogger.log("🎨 Syncing theme.json...");

		try {
			const response = await this.client.post("/theme/sync-json");

			if (response.data.success) {
				this.debugLogger.log("✅ theme.json synced");
			}

			return response.data;
		} catch (error: any) {
			this.debugLogger.log(`❌ theme.json sync failed: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Import global CSS from file to database
	 */
	async importGlobalCss(): Promise<{ success: boolean }> {
		this.debugLogger.log("🎨 Importing global CSS...");

		try {
			const response = await this.client.post("/global-css/import");
			return response.data;
		} catch (error: any) {
			this.debugLogger.log(`❌ Global CSS import failed: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Sync assets from dev folder to active theme
	 * Copies CSS/JS/images from dev folder to theme for standard WordPress loading
	 */
	async syncAssets(
		direction: "to_theme" | "from_theme" = "to_theme"
	): Promise<AssetSyncResponse> {
		const directionLabel =
			direction === "to_theme" ? "dev → theme" : "theme → dev";
		this.debugLogger.log(`📦 Syncing assets (${directionLabel})...`);

		try {
			const response = await this.client.post<AssetSyncResponse>(
				"/assets/sync",
				{
					direction: direction,
				}
			);

			if (response.data.success) {
				this.debugLogger.log(`✅ Assets synced (${directionLabel})`);
			}

			return response.data;
		} catch (error: any) {
			this.debugLogger.log(`❌ Asset sync failed: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Sync assets from theme back to dev folder (reverse sync)
	 * Used when theme files are edited directly
	 */
	async syncAssetsFromTheme(): Promise<AssetSyncResponse> {
		return this.syncAssets("from_theme");
	}

	/**
	 * Sync assets from dev folder to theme
	 * Used when dev folder files are edited
	 */
	async syncAssetsToTheme(): Promise<AssetSyncResponse> {
		return this.syncAssets("to_theme");
	}

	/**
	 * Sync ACF JSON files from dev folder to theme + import into ACF/SCF database.
	 * Dedicated endpoint for acf-json/ changes so DB import happens immediately.
	 */
	async syncAcfJsonToTheme(): Promise<AssetSyncResponse> {
		this.debugLogger.log("📦 Syncing ACF JSON to theme + DB...");

		try {
			const response = await this.client.post<AssetSyncResponse>(
				"/assets/acf-json-sync"
			);

			if (response.data.success) {
				this.debugLogger.log("✅ ACF JSON synced to theme & imported to DB");
			}

			return response.data;
		} catch (error: any) {
			this.debugLogger.log(`❌ ACF JSON sync failed: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Sync taxonomy JSON files from the taxonomies/ dev folder into the WordPress database.
	 * Dedicated endpoint for taxonomies/ changes so term import happens immediately.
	 */
	async syncTaxonomyJsonToWp(): Promise<AssetSyncResponse> {
		this.debugLogger.log("🗂️ Syncing taxonomy JSON to WP DB...");

		try {
			const response = await this.client.post<AssetSyncResponse>(
				"/assets/taxonomy-sync"
			);

			if (response.data.success) {
				this.debugLogger.log("✅ Taxonomy JSON imported to WP DB");
			}

			return response.data;
		} catch (error: any) {
			this.debugLogger.log(`❌ Taxonomy JSON sync failed: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Import global assets (JS/CSS/PHP) into the WordPress database.
	 * Same-machine: plugin reads files from dev folder on disk.
	 * Remote: sends file contents in request body.
	 */
	async importGlobalAssets(
		types: string[],
		files?: Record<string, string>
	): Promise<{ success: boolean; updated: Record<string, number>; total: number; message: string }> {
		this.debugLogger.log(`📦 Importing global assets to DB (types: ${types.join(",")})...`);

		try {
			const payload: Record<string, unknown> = { types };
			if (files) {
				payload.files = files;
			}
			const response = await this.client.post<{
				success: boolean;
				updated: Record<string, number>;
				total: number;
				message: string;
			}>("/sync/import-global-assets", payload);

			if (response.data.success && response.data.total > 0) {
				this.debugLogger.log(`✅ Global assets updated: ${response.data.message}`);
			}
			return response.data;
		} catch (error: any) {
			this.debugLogger.log(`❌ Global asset import failed: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Push file contents directly to the active theme on the server.
	 * Used in remote dev folder mode instead of syncAssetsToTheme().
	 */
	async pushFiles(
		files: Array<{ path: string; content: string; encoding?: string }>
	): Promise<{
		success: boolean;
		written: string[];
		errors: Array<{ path: string; error: string }>;
		count: number;
	}> {
		this.debugLogger.log(
			`📤 Pushing ${files.length} file(s) to server theme...`
		);

		try {
			const response = await this.client.post("/assets/push-files", {
				files,
			});

			if (response.data.success) {
				this.debugLogger.log(`✅ Pushed ${response.data.count} files to theme`);
			} else {
				const failedPaths = (response.data.errors || [])
					.map((e: { path: string; error: string }) => `${e.path}: ${e.error}`)
					.join(", ");
				this.debugLogger.log(
					`⚠️ Push partial failure (${response.data.count} written, ${
						response.data.errors?.length || 0
					} failed): ${failedPaths}`
				);
			}

			return response.data;
		} catch (error: any) {
			this.debugLogger.log(`❌ Push files failed: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Get asset sync status including theme path
	 */
	async getAssetStatus(): Promise<{
		dev_path: string;
		theme_path: string;
		directories: any;
	}> {
		const response = await this.client.get("/assets/status");
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
		this.debugLogger.log("📥 Importing new files from dev folder...");

		try {
			const response = await this.client.post("/sync/import-new");

			if (response.data.success) {
				this.debugLogger.log(
					`✅ Import complete: ${
						response.data.imported?.length || 0
					} imported, ` + `${response.data.skipped?.length || 0} skipped`
				);
			}

			return response.data;
		} catch (error: any) {
			this.debugLogger.log(`❌ Import failed: ${error.message}`);
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
		this.debugLogger.log(
			`📄 Creating post from folder: ${folderPath} (${postType})`
		);
		this.debugLogger.log(
			`   Full URL: ${this.baseUrl}/wp-json/skylit/v1/sync/create-post`
		);

		try {
			const response = await this.client.post("/sync/create-post", {
				folder_path: folderPath,
				post_type: postType,
			});

			if (response.data.success) {
				this.debugLogger.log(
					`✅ Created: ${response.data.title} (ID: ${response.data.post_id})`
				);
			}

			return response.data;
		} catch (error: any) {
			const responseData = error.response?.data;
			const status = error.response?.status;
			const serverError = responseData?.error || responseData?.message || "";
			this.debugLogger.log(
				`❌ Create post failed (HTTP ${status}): ${error.message}`
			);
			this.debugLogger.log(
				`   Server response: ${JSON.stringify(
					responseData || "no response data"
				)}`
			);
			this.debugLogger.log(
				`   Sent: folder_path="${folderPath}", post_type="${postType}"`
			);

			// Show more helpful error to user
			const detail = serverError ? `: ${serverError}` : "";
			throw new Error(
				`Failed to create post: Request failed with status code ${status}${detail}`
			);
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
		this.debugLogger.log(`📝 Updating slug for post ${postId}: ${newSlug}`);

		try {
			const response = await this.client.post("/sync/update-slug", {
				post_id: postId,
				new_slug: newSlug,
			});

			if (response.data.success) {
				this.debugLogger.log(
					`✅ Slug updated: ${response.data.old_slug} → ${response.data.new_slug}`
				);
			}

			return response.data;
		} catch (error: any) {
			this.debugLogger.log(`❌ Update slug failed: ${error.message}`);
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
		this.debugLogger.log(`📝 Updating post ${postId} from metadata`);

		try {
			const response = await this.client.post("/sync/update-from-metadata", {
				post_id: postId,
				...metadata,
			});

			if (response.data.success) {
				this.debugLogger.log(`✅ Metadata synced: ${response.data.message}`);
			}

			return response.data;
		} catch (error: any) {
			this.debugLogger.log(`❌ Metadata sync failed: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Cleanup orphaned metadata files
	 * Removes metadata for posts/folders that no longer exist
	 */
	async cleanupMetadata(): Promise<{
		success: boolean;
		deleted: number;
		kept: number;
		message: string;
	}> {
		this.debugLogger.log("🧹 Cleaning up orphaned metadata...");

		try {
			const response = await this.client.post("/sync/cleanup-metadata");

			if (response.data.success && response.data.deleted > 0) {
				this.debugLogger.log(`✅ ${response.data.message}`);
			} else if (response.data.deleted === 0) {
				this.debugLogger.log("✅ No orphaned metadata found");
			}

			return response.data;
		} catch (error: any) {
			this.debugLogger.log(`⚠️ Metadata cleanup failed: ${error.message}`);
			return {
				success: false,
				deleted: 0,
				kept: 0,
				message: error.message,
			};
		}
	}

	/**
	 * Convert post type
	 */
	async convertPostType(
		postId: number,
		targetType: string,
		folderName: string
	): Promise<{
		success: boolean;
		message?: string;
		error?: string;
		post_id?: number;
		old_type?: string;
		new_type?: string;
	}> {
		this.debugLogger.log(`🔄 Converting post ${postId} to ${targetType}...`);

		try {
			const response = await this.client.post("/convert-post-type", {
				post_id: postId,
				target_type: targetType,
				folder_name: folderName,
			});

			if (response.data.success) {
				this.debugLogger.log(`✅ Post converted to ${targetType}`);
			} else {
				this.debugLogger.log(
					`❌ Conversion failed: ${response.data.error || "Unknown error"}`
				);
			}

			return response.data;
		} catch (error: any) {
			// Extract detailed error from response if available
			const responseData = error.response?.data;
			const detailedError = responseData?.error || error.message;
			const errorCode = responseData?.code || "unknown";
			const errorFile = responseData?.file || "";
			const errorLine = responseData?.line || "";

			this.debugLogger.log(`❌ Conversion failed: ${detailedError}`);
			if (errorFile) {
				this.debugLogger.log(`   File: ${errorFile}:${errorLine}`);
			}
			this.debugLogger.log(`   Code: ${errorCode}`);

			// Create a more informative error
			const err = new Error(detailedError);
			throw err;
		}
	}

	/**
	 * Update post metadata (status, slug, title, schedule)
	 */
	async updatePostMeta(
		postId: number,
		metadata: {
			status?: string;
			slug?: string;
			title?: string;
			scheduled_date?: string;
		}
	): Promise<{
		success: boolean;
		message?: string;
		error?: string;
		post_id?: number;
		changes?: Record<string, { from: string; to: string }>;
	}> {
		this.debugLogger.log(`📝 Updating post ${postId} metadata...`);

		try {
			const response = await this.client.post("/sync/update-from-metadata", {
				post_id: postId,
				...metadata,
			});

			if (response.data.success) {
				this.debugLogger.log(`✅ Post metadata updated`);
			} else {
				this.debugLogger.log(
					`❌ Update failed: ${response.data.error || "Unknown error"}`
				);
			}

			return response.data;
		} catch (error: any) {
			const responseData = error.response?.data;
			const detailedError = responseData?.error || error.message;

			this.debugLogger.log(`❌ Update metadata failed: ${detailedError}`);

			const err = new Error(detailedError);
			throw err;
		}
	}

	/**
	 * Get list of post IDs with pending exports (remote dev folder mode).
	 * Extension polls this to detect Gutenberg saves that need to be written locally.
	 */
	async getPendingExports(): Promise<PendingExportsResponse> {
		const response = await this.client.get<PendingExportsResponse>(
			"/sync/pending-exports"
		);
		return response.data;
	}

	/**
	 * Get export content for a specific post (remote dev folder mode).
	 * Returns the compiled HTML/CSS payload and clears the pending flag.
	 */
	async getExportContent(postId: number): Promise<ExportPayload> {
		const profileEnd = this.debugLogger.profileStart("REST getExportContent");
		this.debugLogger.log(`📥 Fetching export content for post ${postId}...`);

		const response = await this.client.get<ExportPayload>(
			`/sync/export-content/${postId}`
		);

		profileEnd(`post ${postId}`);
		this.debugLogger.log(
			`✅ Received: ${response.data.slug} (${
				response.data.html.length
			} bytes HTML, ${response.data.css?.length || 0} bytes CSS)`
		);

		return response.data;
	}

	/**
	 * Get manifest of all syncable posts (remote dev folder mode).
	 * Used for initial full sync on first connection.
	 */
	async getExportAll(): Promise<ExportAllResponse> {
		const profileEnd = this.debugLogger.profileStart("REST getExportAll");
		this.debugLogger.log("📦 Fetching export manifest for all posts...");

		const response = await this.client.get<ExportAllResponse>(
			"/sync/export-all"
		);

		profileEnd(`count=${response.data.count}`);
		this.debugLogger.log(`✅ Manifest received: ${response.data.count} posts`);

		return response.data;
	}

	/**
	 * Get pending folder actions (trash/restore/delete) for decoupled mode.
	 */
	async getPendingFolderActions(): Promise<{
		actions: Array<{ post_id: number; slug: string; type_folder: string; action: string; timestamp: number }>;
		count: number;
	}> {
		const response = await this.client.get("/sync/pending-folder-actions");
		return response.data;
	}

	/**
	 * Get global dev folder files (assets, includes, acf-json, etc.)
	 * for initial remote sync. Returns base64-encoded file contents.
	 */
	async getGlobalFiles(): Promise<{
		files: Array<{ path: string; content: string; encoding: string }>;
		count: number;
	}> {
		this.debugLogger.log("📦 Fetching global dev folder files...");

		const response = await this.client.get("/sync/global-files");

		this.debugLogger.log(
			`✅ Global files received: ${response.data.count} files`
		);

		return response.data;
	}

	/**
	 * Poll for pending relocation requests from plugin admin.
	 */
	async getPendingRelocate(): Promise<{
		pending: boolean;
		action?: string;
		source_path?: string;
		timestamp?: number;
		reason?: string;
	}> {
		const response = await this.client.get("/sync/pending-relocate");
		return response.data;
	}

	/**
	 * Acknowledge relocation complete (or failed) back to the plugin.
	 */
	async ackRelocate(
		success: boolean,
		localPath: string
	): Promise<{ success: boolean; message: string }> {
		this.debugLogger.log(
			`📤 Acknowledging relocation: ${
				success ? "success" : "failed"
			} → ${localPath}`
		);

		const response = await this.client.post("/sync/ack-relocate", {
			success: success,
			local_path: localPath,
		});

		return response.data;
	}

	/**
	 * Get all AI skillset files (system + custom) for writing to dev folder
	 */
	async getSkillsetFiles(): Promise<SkillsetFilesResponse> {
		this.debugLogger.log("📚 Fetching AI skillset files...");

		const response = await this.client.get<SkillsetFilesResponse>(
			"/skillset/files"
		);

		this.debugLogger.log(
			`✅ Skillset files received: ${response.data.files?.length ?? 0} files`
		);

		return response.data;
	}

	// -------------------------------------------------------------------------
	// Media Library Sync
	// -------------------------------------------------------------------------

	/**
	 * Push a single media file to WP via multipart form-data.
	 * Returns the push result for that file.
	 */
	async pushMediaFile(
		filePath: string,
		relativePath: string,
		fileBuffer: Buffer,
		mimeType: string,
		alt?: string,
		title?: string
	): Promise<MediaPushResponse> {
		const FormData = require("form-data");
		const nodePath = require("path");
		const form = new FormData();

		form.append("file_0", fileBuffer, {
			filename: nodePath.basename(relativePath),
			contentType: mimeType,
		});
		form.append("path_0", relativePath);
		if (alt) form.append("alt_0", alt);
		if (title) form.append("title_0", title);

		this.debugLogger.log(`📤 Pushing media file to WP: ${relativePath}`);

		const response = await this.client.post<MediaPushResponse>(
			"/media/push",
			form,
			{
				headers: {
					...form.getHeaders(),
					Authorization: `Bearer ${this.token}`,
				},
				timeout: 120000, // 2 minutes for large files
			}
		);

		return response.data;
	}

	/**
	 * Rename/move a media file in WP uploads to match a new local path.
	 */
	async renameMediaFile(
		attachmentId: number,
		newPath: string
	): Promise<MediaRenameResponse> {
		this.debugLogger.log(
			`🔀 Renaming WP media ${attachmentId} → ${newPath}`
		);
		const response = await this.client.post<MediaRenameResponse>(
			"/media/rename",
			{ attachment_id: attachmentId, new_path: newPath }
		);
		return response.data;
	}

	/**
	 * Delete a WP attachment by ID.
	 */
	async deleteMediaAttachment(attachmentId: number): Promise<void> {
		this.debugLogger.log(`🗑️ Deleting WP media attachment ${attachmentId}`);
		await this.client.delete(`/media/delete/${attachmentId}`);
	}

	/**
	 * Update alt/title/caption of a WP attachment.
	 */
	async updateMediaMeta(
		attachmentId: number,
		meta: { alt?: string; title?: string; caption?: string }
	): Promise<void> {
		await this.client.post("/media/update-metadata", {
			attachment_id: attachmentId,
			...meta,
		});
	}

	/**
	 * Get current media sync settings from WP.
	 */
	async getMediaSettings(): Promise<MediaSettingsResponse> {
		const response = await this.client.get<MediaSettingsResponse>("/media/settings");
		return response.data;
	}

	/**
	 * Run one paginated batch of WP→Dev import.
	 * Returns { processed, skipped, offset, total, done }.
	 */
	async importMediaBatch(offset: number): Promise<{
		processed: number; skipped: number; offset: number; total: number; done: boolean; message?: string;
	}> {
		const response = await this.client.post("/media/import", { offset });
		return (response.data as any).data;
	}

	/**
	 * Run one paginated batch of full media sync (honours direction setting).
	 */
	async fullMediaSyncBatch(offset: number): Promise<{
		processed: number; skipped: number; offset: number; total: number; done: boolean; message?: string;
	}> {
		const response = await this.client.post("/media/full-sync", { offset });
		return (response.data as any).data;
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

			this.debugLogger.log(`❌ API Error ${status}: ${message}`);

			// Log additional details if available
			if (data?.error && data?.error !== message) {
				this.debugLogger.log(`   Details: ${data.error}`);
			}

		if (status === 401 || status === 403) {
			// Log only — callers (validateToken / connectToWordPress) handle auth
			// failures contextually. Showing a popup here causes false alarms during
			// the two-attempt validation flow (header auth → query param fallback).
			this.debugLogger.log(`   Auth error ${status} — handled by caller`);
		} else if (status === 404) {
				// Log but don't popup for 404 - might be during plugin updates
				this.debugLogger.log(
					"   Skylit plugin API not found. Ensure plugin is activated and updated."
				);
			}
			// Don't show popup for 400 errors during batch operations (scan)
			// The error is already logged to output channel
		} else if (error.request) {
			// Request made but no response
			this.debugLogger.log("❌ No response from WordPress");
			// Only log, don't popup - might be temporary network issue
		} else {
			// Error setting up request
			this.debugLogger.log(`❌ Request error: ${error.message}`);
		}

		return Promise.reject(error);
	}
}
