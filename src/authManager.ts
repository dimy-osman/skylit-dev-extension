/**
 * Authentication Manager
 * Handles secure storage of auth tokens using VS Code SecretStorage
 * and a multi-site registry for managing multiple domain/token pairs.
 */

import * as vscode from 'vscode';
import { DebugLogger } from './debugLogger';
import { RegisteredSite } from './types';

const REGISTRY_KEY = 'skylit.registeredSites';

export class AuthManager {
    private secretStorage: vscode.SecretStorage;
    private globalState: vscode.Memento;
    private debugLogger: DebugLogger;

    constructor(
        context: vscode.ExtensionContext,
        debugLogger: DebugLogger
    ) {
        this.secretStorage = context.secrets;
        this.globalState = context.globalState;
        this.debugLogger = debugLogger;
    }

    // ── Token management ──────────────────────────────────────────────

    async getToken(siteUrl: string): Promise<string | undefined> {
        const key = this.getStorageKey(siteUrl);
        const token = await this.secretStorage.get(key);
        
        if (token) {
            this.debugLogger.log(`🔑 Found saved token for ${siteUrl}`);
        } else {
            this.debugLogger.log(`⚠️ No token found for ${siteUrl}`);
        }

        return token;
    }

    async saveToken(siteUrl: string, token: string): Promise<void> {
        const key = this.getStorageKey(siteUrl);
        const cleanToken = token.trim();
        await this.secretStorage.store(key, cleanToken);
        this.debugLogger.info(`✅ Saved token for ${siteUrl}`);
    }

    async deleteToken(siteUrl: string): Promise<void> {
        const key = this.getStorageKey(siteUrl);
        await this.secretStorage.delete(key);
        this.debugLogger.info(`🗑️ Deleted token for ${siteUrl}`);
    }

    async clearToken(siteUrl: string): Promise<void> {
        await this.deleteToken(siteUrl);
    }

    // ── Multi-site registry ───────────────────────────────────────────

    getRegisteredSites(): RegisteredSite[] {
        return this.globalState.get<RegisteredSite[]>(REGISTRY_KEY, []);
    }

    async registerSite(url: string, name?: string, localDevPath?: string): Promise<void> {
        const cleanUrl = url.replace(/\/$/, '');
        const sites = this.getRegisteredSites();

        const existing = sites.find(s => this.normalizeUrl(s.url) === this.normalizeUrl(cleanUrl));
        if (existing) {
            if (name) { existing.name = name; }
            if (localDevPath) { existing.localDevPath = localDevPath; }
            await this.globalState.update(REGISTRY_KEY, sites);
            this.debugLogger.log(`📝 Updated registered site: ${cleanUrl}`);
            return;
        }

        const siteName = name || (() => {
            try { return new URL(cleanUrl).hostname; } catch { return cleanUrl; }
        })();

        sites.push({ url: cleanUrl, name: siteName, localDevPath, addedAt: Date.now() });
        await this.globalState.update(REGISTRY_KEY, sites);
        this.debugLogger.info(`📌 Registered site: ${siteName} (${cleanUrl})`);
    }

    async unregisterSite(url: string): Promise<void> {
        const cleanUrl = url.replace(/\/$/, '');
        let sites = this.getRegisteredSites();
        const before = sites.length;
        sites = sites.filter(s => this.normalizeUrl(s.url) !== this.normalizeUrl(cleanUrl));
        await this.globalState.update(REGISTRY_KEY, sites);

        if (sites.length < before) {
            await this.deleteToken(cleanUrl);
            this.debugLogger.info(`🗑️ Unregistered site: ${cleanUrl}`);
        }
    }

    async updateSiteDevPath(url: string, localDevPath: string): Promise<void> {
        const cleanUrl = url.replace(/\/$/, '');
        const sites = this.getRegisteredSites();
        const site = sites.find(s => this.normalizeUrl(s.url) === this.normalizeUrl(cleanUrl));
        if (site) {
            site.localDevPath = localDevPath;
            await this.globalState.update(REGISTRY_KEY, sites);
        }
    }

    /**
     * Check which registered sites have a saved token.
     */
    async getSitesWithTokens(): Promise<Array<RegisteredSite & { hasToken: boolean }>> {
        const sites = this.getRegisteredSites();
        const results: Array<RegisteredSite & { hasToken: boolean }> = [];

        for (const site of sites) {
            const token = await this.secretStorage.get(this.getStorageKey(site.url));
            results.push({ ...site, hasToken: !!token });
        }

        return results;
    }

    // ── Helpers ────────────────────────────────────────────────────────

    private getStorageKey(siteUrl: string): string {
        return `skylit.token.${this.normalizeUrl(siteUrl)}`;
    }

    private normalizeUrl(url: string): string {
        return url
            .replace(/^https?:\/\//, '')
            .replace(/\/$/, '')
            .toLowerCase();
    }
}
